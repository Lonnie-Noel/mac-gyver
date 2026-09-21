import AppKit

private struct PhotosScriptFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

/// Only reads Photos objects and shows an exact media item. No edit/export/delete commands.
@MainActor
enum PhotosScripting {
    static func handle(_ action: String, args: [String: Any]) throws -> [String: Any] {
        switch action {
        case "activate":
            _ = try run("activate\nreturn true")
            return ["activated": true]
        case "selection":
            return ["items": try selectedItems(run("return selection"))]
        case "albums":
            let result = try run("""
                set rows to {}
                repeat with candidateReference in (get albums)
                    set candidate to contents of candidateReference
                    set end of rows to {(get id of candidate) as text, (get name of candidate) as text, false}
                end repeat
                set favoriteAlbum to favorites album
                set end of rows to {(id of favoriteAlbum) as text, (name of favoriteAlbum) as text, true}
                return rows
                """)
            var order: [String] = []
            var byID: [String: [String: Any]] = [:]
            for row in try list(result) {
                let fields = try list(row)
                guard fields.count == 3 else { throw PhotosScriptFailure("앨범 응답 형식이 잘못되었습니다.") }
                let id = try text(fields[0])
                if byID[id] == nil { order.append(id) }
                byID[id] = ["id": id, "name": try text(fields[1]), "builtin": fields[2].booleanValue]
            }
            return ["albums": order.compactMap { byID[$0] }]
        case "albumItems":
            let id = try identifier(args)
            let result = try run("""
                set wantedID to \(quoted(id))
                set targetAlbum to missing value
                repeat with candidateReference in (get albums)
                    set candidate to contents of candidateReference
                    if (get id of candidate) as text is wantedID then
                        set targetAlbum to candidate
                        exit repeat
                    end if
                end repeat
                if targetAlbum is missing value then
                    set candidate to favorites album
                    if (id of candidate) as text is wantedID then set targetAlbum to candidate
                end if
                if targetAlbum is missing value then error "요청한 앨범 ID를 찾을 수 없습니다."
                return {(id of targetAlbum) as text, (name of targetAlbum) as text, my packedItems((get media items of targetAlbum))}
                """)
            let fields = try list(result)
            guard fields.count == 3, try text(fields[0]) == id else {
                throw PhotosScriptFailure("조회된 앨범 ID가 요청과 다릅니다.")
            }
            return ["id": id, "name": try text(fields[1]), "items": try mediaRows(fields[2])]
        case "show":
            let id = try identifier(args)
            let result = try run("""
                set wantedID to \(quoted(id))
                set targetItem to media item id wantedID
                if (id of targetItem) as text is not wantedID then error "다른 사진 ID입니다."
                activate
                spotlight targetItem
                return selection
                """)
            let items = try selectedItems(result)
            // spotlight may return before the selection animation completes.
            // The caller must poll selection until exactly this ID is selected.
            return ["id": id, "items": items,
                    "selected": items.count == 1 && items[0]["id"] as? String == id]
        default:
            throw PhotosScriptFailure("지원하지 않는 Photos 스크립트 동작: \(action)")
        }
    }

    // Photos may return a selection object whose container is an internal smart
    // album that AppleScript cannot resolve (-1728). The selection descriptor
    // already carries the exact unique asset ID. Read that literal field without
    // evaluating its container, then resolve the asset at the library root.
    // Reject name/index/range references rather than guessing another photo.
    private static func selectedIDs(_ descriptor: NSAppleEventDescriptor) throws -> [String] {
        let mediaItemClass: OSType = 0x49506d69 // 'IPmi', Photos.sdef media item
        let literalTextTypes: Set<DescType> = [typeUnicodeText, typeUTF8Text, typeChar]
        var seen = Set<String>()
        return try list(descriptor).map { reference in
            guard reference.descriptorType == typeObjectSpecifier,
                  let desiredClass = reference.forKeyword(AEKeyword(keyAEDesiredClass)),
                  desiredClass.descriptorType == typeType,
                  desiredClass.typeCodeValue == mediaItemClass,
                  let form = reference.forKeyword(AEKeyword(keyAEKeyForm)),
                  form.descriptorType == typeEnumerated, form.enumCodeValue == formUniqueID,
                  let key = reference.forKeyword(AEKeyword(keyAEKeyData)),
                  literalTextTypes.contains(key.descriptorType),
                  let value = key.stringValue else {
                throw PhotosScriptFailure("선택된 사진의 정확한 ID 참조를 확인할 수 없습니다.")
            }
            let id = try identifier(["id": value])
            guard seen.insert(id).inserted else {
                throw PhotosScriptFailure("선택된 사진 ID가 중복되어 있습니다.")
            }
            return id
        }
    }

