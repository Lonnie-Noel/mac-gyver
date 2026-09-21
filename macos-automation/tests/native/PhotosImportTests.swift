// Concatenated after PhotosImport.swift by photos-import.test.mjs so private
// validation/storage functions can be tested without exposing production APIs.
// Never instantiates PhotosImport or calls PhotoKit/library/permission APIs.
@main
struct PhotosImportTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let context = CGContext(data: nil, width: 3, height: 2, bitsPerComponent: 8,
            bytesPerRow: 12, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: 0.8, green: 0.2, blue: 0.1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 3, height: 2))
        let image = context.makeImage()!
        func encoded(_ type: UTType, count: Int = 1) -> Data {
            let data = NSMutableData()
            let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, count, nil)!
            for _ in 0..<count { CGImageDestinationAddImage(destination, image, nil) }
            precondition(CGImageDestinationFinalize(destination))
            return data as Data
        }
        let jpeg = encoded(.jpeg)
        let source = root.appendingPathComponent("사진 원본.jpg")
        try jpeg.write(to: source)
        let sourceHash = SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined()
        let runID = UUID().uuidString
        let valid: [String: Any] = ["runID": runID, "albumName": "MacGyver 오프라인 검사",
            "path": source.path, "filename": source.lastPathComponent,
            "sha256": sourceHash, "bytes": jpeg.count]
        let input = try importInput(valid)
        precondition(input.data == jpeg && input.runID == runID && input.filename == source.lastPathComponent)
        try validateImportImage(encoded(.png), extension: "png")
        try validateImportImage(encoded(.tiff), extension: "tiff")

        var rejectionCount = 0
        func mustReject(_ name: String, _ body: () throws -> Void) {
            do { try body(); fatalError("Unexpectedly accepted \(name)") }
            catch { rejectionCount += 1 }
        }
        for (key, value) in [("runID", "invalid" as Any), ("albumName", "Other"),
            ("filename", "other.jpg"), ("sha256", String(repeating: "0", count: 64)),
            ("bytes", jpeg.count + 1), ("bytes", true)] {
            var invalid = valid; invalid[key] = value
            mustReject(key) { _ = try importInput(invalid) }
        }
        let link = root.appendingPathComponent("link.jpg")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
        var invalid = valid; invalid["path"] = link.path; invalid["filename"] = link.lastPathComponent
        mustReject("source symlink") { _ = try importInput(invalid) }
        let directory = root.appendingPathComponent("directory.jpg")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        invalid["path"] = directory.path; invalid["filename"] = directory.lastPathComponent
        mustReject("source directory") { _ = try importInput(invalid) }
        let pipe = root.appendingPathComponent("pipe.jpg")
        precondition(mkfifo(pipe.path, mode_t(0o600)) == 0)
        invalid["path"] = pipe.path; invalid["filename"] = pipe.lastPathComponent
        mustReject("source FIFO without blocking") { _ = try importInput(invalid) }
        mustReject("wrong format") { try validateImportImage(jpeg, extension: "png") }
        mustReject("truncated image") { try validateImportImage(jpeg.prefix(jpeg.count / 2), extension: "jpg") }
        mustReject("multiple TIFF images") { try validateImportImage(encoded(.tiff, count: 2), extension: "tiff") }

        let store = ImportLedgerStore(directory: root.appendingPathComponent("state"), runID: runID)
        let empty = try store.load(); precondition(empty == nil)
        var ledger = ImportLedger(runID: runID, albumName: "MacGyver 오프라인 검사")
        ledger.entries[source.path] = ImportEntry(path: source.path, filename: source.lastPathComponent,
            sha256: sourceHash, bytes: jpeg.count, state: "pending")
        try store.save(ledger, exclusive: true)
        let persisted = try store.load()!
        precondition(persisted.entries[source.path]?.state == "pending")
        precondition(persisted.entries[source.path]?.sha256 == sourceHash)
        precondition(persisted.albumID == nil && persisted.entries[source.path]?.assetID == nil)
        mustReject("overwriting an existing run") { try store.save(ledger, exclusive: true) }
        ledger.albumID = "offline-album-id"
        ledger.entries[source.path]?.assetID = "offline-asset-id"
        try store.save(ledger)
        let identified = try store.load()!
        precondition(identified.albumID == "offline-album-id")
        precondition(identified.entries[source.path]?.assetID == "offline-asset-id")
        precondition(identified.entries[source.path]?.state == "pending")
        let permissions = try FileManager.default.attributesOfItem(atPath: store.url.path)[.posixPermissions] as! NSNumber
        precondition(permissions.intValue == 0o600)
        let outside = root.appendingPathComponent("outside.json")
        try Data("{}".utf8).write(to: outside)
        try FileManager.default.removeItem(at: store.url)
        try FileManager.default.createSymbolicLink(at: store.url, withDestinationURL: outside)
        mustReject("reading a symlink ledger") { _ = try store.load() }
        mustReject("replacing a symlink ledger") { try store.save(ledger) }
        let originalAfterTests = try Data(contentsOf: source)
        precondition(originalAfterTests == jpeg)
        precondition(rejectionCount == 15)
        print("PhotosImport regression checks passed: source validation, 15 rejection cases, durable pending IDs; no PhotoKit calls")
    }
}
