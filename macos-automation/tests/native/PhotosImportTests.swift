// Concatenated after PhotosImport.swift by photos-import.test.mjs so private
// validation/storage functions can be tested without exposing production APIs.
// Never instantiates PhotosImport or calls PhotoKit/library/permission APIs.
@main
struct PhotosImportTests {
    static func main() async throws {
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
            let metadata: CFDictionary? = type == .jpeg ? [
                kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "MacGyver preserve original metadata"],
                kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFSoftware: "MacGyver offline fixture"]
            ] as CFDictionary : nil
            for _ in 0..<count { CGImageDestinationAddImage(destination, image, metadata) }
            precondition(CGImageDestinationFinalize(destination))
            return data as Data
        }
        let cloneSource: [[String: Any]] = [["id": "source", "filename": "photo.jpg", "sha256": "abc"]]
        let goodClone: [[String: Any]] = [["item": ["id": "copy", "filename": "photo.jpg"], "sourceSHA256": "abc"]]
        try validateCloneReceipt(sourceItems: cloneSource, imports: goodClone)
        for invalid: [[String: Any]] in [[], [["item": ["id": "source", "filename": "photo.jpg"], "sourceSHA256": "abc"]], [["item": ["id": "copy", "filename": "other.jpg"], "sourceSHA256": "abc"]], [["item": ["id": "copy", "filename": "photo.jpg"], "sourceSHA256": "wrong"]]] {
            do { try validateCloneReceipt(sourceItems: cloneSource, imports: invalid); fatalError("invalid clone accepted") }
            catch { precondition(error is PhotosImportFailure) }
        }
        precondition(validImportAlbumName("Reframe-20260921-153000-123"))
        precondition(!validImportAlbumName("Reframe"))
        precondition(!validImportAlbumName("Reframe-other"))
        let cloneBytes: Data = try await withCheckedThrowingContinuation { continuation in
            let completion = CloneResourceCompletion(continuation)
            completion.receive(Data([1, 2])); completion.receive(Data([3])); completion.complete(nil); completion.complete(nil)
        }
        precondition(cloneBytes == Data([1, 2, 3]))
        for variant in ["empty", "network", "timeout"] {
            do {
                let _: Data = try await withCheckedThrowingContinuation { continuation in
                    let completion = CloneResourceCompletion(continuation)
                    if variant == "timeout" { precondition(completion.expire()); precondition(!completion.expire()); completion.receive(Data([4])); completion.complete(nil) }
                    else { completion.complete(variant == "network" ? NSError(domain: "clone", code: 1) : nil) }
                }
                fatalError("invalid clone stream accepted")
            } catch {}
        }
        print("Independent clone IDs, byte receipts and bounded source streams validated")
        let jpeg = encoded(.jpeg)
        let metadataSource = CGImageSourceCreateWithData(jpeg as CFData, nil)!
        let metadata = CGImageSourceCopyPropertiesAtIndex(metadataSource, 0, nil) as! [CFString: Any]
        let exif = metadata[kCGImagePropertyExifDictionary] as! [CFString: Any]
        precondition(exif[kCGImagePropertyExifUserComment] as? String == "MacGyver preserve original metadata")
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
        try await checkStaging(input, parent: root.appendingPathComponent("staging-tests"))
        try await checkBatchStaging(valid, data: jpeg, root: root.appendingPathComponent("batch-tests"))
        try await checkResourceStreams()
        let originalAfterTests = try Data(contentsOf: source)
        precondition(originalAfterTests == jpeg)
        precondition(rejectionCount == 15)
        print("PhotosImport regression checks passed: source validation, 15 rejection cases, durable pending IDs, private byte-identical staging and scoped cleanup, ordered batch staging and durable complete ID set, partial batch cleanup and uncertain replay rejection, resource stream completion and rejection; no PhotoKit calls")
    }
}

