import Foundation
import Photos
import ImageIO
import CryptoKit
import UniformTypeIdentifiers
import Darwin

private struct PhotosImportFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

private struct ImportEntry: Codable {
    var path: String
    var filename: String
    var sha256: String
    var bytes: Int
    var state: String
    var assetID: String?
    var width: Int?
    var height: Int?
}

private struct ImportLedger: Codable {
    var version = 1
    var runID: String
    var albumName: String
    var albumID: String?
    var entries: [String: ImportEntry] = [:]
    // Present only for the single-transaction batch protocol. Keep the source
    // order explicitly; dictionary order and Photos album order are unrelated.
    var orderedPaths: [String]?
}

private struct ImportInput {
    let runID: String
    let albumName: String
    let url: URL
    let filename: String
    let sha256: String
    let bytes: Int
    let data: Data
}

/// Imports copies into a new album owned by one run. No source writes, filename
/// searches, deletion, permission prompts, or automatic uncertain retries.
actor PhotosImport {
    private let stateDirectory: URL
    private var busy = false

    init(stateDirectory: URL) { self.stateDirectory = stateDirectory.standardizedFileURL }

    func importImage(_ args: [String: Any]) async throws -> [String: Any] {
        guard !busy else { throw PhotosImportFailure("다른 사진 가져오기를 처리 중입니다.") }
        busy = true
        defer { busy = false }
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized else {
            throw PhotosImportFailure("사진 전체 접근 권한이 필요합니다. 권한 설정을 먼저 완료하세요.")
        }
        let input = try importInput(args)
        let store = ImportLedgerStore(directory: stateDirectory, runID: input.runID)
        let previous = try store.load()
        var ledger = previous ?? ImportLedger(runID: input.runID, albumName: input.albumName)
        guard ledger.version == 1, ledger.runID == input.runID, ledger.albumName == input.albumName else {
            throw PhotosImportFailure("가져오기 실행 기록과 요청한 앨범 정보가 다릅니다.")
        }
        guard ledger.orderedPaths == nil else {
            throw uncertain("한 번에 가져온 실행에 개별 사진을 추가할 수 없습니다.")
        }
        guard ledger.entries.values.allSatisfy({ $0.state == "complete" }) else {
            throw uncertain("이 실행에 완료 여부가 확인되지 않은 가져오기 기록이 있습니다.")
        }
        if let existing = ledger.entries[input.url.path] {
            guard existing.path == input.url.path, existing.filename == input.filename,
                  existing.sha256 == input.sha256, existing.bytes == input.bytes else {
                throw PhotosImportFailure("같은 실행에서 입력 파일이 변경되었습니다. 가져오기를 반복하지 않습니다.")
            }
            return try await validatedResult(ledger, entry: existing)
        }
        let album: PHAssetCollection?
        if ledger.albumID != nil { album = try exactAlbum(ledger) }
        else {
            guard ledger.entries.isEmpty else { throw uncertain("가져오기 기록에 앨범 ID가 없습니다.") }
            album = nil
        }
        if let album, !album.canPerform(.addContent) {
            throw PhotosImportFailure("기록된 작업 앨범에 사진을 추가할 수 없습니다.")
        }
        // The data overload may rewrite metadata. A private, byte-identical
        // file keeps the original resource intact without trusting the mutable
        // input path. Its lifetime includes the performChanges callback.
        return try await withStagedImportFile(data: input.data, filename: input.filename,
            directory: stateDirectory) { stagedURL in
            ledger.entries[input.url.path] = ImportEntry(path: input.url.path, filename: input.filename,
                sha256: input.sha256, bytes: input.bytes, state: "pending")
            // This intent must reach disk before any PhotoKit creation request.
            try store.save(ledger, exclusive: previous == nil)
            let intended = ledger
            let outcome = ImportTransactionOutcome()
            do {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    PHPhotoLibrary.shared().performChanges {
                        do {
                            let albumRequest: PHAssetCollectionChangeRequest
                            let albumID: String
                            if let album {
                                guard let request = PHAssetCollectionChangeRequest(for: album) else {
                                    throw PhotosImportFailure("작업 앨범 변경 요청을 만들지 못했습니다.")
                                }
                                albumRequest = request; albumID = album.localIdentifier
                            } else {
                                let request = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: input.albumName)
                                let placeholder = request.placeholderForCreatedAssetCollection
                                albumRequest = request; albumID = placeholder.localIdentifier
                            }
                            let assetRequest = PHAssetCreationRequest.forAsset()
                            guard let placeholder = assetRequest.placeholderForCreatedAsset else {
                                throw PhotosImportFailure("새 사진 ID를 확인하지 못했습니다.")
                            }
                            var identified = intended
                            identified.albumID = albumID
                            identified.entries[input.url.path]?.assetID = placeholder.localIdentifier
                            // The block cannot throw to roll back PhotoKit. If this
                            // write fails, add no resource or album membership and
                            // keep the earlier pending intent. An empty album may
                            // remain, so even a reported failure is never retried.
                            try store.save(identified)
                            let options = PHAssetResourceCreationOptions()
                            options.originalFilename = input.filename
                            options.shouldMoveFile = false
                            assetRequest.addResource(with: .photo, fileURL: stagedURL, options: options)
                            albumRequest.addAssets([placeholder] as NSArray)
                            outcome.prepared(identified)
                        } catch { outcome.failed(error) }
                    } completionHandler: { success, error in
                        if let preparationError = outcome.snapshot().error {
                            continuation.resume(throwing: preparationError)
                        } else if let error { continuation.resume(throwing: error) }
                        else if !success { continuation.resume(throwing: PhotosImportFailure("사진 보관함 가져오기 결과를 확인하지 못했습니다.")) }
                        else { continuation.resume() }
                    }
                }
                guard var completed = outcome.snapshot().ledger,
                      var entry = completed.entries[input.url.path] else {
                    throw PhotosImportFailure("가져온 사진의 정확한 ID 기록이 없습니다.")
                }
                let result = try await validatedResult(completed, entry: entry)
                guard let item = result["item"] as? [String: Any],
                      let width = item["width"] as? Int, let height = item["height"] as? Int else {
                    throw PhotosImportFailure("가져온 사진 크기 응답이 유효하지 않습니다.")
                }
                entry.state = "complete"; entry.width = width; entry.height = height
                completed.entries[input.url.path] = entry
                try store.save(completed)
                return result
            } catch { throw uncertain(error.localizedDescription) }
        }
    }

    func importImages(_ args: [String: Any]) async throws -> [String: Any] {
        guard !busy else { throw PhotosImportFailure("다른 사진 가져오기를 처리 중입니다.") }
        busy = true
        defer { busy = false }
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized else {
            throw PhotosImportFailure("사진 전체 접근 권한이 필요합니다. 권한 설정을 먼저 완료하세요.")
        }
        // Validate and stage one source at a time. No all-images Data array is
        // retained, and no PhotoKit request starts until EVERY source is ready.
        return try await withStagedImportBatch(args, directory: stateDirectory) { intent, stages in
            let store = ImportLedgerStore(directory: stateDirectory, runID: intent.runID)
            if let previous = try store.load() {
                try validateExistingBatchLedger(previous, requested: intent)
                // A known-complete response can be reconstructed read-only;
                // pending/uncertain batches are never automatically replayed.
                return try await validatedBatchResult(previous)
            }
            try store.save(intent, exclusive: true)
            let outcome = ImportTransactionOutcome()
            do {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    PHPhotoLibrary.shared().performChanges {
                        do {
                            let albumRequest = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: intent.albumName)
                            let albumID = albumRequest.placeholderForCreatedAssetCollection.localIdentifier
                            let requests = stages.map { _ in PHAssetCreationRequest.forAsset() }
                            let placeholders = try requests.map { request -> PHObjectPlaceholder in
                                guard let placeholder = request.placeholderForCreatedAsset else {
                                    throw PhotosImportFailure("새 사진 ID를 확인하지 못했습니다.")
                                }
                                return placeholder
                            }
                            let identified = try identifiedBatchLedger(intent, albumID: albumID,
                                assetIDs: placeholders.map(\.localIdentifier))
                            // Persist ALL exact placeholder IDs before adding
                            // any resource. If preparation fails, retain intent
                            // and never assume PhotoKit rolled back its block.
                            try store.save(identified)
                            for (index, stage) in stages.enumerated() {
                                let options = PHAssetResourceCreationOptions()
                                options.originalFilename = stage.url.lastPathComponent
                                options.shouldMoveFile = false
                                requests[index].addResource(with: .photo, fileURL: stage.url, options: options)
                            }
                            albumRequest.addAssets(placeholders as NSArray)
                            outcome.prepared(identified)
                        } catch { outcome.failed(error) }
                    } completionHandler: { success, error in
                        if let preparationError = outcome.snapshot().error {
                            continuation.resume(throwing: preparationError)
                        } else if let error { continuation.resume(throwing: error) }
                        else if !success { continuation.resume(throwing: PhotosImportFailure("사진 보관함 일괄 가져오기 결과를 확인하지 못했습니다.")) }
                        else { continuation.resume() }
                    }
                }
                guard var completed = outcome.snapshot().ledger else {
                    throw PhotosImportFailure("가져온 사진의 정확한 ID 기록이 없습니다.")
                }
                let result = try await validatedBatchResult(completed)
                guard let imports = result["imports"] as? [[String: Any]],
                      let paths = completed.orderedPaths, imports.count == paths.count else {
                    throw PhotosImportFailure("일괄 가져오기 검증 응답이 유효하지 않습니다.")
                }
                for (index, path) in paths.enumerated() {
                    guard let item = imports[index]["item"] as? [String: Any],
                          let width = item["width"] as? Int, let height = item["height"] as? Int else {
                        throw PhotosImportFailure("가져온 사진 크기 응답이 유효하지 않습니다.")
                    }
                    completed.entries[path]?.state = "complete"
                    completed.entries[path]?.width = width
                    completed.entries[path]?.height = height
                }
                try store.save(completed)
                return result
            } catch { throw uncertain(error.localizedDescription) }
        }
    }

    private func validatedBatchResult(_ ledger: ImportLedger) async throws -> [String: Any] {
        guard let paths = ledger.orderedPaths, !paths.isEmpty,
              paths.count == ledger.entries.count, Set(paths).count == paths.count else {
            throw PhotosImportFailure("일괄 가져오기 사진 순서 기록이 유효하지 않습니다.")
        }
        try verifyBatchMembership(ledger)
        var imports: [[String: Any]] = []
        for path in paths {
            guard let entry = ledger.entries[path] else {
                throw PhotosImportFailure("일괄 가져오기 기록에 입력 사진이 없습니다.")
            }
            let result = try await validatedResult(ledger, entry: entry)
            imports.append(["item": result["item"]!, "sourceSHA256": result["sourceSHA256"]!])
        }
        // Hash validation can wait for iCloud, so also reject membership changes
        // made during that interval before returning any editable photo IDs.
        try verifyBatchMembership(ledger)
        return ["album": ["id": ledger.albumID!, "name": ledger.albumName], "imports": imports]
    }

    private func verifyBatchMembership(_ ledger: ImportLedger) throws {
        let album = try exactAlbum(ledger)
        let ids = ledger.entries.values.compactMap(\.assetID)
        guard ids.count == ledger.entries.count, Set(ids).count == ids.count else {
            throw PhotosImportFailure("일괄 가져오기 사진 ID 기록이 유효하지 않습니다.")
        }
        let options = PHFetchOptions(); options.includeHiddenAssets = true
        let assets = PHAsset.fetchAssets(in: album, options: options)
        var actual = Set<String>()
        assets.enumerateObjects { asset, _, _ in actual.insert(asset.localIdentifier) }
        guard assets.count == ids.count, actual == Set(ids) else {
            throw PhotosImportFailure("작업 앨범의 사진 ID 집합이 일괄 가져오기 기록과 다릅니다.")
        }
    }

    private func exactAlbum(_ ledger: ImportLedger) throws -> PHAssetCollection {
        guard let id = ledger.albumID, !id.isEmpty else { throw PhotosImportFailure("기록된 작업 앨범 ID가 없습니다.") }
        let albums = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil)
        guard albums.count == 1, let album = albums.firstObject, album.localIdentifier == id,
              album.assetCollectionType == .album, album.localizedTitle == ledger.albumName else {
            throw PhotosImportFailure("정확한 작업 앨범을 찾지 못했거나 앨범 이름이 변경되었습니다.")
        }
        return album
    }

    private func validatedResult(_ ledger: ImportLedger, entry: ImportEntry) async throws -> [String: Any] {
        let album = try exactAlbum(ledger)
        guard let id = entry.assetID, !id.isEmpty else { throw PhotosImportFailure("기록된 사진 ID가 없습니다.") }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        guard assets.count == 1, let asset = assets.firstObject, asset.localIdentifier == id,
              asset.mediaType == .image, !asset.mediaSubtypes.contains(.photoLive),
              asset.pixelWidth > 0, asset.pixelHeight > 0 else {
            throw PhotosImportFailure("가져온 정확한 사진 ID와 이미지 크기를 확인하지 못했습니다.")
        }
        let options = PHFetchOptions(); options.includeHiddenAssets = true
        guard PHAsset.fetchAssets(in: album, options: options).index(of: asset) != NSNotFound else {
            throw PhotosImportFailure("가져온 사진이 기록된 작업 앨범에 없습니다.")
        }
        let originals = PHAssetResource.assetResources(for: asset).filter { $0.type == .photo }
        guard originals.count == 1, originals[0].originalFilename == entry.filename else {
            throw PhotosImportFailure("가져온 사진의 원본 파일 이름이 입력과 다릅니다.")
        }
        if entry.state == "complete" {
            guard entry.width == asset.pixelWidth, entry.height == asset.pixelHeight else {
                throw PhotosImportFailure("이전에 가져온 사진의 이미지 크기가 변경되었습니다.")
            }
        }
        try await verifyOriginalResource(originals[0], sha256: entry.sha256, bytes: entry.bytes)
        return ["album": ["id": album.localIdentifier, "name": ledger.albumName],
                "item": ["id": id, "filename": entry.filename, "width": asset.pixelWidth, "height": asset.pixelHeight],
                "sourceSHA256": entry.sha256]
    }

    private func verifyOriginalResource(_ resource: PHAssetResource, sha256: String, bytes: Int) async throws {
        let manager = PHAssetResourceManager.default()
        let options = PHAssetResourceRequestOptions(); options.isNetworkAccessAllowed = true
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let completion = ImportResourceCompletion(continuation: continuation, expectedSHA256: sha256, expectedBytes: bytes)
            let requestID = manager.requestData(for: resource, options: options,
                dataReceivedHandler: { completion.receive($0) }, completionHandler: { completion.complete($0) })
            DispatchQueue.global().asyncAfter(deadline: .now() + 180) {
                if completion.expire() { manager.cancelDataRequest(requestID) }
            }
        }
    }

    private func uncertain(_ detail: String) -> PhotosImportFailure {
        PhotosImportFailure("\(detail) 가져오기 기록을 보존했습니다. 사진 보관함에 사본이나 빈 작업 앨범이 남아 있을 수 있으므로 자동으로 다시 가져오지 않습니다.")
    }
}

