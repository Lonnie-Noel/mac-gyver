// Concatenated after PhotosMedia.swift. Uses synthetic JPEGs and local ledgers;
// never sends PhotoKit requests, asks for permission, or changes Photos assets.
@main
struct PhotosMediaRetentionTests {
    static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let context = CGContext(data: nil, width: 3, height: 2, bitsPerComponent: 8,
            bytesPerRow: 12, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: 0.3, green: 0.4, blue: 0.5, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 3, height: 2))
        let bytes = NSMutableData()
        let destination = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        precondition(CGImageDestinationFinalize(destination))
        let jpeg = bytes as Data
        let output = root.appendingPathComponent("retained-result.jpg")
        try jpeg.write(to: output)
        let hash = SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined()
        let current = String(repeating: "c", count: 64)
        let original = String(repeating: "a", count: 64)
        let initial = String(repeating: "b", count: 64)
        let legacyJSON: [String: Any] = ["originalFilename": "source.jpg", "originalSHA256": original,
            "initialCurrentSHA256": initial, "exportPath": output.path, "exportSHA256": hash,
            "exportedCurrentSHA256": current, "exportBytes": jpeg.count, "exportWidth": 3,
            "exportHeight": 2, "revertRequested": false, "restored": false]
        let legacy = try JSONDecoder().decode(MacPhotoBaseline.self,
            from: JSONSerialization.data(withJSONObject: legacyJSON))
        precondition(legacy.retained == nil && legacy.hasUnfinishedExport)
        try legacy.requireRevertAllowed()
        let media = PhotosMedia(stateDirectory: root.appendingPathComponent("state"))
        let verification = try legacy.retentionVerification(path: output.path, verifiedHash: hash)
        let verified = try await media.handle("verifyJPEG", args: verification)
        precondition(verified["sha256"] as? String == hash)
        precondition(verified["width"] as? Int == 3 && verified["height"] as? Int == 2)

        let completed = try legacy.retaining(currentSHA256: current)
        precondition(completed.retained == true && !completed.restored && !completed.revertRequested)
        precondition(!completed.hasUnfinishedExport)
        // Save/load the actual private native ledger implementation, including
        // its atomic rename and fsync, then prove terminal policy survives.
        try await media.offlineSaveLedger(["fixture-asset": completed])
        let persisted = try await media.offlineLoadLedger()["fixture-asset"]!
        precondition(persisted.retained == true && !persisted.hasUnfinishedExport)
        precondition(persisted.exportPath == output.path && persisted.exportSHA256 == hash)
        _ = try persisted.retentionVerification(path: output.path, verifiedHash: hash)
        let repeated = try persisted.retaining(currentSHA256: current)
        precondition(repeated.retained == true && !repeated.restored)

        var rejected = 0
        func reject(_ operation: () throws -> Void) {
            do { try operation(); fatalError("invalid retention transition accepted") }
            catch { rejected += 1 }
        }
        reject { try persisted.requireRevertAllowed() }
        reject { _ = try legacy.retentionVerification(path: output.path + ".other", verifiedHash: hash) }
        reject { _ = try legacy.retentionVerification(path: output.path, verifiedHash: String(repeating: "0", count: 64)) }
        reject { _ = try legacy.retaining(currentSHA256: String(repeating: "d", count: 64)) }
        var reverting = legacy; reverting.revertRequested = true
        reject { _ = try reverting.retentionVerification(path: output.path, verifiedHash: hash) }
        reject { _ = try reverting.retaining(currentSHA256: current) }
        var restored = legacy; restored.restored = true
        precondition(!restored.hasUnfinishedExport)
        reject { _ = try restored.retentionVerification(path: output.path, verifiedHash: hash) }
        var missingMetadata = legacy; missingMetadata.exportWidth = nil
        reject { _ = try missingMetadata.retentionVerification(path: output.path, verifiedHash: hash) }
        var malformedCurrent = legacy; malformedCurrent.exportedCurrentSHA256 = "not-a-hash"
        reject { _ = try malformedCurrent.retentionVerification(path: output.path, verifiedHash: hash) }
        precondition(rejected == 9)

        // The real JPEG validator must reject a file replaced after export;
        // header presence alone is not sufficient for terminal completion.
        var corrupt = jpeg; corrupt[10] ^= 255
        try corrupt.write(to: output)
        do {
            _ = try await media.handle("verifyJPEG", args: verification)
            fatalError("corrupted retained JPEG accepted")
        } catch {}
        try jpeg.write(to: output)
        var wrongDimensions = verification; wrongDimensions["width"] = 4
        do {
            _ = try await media.handle("verifyJPEG", args: wrongDimensions)
            fatalError("wrong retained JPEG dimensions accepted")
        } catch {}
        let empty = MacPhotoBaseline(originalFilename: "source.jpg", originalSHA256: original,
            initialCurrentSHA256: initial)
        precondition(!empty.hasUnfinishedExport)
        print("PhotosMedia retention checks passed: legacy ledger decoding, verified JPEG, durable terminal state, idempotent retention, revert rejection, changed hash/file/dimensions rejection; no PhotoKit calls")
    }
}

private extension PhotosMedia {
    func offlineSaveLedger(_ entries: [String: MacPhotoBaseline]) throws { try saveLedger(entries) }
    func offlineLoadLedger() throws -> [String: MacPhotoBaseline] { try loadLedger() }
}