private func checkBatchStaging(_ valid: [String: Any], data: Data, root: URL) async throws {
    let manager = FileManager.default
    try manager.createDirectory(at: root, withIntermediateDirectories: true)
    let second = root.appendingPathComponent("B-second.jpg")
    try data.write(to: second)
    var secondArgs = valid
    secondArgs["path"] = second.path; secondArgs["filename"] = second.lastPathComponent
    let originalPath = valid["path"] as! String
    let runID = UUID().uuidString
    let batch: [String: Any] = ["runID": runID, "albumName": "MacGyver batch offline",
        // Deliberately preserve caller order, without sorting paths or IDs.
        "files": [secondArgs, valid]]
    let state = root.appendingPathComponent("state")
    let store = ImportLedgerStore(directory: state, runID: runID)
    var stageURLs: [URL] = []
    let received = try await withStagedImportBatch(batch, directory: state) { intent, stages in
        precondition(intent.orderedPaths == [second.path, originalPath])
        precondition(intent.entries.count == 2 && stages.count == 2)
        precondition(stages.map { $0.url.lastPathComponent } == [second.lastPathComponent, valid["filename"] as! String])
        stageURLs = stages.map(\.url)
        for stage in stages { try requireSameData(stage.url, data) }
        try store.save(intent, exclusive: true)
        let pending = try store.load()!
        precondition(pending.orderedPaths == intent.orderedPaths)
        precondition(pending.entries.values.allSatisfy { $0.state == "pending" && $0.assetID == nil })
        let ids = ["Z-batch-photo", "A-batch-photo"]
        let identified = try identifiedBatchLedger(intent, albumID: "batch-album", assetIDs: ids)
        try store.save(identified)
        let persisted = try store.load()!
        precondition(persisted.albumID == "batch-album")
        precondition(persisted.orderedPaths!.map { persisted.entries[$0]!.assetID! } == ids)
        precondition(persisted.entries.values.allSatisfy { $0.state == "pending" })
        func reject(_ operation: () throws -> Void) {
            do { try operation(); fatalError("invalid batch record accepted") }
            catch {}
        }
        reject { try validateExistingBatchLedger(persisted, requested: intent) }
        reject { _ = try identifiedBatchLedger(intent, albumID: "batch-album", assetIDs: ["only-one"]) }
        reject { _ = try identifiedBatchLedger(intent, albumID: "batch-album", assetIDs: ["same", "same"]) }
        reject { _ = try identifiedBatchLedger(intent, albumID: "", assetIDs: ids) }
        reject { _ = try identifiedBatchLedger(identified, albumID: "batch-album", assetIDs: ids) }
        var completed = persisted
        for path in completed.orderedPaths! {
            completed.entries[path]?.state = "complete"
            completed.entries[path]?.width = 3
            completed.entries[path]?.height = 2
        }
        try validateExistingBatchLedger(completed, requested: intent)
        var changed = intent; changed.orderedPaths!.reverse()
        reject { try validateExistingBatchLedger(completed, requested: changed) }
        changed = intent; changed.entries[second.path]?.sha256 = String(repeating: "0", count: 64)
        reject { try validateExistingBatchLedger(completed, requested: changed) }
        changed = intent; changed.entries.removeValue(forKey: second.path)
        reject { try validateExistingBatchLedger(completed, requested: changed) }
        var legacy = completed; legacy.orderedPaths = nil
        reject { try validateExistingBatchLedger(legacy, requested: intent) }
        await Task.yield()
        for stage in stages { try requireSameData(stage.url, data) }
        return ids
    }
    precondition(received == ["Z-batch-photo", "A-batch-photo"])
    precondition(stageURLs.allSatisfy { !manager.fileExists(atPath: $0.path) })
    let afterScope = try store.load()!
    precondition(afterScope.entries.values.allSatisfy { $0.state == "pending" })

    // A later source failing validation must remove earlier stages and must
    // never enter the transaction/ledger-writing operation.
    var badSource = valid; badSource["sha256"] = String(repeating: "0", count: 64)
    for files in [[], [valid, valid], [secondArgs, badSource], [secondArgs, ["path": "relative.jpg"]]] {
        var invalid = batch; invalid["files"] = files
        do {
            try await withStagedImportBatch(invalid, directory: state) { _, _ in
                fatalError("invalid batch entered transaction scope")
            }
            fatalError("invalid batch accepted")
        } catch {}
        let remaining = try manager.contentsOfDirectory(atPath: state.path)
        precondition(remaining.filter { $0.hasPrefix(".import-stage-") }.isEmpty)
    }
    do {
        try await withStagedImportBatch(batch, directory: state) { _, stages in
            stageURLs = stages.map(\.url)
            await Task.yield()
            for stage in stages { try requireSameData(stage.url, data) }
            throw NSError(domain: "BatchTransactionTest", code: 42)
        }
        fatalError("failed batch transaction returned")
    } catch {
        precondition((error as NSError).domain == "BatchTransactionTest")
    }
    precondition(stageURLs.allSatisfy { !manager.fileExists(atPath: $0.path) })
    let retained = try store.load()!
    precondition(retained.albumID == "batch-album" && retained.entries.count == 2)
    try requireSameData(second, data)
    try requireSameData(URL(fileURLWithPath: originalPath), data)
}