private final class ImportTransactionOutcome: @unchecked Sendable {
    private let lock = NSLock()
    private var ledger: ImportLedger?
    private var error: Error?
    func prepared(_ value: ImportLedger) { lock.lock(); defer { lock.unlock() }; ledger = value }
    func failed(_ value: Error) { lock.lock(); defer { lock.unlock() }; error = value }
    func snapshot() -> (ledger: ImportLedger?, error: Error?) { lock.lock(); defer { lock.unlock() }; return (ledger, error) }
}

private final class ImportResourceCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    private var hasher = SHA256()
    private var count = 0
    private let expectedSHA256: String
    private let expectedBytes: Int
    init(continuation: CheckedContinuation<Void, Error>, expectedSHA256: String, expectedBytes: Int) {
        self.continuation = continuation; self.expectedSHA256 = expectedSHA256; self.expectedBytes = expectedBytes
    }
    func receive(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        guard continuation != nil else { return }
        hasher.update(data: data)
        count += data.count
    }
    func complete(_ error: Error?) {
        lock.lock()
        guard let pending = continuation else { lock.unlock(); return }
        continuation = nil
        let actualBytes = count
        let actualSHA256 = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        let matches = actualBytes == expectedBytes && actualSHA256 == expectedSHA256
        lock.unlock()
        if let error { pending.resume(throwing: error) }
        else if !matches {
            pending.resume(throwing: PhotosImportFailure("사진 보관함의 원본 파일 바이트·SHA-256이 입력 파일과 다릅니다. 입력: \(expectedBytes)바이트, SHA-256 \(expectedSHA256); 보관함: \(actualBytes)바이트, SHA-256 \(actualSHA256)."))
        } else { pending.resume() }
    }
    func expire() -> Bool {
        lock.lock(); let pending = continuation; continuation = nil; lock.unlock()
        pending?.resume(throwing: PhotosImportFailure("가져온 원본 파일 검증 시간이 초과되었습니다."))
        return pending != nil
    }
}