    private static func selectedItems(_ descriptor: NSAppleEventDescriptor) throws -> [[String: Any]] {
        let ids = try selectedIDs(descriptor)
        guard !ids.isEmpty else { return [] }
        let idList = ids.map(quoted).joined(separator: ", ")
        let result = try run("""
            set rows to {}
            repeat with idReference in {\(idList)}
                set wantedID to contents of idReference
                set targetItem to media item id wantedID
                if (get id of targetItem) as text is not wantedID then error "다른 사진 ID입니다."
                set itemRows to my packedItems({targetItem})
                set end of rows to item 1 of itemRows
            end repeat
            return rows
            """)
        let items = try mediaRows(result)
        guard items.count == ids.count,
              zip(items, ids).allSatisfy({ $0.0["id"] as? String == $0.1 }) else {
            throw PhotosScriptFailure("선택된 사진 ID와 조회된 사진 ID가 다릅니다.")
        }
        return items
    }

    // A repeat-with-in variable is a reference to item N of the local list, not
    // the Photos object itself. Dereference before asking Photos for properties;
    // selection can contain album-scoped objects and the extra list reference
    // otherwise reaches Photos as an unresolvable property specifier (-1700).
    private static let packedItemsHandler = """
            on packedItems(theItems)
                set rows to {}
                tell application id "com.apple.Photos"
                    repeat with photoReference in theItems
                        set photoItem to contents of photoReference
                        set photoID to (get id of photoItem) as text
                        set photoFilename to (get filename of photoItem) as text
                        set photoWidth to (get width of photoItem)
                        set photoHeight to (get height of photoItem)
                        set end of rows to {photoID, photoFilename, photoWidth, photoHeight}
                    end repeat
                end tell
                return rows
            end packedItems
            """

    private static func run(_ body: String) throws -> NSAppleEventDescriptor {
        let source = """
            \(packedItemsHandler)
            with timeout of 30 seconds
                tell application id "com.apple.Photos"
                    \(body)
                end tell
            end timeout
            """
        guard let script = NSAppleScript(source: source) else { throw PhotosScriptFailure("Photos 스크립트를 만들지 못했습니다.") }
        var error: NSDictionary?
        let result = script.executeAndReturnError(&error)
        if let error {
            let code = error[NSAppleScript.errorNumber] ?? "unknown"
            let message = error[NSAppleScript.errorMessage] as? String ?? "Photos 자동화 오류"
            throw PhotosScriptFailure("Photos AppleScript (\(code)): \(message)")
        }
        return result
    }

    private static func identifier(_ args: [String: Any]) throws -> String {
        guard let id = args["id"] as? String, !id.isEmpty, id.utf8.count <= 1024,
              id.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
            throw PhotosScriptFailure("유효한 Photos 항목 ID가 필요합니다.")
        }
        return id
    }
    private static func quoted(_ value: String) -> String {
        "\"" + value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
    private static func list(_ descriptor: NSAppleEventDescriptor) throws -> [NSAppleEventDescriptor] {
        guard descriptor.descriptorType == typeAEList else { throw PhotosScriptFailure("Photos 응답이 목록이 아닙니다.") }
        if descriptor.numberOfItems == 0 { return [] }
        return try (1...descriptor.numberOfItems).map {
            guard let value = descriptor.atIndex($0) else { throw PhotosScriptFailure("Photos 목록 항목이 없습니다.") }
            return value
        }
    }
    private static func text(_ descriptor: NSAppleEventDescriptor) throws -> String {
        guard let value = descriptor.stringValue, !value.isEmpty else { throw PhotosScriptFailure("Photos 식별 문자열이 없습니다.") }
        return value
    }
    private static func mediaRows(_ descriptor: NSAppleEventDescriptor) throws -> [[String: Any]] {
        try list(descriptor).map { row in
            let fields = try list(row)
            guard fields.count == 4 else { throw PhotosScriptFailure("Photos 사진 응답 형식이 잘못되었습니다.") }
            let width = Int(fields[2].int32Value), height = Int(fields[3].int32Value)
            guard width > 0, height > 0 else { throw PhotosScriptFailure("Photos 항목의 이미지 크기가 유효하지 않습니다.") }
            return ["id": try text(fields[0]), "filename": try text(fields[1]), "width": width, "height": height]
        }
    }
}