private func checkStaging(_ input: ImportInput, parent: URL) async throws {
    let manager = FileManager.default
    var completedDirectory: URL?
    let result = try await withStagedImportFile(data: input.data, filename: input.filename,
        directory: parent) { stagedURL in
        let stagedDirectory = stagedURL.deletingLastPathComponent()
        completedDirectory = stagedDirectory
        precondition(stagedURL != input.url && stagedURL.lastPathComponent == input.filename)
        try requireSameData(stagedURL, input.data)
        let directoryAttributes = try manager.attributesOfItem(atPath: stagedDirectory.path)
        let fileAttributes = try manager.attributesOfItem(atPath: stagedURL.path)
        precondition((directoryAttributes[.posixPermissions] as! NSNumber).intValue == 0o700)
        precondition((fileAttributes[.posixPermissions] as! NSNumber).intValue == 0o600)
        precondition(fileAttributes[.type] as? FileAttributeType == .typeRegular)
        // Suspension models PhotoKit's asynchronous callback: the complete
        // immutable copy must remain readable until that callback finishes.
        await Task.yield()
        try requireSameData(stagedURL, input.data)
        try await withStagedImportFile(data: input.data, filename: input.filename,
            directory: parent) { secondURL in
            precondition(secondURL != stagedURL)
            try requireSameData(secondURL, input.data)
        }
        precondition(manager.fileExists(atPath: stagedURL.path))
        return "callback complete"
    }
    precondition(result == "callback complete")
    precondition(!manager.fileExists(atPath: completedDirectory!.path))

    let retained = parent.appendingPathComponent("retained-import-record.json")
    let retainedData = Data("record remains".utf8)
    try retainedData.write(to: retained)
    var failedDirectory: URL?
    do {
        try await withStagedImportFile(data: input.data, filename: input.filename,
            directory: parent) { stagedURL in
            failedDirectory = stagedURL.deletingLastPathComponent()
            await Task.yield()
            try requireSameData(stagedURL, input.data)
            throw NSError(domain: "StagingTest", code: 42)
        }
        fatalError("throwing staging scope returned successfully")
    } catch {
        precondition((error as NSError).domain == "StagingTest")
        precondition((error as NSError).code == 42)
    }
    precondition(!manager.fileExists(atPath: failedDirectory!.path))
    try requireSameData(input.url, input.data)
    try requireSameData(retained, retainedData)
    let remaining = try manager.contentsOfDirectory(atPath: parent.path)
    precondition(remaining == [retained.lastPathComponent])

    let linkedParent = parent.deletingLastPathComponent().appendingPathComponent("linked-staging-parent")
    try manager.createSymbolicLink(at: linkedParent, withDestinationURL: parent)
    do {
        try await withStagedImportFile(data: input.data, filename: input.filename,
            directory: linkedParent) { _ in fatalError("symlink staging parent was accepted") }
        fatalError("symlink staging parent was accepted")
    } catch {}
    for filename in ["", ".", "..", "../outside.jpg", "nested/photo.jpg"] {
        do {
            try await withStagedImportFile(data: input.data, filename: filename,
                directory: parent) { _ in fatalError("invalid staged filename was accepted") }
            fatalError("invalid staged filename was accepted")
        } catch {}
    }
}

private func checkResourceStreams() async throws {
    let data = Data((0..<100_000).map { UInt8($0 % 251) })
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    for chunkSize in [1, 7, 4096, 65_536, data.count] {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let completion = ImportResourceCompletion(continuation: continuation,
                expectedSHA256: digest, expectedBytes: data.count)
            for start in stride(from: 0, to: data.count, by: chunkSize) {
                completion.receive(data.subdata(in: start..<min(start + chunkSize, data.count)))
            }
            completion.complete(nil)
            completion.receive(Data([99]))
            completion.complete(nil)
            precondition(!completion.expire())
        }
    }
    for variant in ["short", "long", "modified", "empty", "network", "timeout"] {
        var supplied = data
        switch variant {
        case "short": supplied.removeLast()
        case "long": supplied.append(contentsOf: [1, 2, 3])
        case "modified": supplied[10] ^= 255
        case "empty": supplied = Data()
        default: break
        }
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let completion = ImportResourceCompletion(continuation: continuation,
                    expectedSHA256: digest, expectedBytes: data.count)
                // Oversize data deliberately arrives in multiple extra chunks;
                // the diagnostic must report the whole received stream.
                for start in stride(from: 0, to: supplied.count, by: 1) {
                    completion.receive(supplied.subdata(in: start..<(start + 1)))
                }
                if variant == "network" {
                    completion.complete(NSError(domain: "ResourceTest", code: 42))
                } else if variant == "timeout" {
                    precondition(completion.expire())
                    precondition(!completion.expire())
                    completion.receive(data)
                    completion.complete(nil)
                } else { completion.complete(nil) }
                completion.complete(nil)
            }
            fatalError("resource stream unexpectedly accepted \(variant)")
        } catch {
            if variant == "network" {
                precondition((error as NSError).domain == "ResourceTest" && (error as NSError).code == 42)
            } else if variant == "timeout" {
                precondition(error.localizedDescription.contains("검증 시간이 초과"))
            } else {
                let actual = SHA256.hash(data: supplied).map { String(format: "%02x", $0) }.joined()
                let message = error.localizedDescription
                precondition(message.contains("입력: \(data.count)바이트, SHA-256 \(digest)"))
                precondition(message.contains("보관함: \(supplied.count)바이트, SHA-256 \(actual)"))
            }
        }
    }
}

private func requireSameData(_ url: URL, _ expected: Data) throws {
    let actual = try Data(contentsOf: url)
    precondition(actual == expected)
}
