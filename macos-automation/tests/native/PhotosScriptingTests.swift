// Concatenated with PhotosScripting.swift to test the actual packing handler and
// descriptor decoder. Replaces the runtime Photos tell with terminology only:
// all property reads operate on in-memory records, never the Photos library.
// This does not simulate Photos' object-specifier implementation; a live test
// is still required to verify album-scoped selection references on each OS.
extension PhotosScripting {
    fileprivate static func offlineRows(_ expression: String) throws -> [[String: Any]] {
        let handler = packedItemsHandler
            .replacingOccurrences(of: "tell application id \"com.apple.Photos\"",
                with: "using terms from application id \"com.apple.Photos\"")
            .replacingOccurrences(of: "end tell", with: "end using terms from")
        let source = """
            \(handler)
            using terms from application id "com.apple.Photos"
                \(expression)
            end using terms from
            """
        let script = NSAppleScript(source: source)!
        var error: NSDictionary?
        let result = script.executeAndReturnError(&error)
        if let error { throw PhotosScriptFailure("Offline fixture: \(error)") }
        return try mediaRows(result)
    }

    fileprivate static func roundTripQuoted(_ value: String) throws -> String {
        let script = NSAppleScript(source: "return \(quoted(value))")!
        var error: NSDictionary?
        let descriptor = script.executeAndReturnError(&error)
        if let error { throw PhotosScriptFailure("Quoted fixture: \(error)") }
        return try text(descriptor)
    }

    fileprivate static func offlineSelectedIDs(_ descriptor: NSAppleEventDescriptor) throws -> [String] {
        try selectedIDs(descriptor)
    }
}

@main
struct PhotosScriptingTests {
    @MainActor static func main() throws {
        let firstID = "422695C9-A065-4B0F-91C8-0732B7D961CA/L0/001"
        let secondID = "422695C9-A065-4B0F-91C8-0732B7D961CB/L0/001"
        let rows = try PhotosScripting.offlineRows("""
            set fixtures to {{id:"\(firstID)", filename:"같은, 사진.jpg", width:4032, height:3024}, ¬
                {id:"\(secondID)", filename:"같은, 사진.jpg", width:3024, height:4032}}
            set fixtureReference to a reference to fixtures
            return my packedItems(fixtureReference)
            """)
        precondition(rows.count == 2)
        precondition(rows[0]["id"] as? String == firstID)
        precondition(rows[1]["id"] as? String == secondID)
        precondition(rows[0]["filename"] as? String == "같은, 사진.jpg")
        precondition(rows[1]["filename"] as? String == "같은, 사진.jpg")
        precondition(rows[0]["width"] as? Int == 4032 && rows[0]["height"] as? Int == 3024)
        precondition(rows[1]["width"] as? Int == 3024 && rows[1]["height"] as? Int == 4032)
        let empty = try PhotosScripting.offlineRows("return my packedItems({})")
        precondition(empty.isEmpty)

        var rejected = 0
        for expression in [
            "return \"not a list\"",
            "return {{\"id\", \"file.jpg\", 100}}",
            "return {{\"\", \"file.jpg\", 100, 100}}",
            "return {{\"id\", \"\", 100, 100}}",
            "return {{\"id\", \"file.jpg\", 0, 100}}",
            "return {{\"id\", \"file.jpg\", 100, -1}}",
        ] {
            do { _ = try PhotosScripting.offlineRows(expression); fatalError("Accepted malformed row") }
            catch { rejected += 1 }
        }
        precondition(rejected == 6)
        for value in ["id/with/suffix", "quote\"and\\slash", "사진 ID"] {
            let actual = try PhotosScripting.roundTripQuoted(value)
            precondition(actual == value)
        }
        for action in ["show", "albumItems"] {
            for id in ["", "invalid\nID", String(repeating: "x", count: 1025)] {
                do { _ = try PhotosScripting.handle(action, args: ["id": id]); fatalError("Accepted invalid ID") }
                catch { precondition(error.localizedDescription.contains("유효한 Photos 항목 ID")) }
            }
        }
        try checkSelectionDescriptors(firstID: firstID, secondID: secondID)
        print("PhotosScripting checks passed: exact IDs, duplicate filenames, list references, typed response validation, album-scoped selection descriptors; no Photos events")
    }

    @MainActor private static func checkSelectionDescriptors(firstID: String, secondID: String) throws {
        // A structurally valid Photos reference to an unresolvable internal
        // album. Parsing must read seld literally and never evaluate `from`.
        func object(_ id: NSAppleEventDescriptor, desiredClass: OSType = 0x49506d69,
            form: OSType = OSType(formUniqueID), container: NSAppleEventDescriptor = .null()) -> NSAppleEventDescriptor {
            let record = NSAppleEventDescriptor.record()
            record.setDescriptor(NSAppleEventDescriptor(typeCode: desiredClass), forKeyword: AEKeyword(keyAEDesiredClass))
            record.setDescriptor(NSAppleEventDescriptor(enumCode: form), forKeyword: AEKeyword(keyAEKeyForm))
            record.setDescriptor(id, forKeyword: AEKeyword(keyAEKeyData))
            record.setDescriptor(container, forKeyword: AEKeyword(keyAEContainer))
            return record.coerce(toDescriptorType: DescType(typeObjectSpecifier))!
        }
        func selection(_ items: [NSAppleEventDescriptor]) -> NSAppleEventDescriptor {
            let list = NSAppleEventDescriptor.list()
            for (index, item) in items.enumerated() { list.insert(item, at: index + 1) }
            return list
        }
        let inaccessibleAlbum = object(NSAppleEventDescriptor(string: "internal-album/L0/040"), desiredClass: 0x4950616c)
        let first = object(NSAppleEventDescriptor(string: firstID), container: inaccessibleAlbum)
        let second = object(NSAppleEventDescriptor(string: secondID))
        let actual = try PhotosScripting.offlineSelectedIDs(selection([first, second]))
        precondition(actual == [firstID, secondID])
        let empty = try PhotosScripting.offlineSelectedIDs(selection([]))
        precondition(empty.isEmpty)

        let malformed: [NSAppleEventDescriptor] = [
            NSAppleEventDescriptor(string: firstID),
            selection([NSAppleEventDescriptor(string: firstID)]),
            selection([NSAppleEventDescriptor.record()]),
            selection([inaccessibleAlbum]),
            selection([object(NSAppleEventDescriptor(string: firstID), form: OSType(formName))]),
            selection([object(NSAppleEventDescriptor(int32: 1), form: OSType(formAbsolutePosition))]),
            selection([object(NSAppleEventDescriptor(int32: 123))]),
            selection([object(first)]),
            selection([object(NSAppleEventDescriptor(string: ""))]),
            selection([object(NSAppleEventDescriptor(string: "unsafe\nID"))]),
            selection([object(NSAppleEventDescriptor(string: String(repeating: "x", count: 1025)))]),
            selection([first, first]),
        ]
        for descriptor in malformed {
            do { _ = try PhotosScripting.offlineSelectedIDs(descriptor); fatalError("Accepted ambiguous selection reference") }
            catch {}
        }
    }
}