/// All stages stay alive across the single asynchronous PhotoKit transaction
/// and its subsequent resource validation. Each decoded source/Data is released
/// before reading the next source; only metadata and private URLs accumulate.
private func withStagedImportBatch<T>(_ args: [String: Any], directory: URL,
    operation: (ImportLedger, [ImportStagedFile]) async throws -> T) async throws -> T {
    guard let rawRunID = args["runID"] as? String, let runID = UUID(uuidString: rawRunID),
          let albumName = args["albumName"] as? String, albumName.hasPrefix("MacGyver"), albumName.utf8.count <= 256,
          !albumName.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          let files = args["files"] as? [[String: Any]], !files.isEmpty, files.count <= 10_000 else {
        throw PhotosImportFailure("일괄 가져오기 실행 ID·앨범 이름·파일 목록이 올바르지 않습니다 (1~10,000장).")
    }
    let paths = files.compactMap { $0["path"] as? String }
    guard paths.count == files.count, Set(paths).count == paths.count else {
        throw PhotosImportFailure("일괄 가져오기에는 각 원본 경로가 정확히 한 번만 있어야 합니다.")
    }
    var intent = ImportLedger(runID: runID.uuidString, albumName: albumName, orderedPaths: paths)
    var stages: [ImportStagedFile] = []
    defer { stages.forEach { $0.remove() } }
    for file in files {
        let prepared = try autoreleasepool { () throws -> (ImportEntry, ImportStagedFile) in
            var inputArgs = file
            inputArgs["runID"] = runID.uuidString; inputArgs["albumName"] = albumName
            let input = try importInput(inputArgs)
            let stage = try ImportStagedFile(data: input.data, filename: input.filename, parent: directory)
            let entry = ImportEntry(path: input.url.path, filename: input.filename,
                sha256: input.sha256, bytes: input.bytes, state: "pending")
            return (entry, stage)
        }
        intent.entries[prepared.0.path] = prepared.0
        stages.append(prepared.1)
    }
    return try await operation(intent, stages)
}

