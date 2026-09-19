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
            return ["items": try mediaRows(run("return my packedItems(selection)"))]
        case "albums":
            let result = try run("""
                set rows to {}
                repeat with candidate in albums
                    set end of rows to {(id of candidate) as text, (name of candidate) as text, false}
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
                repeat with candidate in albums
                    if (id of candidate) as text is wantedID then
                        set targetAlbum to contents of candidate
                        exit repeat
                    end if
                end repeat
                if targetAlbum is missing value then
                    set candidate to favorites album
                    if (id of candidate) as text is wantedID then set targetAlbum to candidate
                end if
                if targetAlbum is missing value then error "요청한 앨범 ID를 찾을 수 없습니다."
                return {(id of targetAlbum) as text, (name of targetAlbum) as text, my packedItems(media items of targetAlbum)}
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
                return my packedItems(selection)
                """)
            let items = try mediaRows(result)
            // spotlight may return before the selection animation completes.
            // The caller must poll selection until exactly this ID is selected.
            return ["id": id, "items": items,
                    "selected": items.count == 1 && items[0]["id"] as? String == id]
        default:
            throw PhotosScriptFailure("지원하지 않는 Photos 스크립트 동작: \(action)")
        }
    }

    private static func run(_ body: String) throws -> NSAppleEventDescriptor {
        let source = """
            on packedItems(theItems)
                set rows to {}
                tell application id "com.apple.Photos"
                    repeat with photoItem in theItems
                        set end of rows to {(id of photoItem) as text, (filename of photoItem) as text, width of photoItem, height of photoItem}
                    end repeat
                end tell
                return rows
            end packedItems
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