private func identifiedBatchLedger(_ intent: ImportLedger, albumID: String, assetIDs: [String]) throws -> ImportLedger {
    guard let paths = intent.orderedPaths, !paths.isEmpty, paths.count == intent.entries.count,
          Set(paths).count == paths.count, paths.count == assetIDs.count,
          !albumID.isEmpty, assetIDs.allSatisfy({ !$0.isEmpty }), Set(assetIDs).count == assetIDs.count,
          intent.albumID == nil,
          paths.allSatisfy({ intent.entries[$0]?.path == $0 && intent.entries[$0]?.state == "pending" && intent.entries[$0]?.assetID == nil }) else {
        throw PhotosImportFailure("일괄 가져오기 의도와 새 앨범·사진 ID 목록이 일치하지 않습니다.")
    }
    var identified = intent
    identified.albumID = albumID
    for (index, path) in paths.enumerated() { identified.entries[path]?.assetID = assetIDs[index] }
    return identified
}

private func validateExistingBatchLedger(_ previous: ImportLedger, requested: ImportLedger) throws {
    guard previous.version == 1, previous.runID == requested.runID,
          previous.albumName == requested.albumName, previous.orderedPaths == requested.orderedPaths,
          previous.orderedPaths != nil, previous.entries.count == requested.entries.count,
          requested.entries.allSatisfy({ path, entry in
              guard let existing = previous.entries[path] else { return false }
              return existing.path == entry.path && existing.filename == entry.filename &&
                  existing.sha256 == entry.sha256 && existing.bytes == entry.bytes
          }) else {
        throw PhotosImportFailure("일괄 가져오기 실행 기록과 입력 파일·순서가 다릅니다. 자동으로 다시 가져오지 않습니다.")
    }
    guard previous.entries.values.allSatisfy({ $0.state == "complete" }) else {
        throw PhotosImportFailure("이 실행에 완료 여부가 확인되지 않은 일괄 가져오기 기록이 있습니다. 기록을 보존하며 자동으로 다시 가져오지 않습니다.")
    }
}

/// Only the verified in-memory input is staged. PhotoKit receives no reference
/// to the user's source file, and the scope survives its asynchronous callback.
private func withStagedImportFile<T>(data: Data, filename: String, directory: URL,
    operation: (URL) async throws -> T) async throws -> T {
    let stage = try ImportStagedFile(data: data, filename: filename, parent: directory)
    defer { stage.remove() }
    return try await operation(stage.url)
}

private struct ImportStagedFile {
    let directory: URL
    let url: URL

    init(data: Data, filename: String, parent: URL) throws {
        guard !data.isEmpty, !filename.isEmpty, filename != ".", filename != "..",
              !filename.contains("/"), !filename.utf8.contains(0) else {
            throw PhotosImportFailure("가져오기 임시 파일 이름과 데이터가 올바르지 않습니다.")
        }
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let parentFD = Darwin.open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parentFD >= 0 else { throw PhotosImportFailure("가져오기 임시 파일의 상위 폴더를 안전하게 열지 못했습니다.") }
        defer { Darwin.close(parentFD) }
        let name = ".import-stage-\(UUID().uuidString)"
        guard mkdirat(parentFD, name, mode_t(0o700)) == 0 else {
            throw PhotosImportFailure("가져오기 임시 폴더를 만들지 못했습니다.")
        }
        directory = parent.appendingPathComponent(name, isDirectory: true)
        url = directory.appendingPathComponent(filename)
        do {
            let directoryFD = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard directoryFD >= 0 else { throw PhotosImportFailure("가져오기 임시 폴더를 안전하게 열지 못했습니다.") }
            defer { Darwin.close(directoryFD) }
            guard fchmod(directoryFD, mode_t(0o700)) == 0 else {
                throw PhotosImportFailure("가져오기 임시 폴더 권한을 제한하지 못했습니다.")
            }
            let fd = openat(directoryFD, filename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
            guard fd >= 0 else { throw PhotosImportFailure("가져오기 임시 파일을 만들지 못했습니다.") }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            defer { try? handle.close() }
            guard fchmod(fd, mode_t(0o600)) == 0 else {
                throw PhotosImportFailure("가져오기 임시 파일 권한을 제한하지 못했습니다.")
            }
            try handle.write(contentsOf: data)
            try handle.synchronize()
            guard fsync(directoryFD) == 0, fsync(parentFD) == 0 else {
                throw PhotosImportFailure("가져오기 임시 파일을 디스크에 동기화하지 못했습니다.")
            }
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    func remove() { try? FileManager.default.removeItem(at: directory) }
}

private func importInput(_ args: [String: Any]) throws -> ImportInput {
    guard let rawRunID = args["runID"] as? String, let runID = UUID(uuidString: rawRunID),
          let albumName = args["albumName"] as? String, albumName.hasPrefix("MacGyver"), albumName.utf8.count <= 256,
          !albumName.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          let path = args["path"] as? String, path.hasPrefix("/"), !path.utf8.contains(0),
          let filename = args["filename"] as? String, !filename.isEmpty, filename.utf8.count <= 255,
          !filename.contains("/"), !filename.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          let expected = args["sha256"] as? String, expected.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
          let bytes = args["bytes"] as? NSNumber, CFGetTypeID(bytes) != CFBooleanGetTypeID(),
          bytes.doubleValue > 0, bytes.doubleValue <= 512 * 1024 * 1024,
          bytes.doubleValue.rounded(.towardZero) == bytes.doubleValue else {
        throw PhotosImportFailure("가져오기 실행 ID·앨범 이름·원본 파일 정보가 올바르지 않습니다.")
    }
    let url = URL(fileURLWithPath: path).standardizedFileURL
    guard url.lastPathComponent == filename, url.path == path,
          ["jpg", "jpeg", "png", "heic", "heif", "tif", "tiff"].contains(url.pathExtension.lowercased()) else {
        throw PhotosImportFailure("원본 파일 이름·절대 경로·지원 이미지 확장자가 일치해야 합니다.")
    }
    let data = try importReadRegular(url, maximum: 512 * 1024 * 1024)
    guard data.count == bytes.intValue,
          SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == expected else {
        throw PhotosImportFailure("입력 파일 크기 또는 SHA-256이 요청과 다릅니다.")
    }
    try validateImportImage(data, extension: url.pathExtension.lowercased())
    return ImportInput(runID: runID.uuidString, albumName: albumName, url: url,
        filename: filename, sha256: expected, bytes: data.count, data: data)
}

private func validateImportImage(_ data: Data, extension ext: String) throws {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let type = CGImageSourceGetType(source) as String?, CGImageSourceGetCount(source) == 1,
          CGImageSourceGetStatus(source) == .statusComplete,
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
          let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
          width.intValue > 0, height.intValue > 0, width.intValue <= 200_000, height.intValue <= 200_000,
          width.intValue * height.intValue <= 200_000_000 else {
        throw PhotosImportFailure("입력 파일은 완전하고 크기가 제한된 단일 정지 이미지여야 합니다.")
    }
    let allowed: Set<String>
    switch ext {
    case "jpg", "jpeg": allowed = [UTType.jpeg.identifier]
    case "png": allowed = [UTType.png.identifier]
    case "heic", "heif": allowed = [UTType.heic.identifier, UTType.heif.identifier]
    default: allowed = [UTType.tiff.identifier]
    }
    guard allowed.contains(type),
          let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
          CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
          image.width == width.intValue, image.height == height.intValue,
          let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
              bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw PhotosImportFailure("입력 이미지 형식과 확장자가 다르거나 전체 이미지를 디코딩하지 못했습니다.")
    }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    guard context.makeImage() != nil else { throw PhotosImportFailure("입력 이미지 픽셀 검증에 실패했습니다.") }
}

private func importReadRegular(_ url: URL, maximum: Int) throws -> Data {
    let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { throw PhotosImportFailure("일반 원본 파일을 안전하게 열지 못했습니다.") }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    defer { try? handle.close() }
    var before = stat(), after = stat()
    guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
          before.st_size > 0, before.st_size <= maximum else {
        throw PhotosImportFailure("파일은 크기가 제한된 일반 파일이어야 합니다.")
    }
    // A growing file must not turn readToEnd into an unbounded allocation.
    var data = Data(); data.reserveCapacity(Int(before.st_size))
    while data.count <= Int(before.st_size) {
        let limit = min(1_048_576, Int(before.st_size) + 1 - data.count)
        guard let chunk = try handle.read(upToCount: limit), !chunk.isEmpty else { break }
        data.append(chunk)
    }
    guard data.count == Int(before.st_size),
          fstat(fd, &after) == 0, before.st_size == after.st_size,
          before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
          before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
          before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
          before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else {
        throw PhotosImportFailure("파일이 일반 파일이 아니거나 크기 제한을 벗어났거나 읽는 동안 변경되었습니다.")
    }
    return data
}

private struct ImportLedgerStore: Sendable {
    let directory: URL
    let runID: String
    var url: URL { directory.appendingPathComponent("import-\(runID).json") }

    func load() throws -> ImportLedger? {
        var info = stat()
        if lstat(url.path, &info) != 0 {
            if errno == ENOENT { return nil }
            throw PhotosImportFailure("가져오기 기록 상태를 확인하지 못했습니다.")
        }
        return try JSONDecoder().decode(ImportLedger.self, from: importReadRegular(url, maximum: 16 * 1024 * 1024))
    }
    func save(_ ledger: ImportLedger, exclusive: Bool = false) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let directoryFD = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directoryFD >= 0 else { throw PhotosImportFailure("가져오기 상태 폴더가 실제 디렉터리가 아닙니다.") }
        defer { Darwin.close(directoryFD) }
        if !exclusive {
            var existing = stat()
            guard lstat(url.path, &existing) == 0, existing.st_mode & S_IFMT == S_IFREG else {
                throw PhotosImportFailure("기존 가져오기 기록이 사라졌거나 일반 파일이 아닙니다.")
            }
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(ledger)
        guard data.count <= 16 * 1024 * 1024 else { throw PhotosImportFailure("가져오기 기록 크기 제한을 넘었습니다.") }
        let temporary = directory.appendingPathComponent(".import-\(UUID().uuidString).tmp")
        let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else { throw PhotosImportFailure("가져오기 기록 임시 파일을 만들지 못했습니다.") }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? file.close(); try? FileManager.default.removeItem(at: temporary) }
        try file.write(contentsOf: data); try file.synchronize()
        if exclusive {
            guard Darwin.link(temporary.path, url.path) == 0 else { throw PhotosImportFailure("같은 실행의 가져오기 기록이 이미 있거나 기록을 확정하지 못했습니다.") }
        } else {
            guard Darwin.rename(temporary.path, url.path) == 0 else { throw PhotosImportFailure("가져오기 기록을 확정하지 못했습니다.") }
        }
        guard fsync(directoryFD) == 0 else { throw PhotosImportFailure("가져오기 상태 폴더를 디스크에 동기화하지 못했습니다.") }
    }
}
