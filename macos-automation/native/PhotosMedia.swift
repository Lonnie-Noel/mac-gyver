import Foundation
import Photos
import ImageIO
import CoreImage
import CryptoKit
import UniformTypeIdentifiers
import Darwin

private struct PhotosMediaFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

private struct MacPhotoBaseline: Codable {
    var originalFilename: String
    var originalSHA256: String
    var initialCurrentSHA256: String
    var exportPath: String?
    var exportSHA256: String?
    var exportedCurrentSHA256: String?
    var exportBytes: Int?
    var exportWidth: Int?
    var exportHeight: Int?
    var revertRequested = false
    var restored = false
    // Optional for ledgers written before keep-edits became a terminal policy.
    var retained: Bool?

    var hasUnfinishedExport: Bool { exportSHA256 != nil && !restored && retained != true }

    func retentionVerification(path: String, verifiedHash: String) throws -> [String: Any] {
        guard !revertRequested, !restored,
              let hash = exportSHA256, hash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              verifiedHash == hash, path == exportPath,
              let current = exportedCurrentSHA256, current.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              let bytes = exportBytes, bytes >= 4, let width = exportWidth, width > 0,
              let height = exportHeight, height > 0 else {
            throw PhotosMediaFailure("검증된 JPEG 경로·해시·크기와 내보내기 기록이 일치해야 편집 결과를 보존 완료할 수 있습니다.")
        }
        return ["path": path, "sha256": hash, "bytes": bytes, "width": width, "height": height]
    }

    func retaining(currentSHA256: String) throws -> MacPhotoBaseline {
        guard !revertRequested, !restored, currentSHA256 == exportedCurrentSHA256 else {
            throw PhotosMediaFailure("사진 편집이 내보낸 결과와 달라 보존 완료하지 않습니다.")
        }
        var completed = self; completed.retained = true
        return completed
    }

    func requireRevertAllowed() throws {
        guard retained != true else {
            throw PhotosMediaFailure("편집 결과를 보존 완료한 사진은 자동으로 원본 복원하지 않습니다.")
        }
    }
}

private struct MacPhotoData {
    let data: Data
    let orientation: CGImagePropertyOrientation
}

private final class MediaCompletionGate<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    init(_ continuation: CheckedContinuation<Value, Error>) { self.continuation = continuation }
    @discardableResult func finish(_ result: Result<Value, Error>) -> Bool {
        lock.lock(); let pending = continuation; continuation = nil; lock.unlock()
        guard let pending else { return false }
        pending.resume(with: result)
        return true
    }
}

/// PhotoKit and local JPEG operations. The host explicitly requests permission;
/// these actions only check it. No filename-only search or library switching.
actor PhotosMedia {
    private let stateDirectory: URL
    private let ledgerURL: URL
    private var busy = false
    private let encoder: JSONEncoder = {
        let value = JSONEncoder(); value.outputFormatting = [.prettyPrinted, .sortedKeys]; return value
    }()

    init(stateDirectory: URL) {
        self.stateDirectory = stateDirectory.standardizedFileURL
        ledgerURL = stateDirectory.standardizedFileURL.appendingPathComponent("photo-media-ledger.json")
    }

    func handle(_ action: String, args: [String: Any]) async throws -> [String: Any] {
        guard !busy else { throw PhotosMediaFailure("다른 사진 파일 작업이 진행 중입니다.") }
        busy = true
        defer { busy = false }
        if action == "verifyJPEG" { return try verifiedJPEG(args) }
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized else {
            throw PhotosMediaFailure("전체 사진 접근 권한이 필요합니다. 앱의 권한 설정을 먼저 완료하세요.")
        }
        switch action {
        case "inspect": return try await inspect(args)
        case "export": return try await export(args)
        case "retain": return try await retain(args)
        case "revert": return try await revert(args)
        default: throw PhotosMediaFailure("지원하지 않는 사진 파일 동작: \(action)")
        }
    }

    private func inspect(_ args: [String: Any]) async throws -> [String: Any] {
        let (asset, name) = try exactAsset(args)
        let preserve = try boolean(args, "preserveBaseline", default: false)
        let expectedHash = args["baselineOriginalSHA256"] ?? args["expectedOriginalSHA256"]
        if expectedHash != nil && !preserve { throw PhotosMediaFailure("초기 해시 재검사는 preserveBaseline:true가 필요합니다.") }
        let original = try await imageData(asset, version: .original)
        let current = try await imageData(asset, version: .current)
        let originalHash = sha256(original.data), currentHash = sha256(current.data)
        let refreshed = try fetchAsset(asset.localIdentifier)
        guard refreshed.modificationDate == asset.modificationDate, try originalFilename(refreshed) == name else {
            throw PhotosMediaFailure("검사 중 사진이 변경되었습니다.")
        }
        var ledger = try loadLedger()
        if preserve {
            guard let baseline = ledger[asset.localIdentifier], baseline.originalFilename == name,
                  baseline.originalSHA256 == originalHash else {
                throw PhotosMediaFailure("복구할 사진이 저장된 초기 기록과 일치하지 않습니다.")
            }
            if let expectedHash {
                guard let hash = expectedHash as? String, isHash(hash), hash == originalHash else {
                    throw PhotosMediaFailure("요청한 초기 원본 해시가 사진과 일치하지 않습니다.")
                }
            }
        } else if !hasAdjustments(refreshed) {
            if let previous = ledger[asset.localIdentifier], previous.hasUnfinishedExport {
                throw PhotosMediaFailure("미완료 내보내기/복원 기록이 있습니다. 기존 작업을 먼저 복구하세요.")
            }
            ledger[asset.localIdentifier] = MacPhotoBaseline(originalFilename: name,
                originalSHA256: originalHash, initialCurrentSHA256: currentHash)
            try saveLedger(ledger)
        }
        return identity(asset, name, originalHash, currentHash, hasAdjustments(refreshed))
            .merging(["width": refreshed.pixelWidth, "height": refreshed.pixelHeight]) { _, new in new }
    }

    private func export(_ args: [String: Any]) async throws -> [String: Any] {
        let (asset, name, originalHash, baseline) = try await checkedAsset(args)
        guard !baseline.revertRequested, hasAdjustments(asset) else {
            throw PhotosMediaFailure("저장된 편집 결과가 없거나 이미 복원을 요청한 사진입니다.")
        }
        let output = try fileURL(args)
        let current = try await imageData(asset, version: .current)
        let currentHash = sha256(current.data)
        if let previousPath = baseline.exportPath {
            guard previousPath == output.path, baseline.exportedCurrentSHA256 == currentHash,
                  let previousHash = baseline.exportSHA256, let previousBytes = baseline.exportBytes,
                  let previousWidth = baseline.exportWidth, let previousHeight = baseline.exportHeight else {
                throw PhotosMediaFailure("기존 내보내기 기록과 경로 또는 편집 결과가 다릅니다.")
            }
            if FileManager.default.fileExists(atPath: output.path) {
                let verified = try verifiedJPEG(["path": output.path, "sha256": previousHash,
                    "bytes": previousBytes, "width": previousWidth, "height": previousHeight])
                return identity(asset, name, originalHash, currentHash, true).merging(verified) { _, new in new }
            }
        } else if FileManager.default.fileExists(atPath: output.path) {
            throw PhotosMediaFailure("기존 결과 파일을 덮어쓰지 않습니다.")
        }
        let jpeg = try makeJPEG(current)
        let refreshed = try fetchAsset(asset.localIdentifier)
        guard refreshed.modificationDate == asset.modificationDate, hasAdjustments(refreshed) else {
            throw PhotosMediaFailure("내보내는 동안 사진이 변경되었습니다.")
        }
        let hash = sha256(jpeg.data)
        if let previous = baseline.exportSHA256, previous != hash {
            throw PhotosMediaFailure("재개한 JPEG 결과가 기존 내보내기 해시와 다릅니다.")
        }
        var updated = baseline
        updated.exportPath = output.path; updated.exportSHA256 = hash
        updated.exportedCurrentSHA256 = currentHash
        updated.exportBytes = jpeg.data.count; updated.exportWidth = jpeg.width; updated.exportHeight = jpeg.height
        var ledger = try loadLedger(); ledger[asset.localIdentifier] = updated
        // Record the output intent before publishing. A crash retry may reuse only
        // this exact file and checksum; unrelated existing files are never replaced.
        try saveLedger(ledger)
        try publishExclusive(jpeg.data, at: output)
        let verified = try verifiedJPEG(["path": output.path, "sha256": hash,
            "bytes": jpeg.data.count, "width": jpeg.width, "height": jpeg.height])
        return identity(asset, name, originalHash, currentHash, true).merging(verified) { _, new in new }
    }

    private func retain(_ args: [String: Any]) async throws -> [String: Any] {
        let (asset, name, originalHash, baseline) = try await checkedAsset(args)
        guard hasAdjustments(asset), let verifiedHash = args["verifiedExportSHA256"] as? String else {
            throw PhotosMediaFailure("보존할 편집 결과와 검증된 JPEG 해시가 필요합니다.")
        }
        let output = try fileURL(args)
        let verification = try baseline.retentionVerification(path: output.path, verifiedHash: verifiedHash)
        _ = try verifiedJPEG(verification)
        let currentHash = sha256(try await imageData(asset, version: .current).data)
        let completed = try baseline.retaining(currentSHA256: currentHash)
        let fresh = try fetchAsset(asset.localIdentifier)
        guard fresh.modificationDate == asset.modificationDate, hasAdjustments(fresh),
              try originalFilename(fresh) == name else {
            throw PhotosMediaFailure("편집 결과 보존 확인 중 사진이 변경되었습니다.")
        }
        var ledger = try loadLedger(); ledger[asset.localIdentifier] = completed
        // Terminal native state is durable before the caller removes its pending
        // journal. Retrying after a crash re-verifies the same asset and JPEG.
        try saveLedger(ledger)
        return identity(fresh, name, originalHash, currentHash, true)
            .merging(["retained": true, "path": output.path, "sha256": verifiedHash]) { _, new in new }
    }

    private func revert(_ args: [String: Any]) async throws -> [String: Any] {
        let (asset, name, originalHash, baseline) = try await checkedAsset(args)
        try baseline.requireRevertAllowed()
        let output = try fileURL(args)
        guard let verifiedHash = args["verifiedExportSHA256"] as? String, isHash(verifiedHash),
              verifiedHash == baseline.exportSHA256, output.path == baseline.exportPath,
              let exportedCurrentHash = baseline.exportedCurrentSHA256,
              let bytes = baseline.exportBytes, let width = baseline.exportWidth, let height = baseline.exportHeight else {
            throw PhotosMediaFailure("검증된 JPEG와 내보내기 기록이 일치해야 복원할 수 있습니다.")
        }
        let verification: [String: Any] = ["path": output.path, "sha256": verifiedHash,
            "bytes": bytes, "width": width, "height": height]
        _ = try verifiedJPEG(verification)
        if !hasAdjustments(asset) {
            guard baseline.revertRequested else { throw PhotosMediaFailure("기록된 복원 요청 없이 사진 상태가 바뀌었습니다.") }
        } else {
            guard asset.canPerform(.content), sha256(try await imageData(asset, version: .current).data) == exportedCurrentHash else {
                throw PhotosMediaFailure("사진 편집이 내보낸 결과와 달라 복원하지 않습니다.")
            }
            try await downloadOriginalResources(asset)
            let fresh = try fetchAsset(asset.localIdentifier)
            guard try originalFilename(fresh) == name, hasAdjustments(fresh),
                  sha256(try await imageData(fresh, version: .current).data) == exportedCurrentHash else {
                throw PhotosMediaFailure("복원 준비 중 사진이 변경되었습니다.")
            }
            _ = try verifiedJPEG(verification)
            var ledger = try loadLedger(); var requested = baseline; requested.revertRequested = true
            ledger[asset.localIdentifier] = requested; try saveLedger(ledger)
            try await PHPhotoLibrary.shared().performChanges { PHAssetChangeRequest(for: fresh).revertAssetContentToOriginal() }
        }
        var restored = try fetchAsset(asset.localIdentifier)
        for _ in 0..<40 {
            if !hasAdjustments(restored) { break }
            try await Task.sleep(nanoseconds: 250_000_000)
            restored = try fetchAsset(asset.localIdentifier)
        }
        let afterOriginal = try await imageData(restored, version: .original)
        let afterCurrent = try await imageData(restored, version: .current)
        guard !hasAdjustments(restored), try originalFilename(restored) == name,
              sha256(afterOriginal.data) == originalHash, sha256(afterCurrent.data) == baseline.initialCurrentSHA256 else {
            throw PhotosMediaFailure("복원 후 사진이 초기 원본 상태와 일치하는지 확인하지 못했습니다.")
        }
        var ledger = try loadLedger(); var done = ledger[asset.localIdentifier] ?? baseline
        done.restored = true; ledger[asset.localIdentifier] = done; try saveLedger(ledger)
        return identity(restored, name, originalHash, sha256(afterCurrent.data), false)
            .merging(["restored": true, "path": output.path, "sha256": verifiedHash]) { _, new in new }
    }

    private func checkedAsset(_ args: [String: Any]) async throws -> (PHAsset, String, String, MacPhotoBaseline) {
        let (asset, name) = try exactAsset(args)
        guard let hash = args["baselineOriginalSHA256"] as? String, isHash(hash),
              let baseline = try loadLedger()[asset.localIdentifier], baseline.originalFilename == name,
              baseline.originalSHA256 == hash else {
            throw PhotosMediaFailure("미편집 상태에서 기록한 사진 ID·파일명·원본 해시가 필요합니다.")
        }
        guard sha256(try await imageData(asset, version: .original).data) == hash else {
            throw PhotosMediaFailure("현재 원본이 초기 해시와 다릅니다.")
        }
        return (asset, name, hash, baseline)
    }

    private func exactAsset(_ args: [String: Any]) throws -> (PHAsset, String) {
        guard let id = args["assetId"] as? String, !id.isEmpty, id.utf8.count <= 1024,
              let expected = args["expectedOriginalFilename"] as? String, !expected.isEmpty else {
            throw PhotosMediaFailure("Photos에서 읽은 정확한 사진 ID와 원본 파일명이 필요합니다.")
        }
        let asset = try fetchAsset(id)
        let name = try originalFilename(asset)
        guard name.precomposedStringWithCanonicalMapping == expected.precomposedStringWithCanonicalMapping else {
            throw PhotosMediaFailure("Photos와 PhotoKit의 사진 파일명이 다릅니다. 같은 시스템 보관함인지 확인하세요.")
        }
        return (asset, name)
    }

    private func fetchAsset(_ id: String) throws -> PHAsset {
        let result = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        guard result.count == 1, let asset = result.firstObject, asset.mediaType == .image,
              asset.localIdentifier == id else {
            throw PhotosMediaFailure("사진 ID가 PhotoKit 시스템 보관함에서 조회되지 않거나 정지 이미지가 아닙니다. 보관함을 자동 변경하지 않습니다.")
        }
        return asset
    }
    private func originalFilename(_ asset: PHAsset) throws -> String {
        let resources = PHAssetResource.assetResources(for: asset).filter { $0.type == .photo }
        guard resources.count == 1, let resource = resources.first else { throw PhotosMediaFailure("원본 사진 리소스가 하나가 아닙니다.") }
        return resource.originalFilename
    }
    private func hasAdjustments(_ asset: PHAsset) -> Bool {
        asset.hasAdjustments || PHAssetResource.assetResources(for: asset).contains { $0.type == .adjustmentData }
    }
    private func identity(_ asset: PHAsset, _ name: String, _ original: String, _ current: String, _ adjusted: Bool) -> [String: Any] {
        ["assetId": asset.localIdentifier, "originalFilename": name, "originalSHA256": original,
         "currentSHA256": current, "hasAdjustments": adjusted]
    }
    private func boolean(_ args: [String: Any], _ key: String, default fallback: Bool) throws -> Bool {
        guard let value = args[key] else { return fallback }
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw PhotosMediaFailure("\(key)는 true 또는 false여야 합니다.")
        }
        return number.boolValue
    }
    private func isHash(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    private func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    private func imageData(_ asset: PHAsset, version: PHImageRequestOptionsVersion) async throws -> MacPhotoData {
        try await withCheckedThrowingContinuation { continuation in
            let gate = MediaCompletionGate<MacPhotoData>(continuation)
            let options = PHImageRequestOptions(); options.version = version
            options.isNetworkAccessAllowed = true; options.deliveryMode = .highQualityFormat; options.resizeMode = .none
            let manager = PHImageManager.default()
            let id = manager.requestImageDataAndOrientation(for: asset, options: options) { data, _, orientation, info in
                if let error = info?[PHImageErrorKey] as? Error { gate.finish(.failure(error)); return }
                guard let data, !data.isEmpty, (info?[PHImageCancelledKey] as? Bool) != true else {
                    gate.finish(.failure(PhotosMediaFailure("사진 데이터를 읽지 못했습니다."))); return
                }
                gate.finish(.success(MacPhotoData(data: data, orientation: orientation)))
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 180) {
                if gate.finish(.failure(PhotosMediaFailure("사진 자료 다운로드가 180초 안에 끝나지 않았습니다."))) { manager.cancelImageRequest(id) }
            }
        }
    }
    private func downloadOriginalResources(_ asset: PHAsset) async throws {
        for resource in PHAssetResource.assetResources(for: asset).filter({ [.photo, .alternatePhoto, .pairedVideo, .video, .audio].contains($0.type) }) {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let gate = MediaCompletionGate<Void>(continuation), manager = PHAssetResourceManager.default()
                let options = PHAssetResourceRequestOptions(); options.isNetworkAccessAllowed = true
                let id = manager.requestData(for: resource, options: options, dataReceivedHandler: { _ in }) { error in
                    gate.finish(error.map { .failure($0) } ?? .success(()))
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + 180) {
                    if gate.finish(.failure(PhotosMediaFailure("복원용 원본 자료 다운로드가 시간 안에 끝나지 않았습니다."))) { manager.cancelDataRequest(id) }
                }
            }
        }
    }
    private func makeJPEG(_ image: MacPhotoData) throws -> (data: Data, width: Int, height: Int) {
        guard let source = CIImage(data: image.data, options: [.applyOrientationProperty: false]) else { throw PhotosMediaFailure("현재 사진을 디코딩하지 못했습니다.") }
        let oriented = source.oriented(forExifOrientation: Int32(image.orientation.rawValue)), extent = oriented.extent.integral
        guard !extent.isInfinite, extent.width > 0, extent.height > 0 else { throw PhotosMediaFailure("현재 사진 크기가 유효하지 않습니다.") }
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let context = CIContext(options: [.workingColorSpace: space, .outputColorSpace: space])
        guard let image = context.createCGImage(oriented, from: extent, format: .RGBA8, colorSpace: space) else { throw PhotosMediaFailure("전체 크기 사진 렌더링에 실패했습니다.") }
        let bytes = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil) else { throw PhotosMediaFailure("JPEG 저장기를 만들지 못했습니다.") }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 1.0, kCGImagePropertyOrientation: 1] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw PhotosMediaFailure("JPEG 인코딩에 실패했습니다.") }
        return (bytes as Data, image.width, image.height)
    }

    private func fileURL(_ args: [String: Any]) throws -> URL {
        guard let raw = args["path"] as? String, raw.hasPrefix("/"), !raw.utf8.contains(0) else { throw PhotosMediaFailure("절대 JPEG 파일 경로가 필요합니다.") }
        let url = URL(fileURLWithPath: raw).standardizedFileURL
        guard ["jpg", "jpeg"].contains(url.pathExtension.lowercased()) else { throw PhotosMediaFailure("JPEG 파일 확장자가 필요합니다.") }
        let parent = url.deletingLastPathComponent()
        let values = try parent.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else { throw PhotosMediaFailure("출력 부모 폴더는 실제 디렉터리여야 합니다.") }
        return parent.resolvingSymlinksInPath().appendingPathComponent(url.lastPathComponent)
    }

    private func readRegular(_ url: URL, maximum: Int = 512 * 1024 * 1024) throws -> Data {
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw PhotosMediaFailure("파일을 안전하게 열지 못했습니다: \(String(cString: strerror(errno)))") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 0, info.st_size <= maximum else {
            throw PhotosMediaFailure("검증할 파일은 크기가 제한된 일반 파일이어야 합니다.")
        }
        guard let data = try handle.readToEnd(), data.count == Int(info.st_size) else { throw PhotosMediaFailure("파일 전체를 읽지 못했습니다.") }
        return data
    }

    private func verifiedJPEG(_ args: [String: Any]) throws -> [String: Any] {
        let url = try fileURL(args), data = try readRegular(url)
        guard data.count >= 4, data[0] == 0xff, data[1] == 0xd8, data[2] == 0xff,
              data[data.count - 2] == 0xff, data[data.count - 1] == 0xd9,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetType(source) as String? == UTType.jpeg.identifier,
              CGImageSourceGetCount(source) == 1,
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
              CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete else {
            throw PhotosMediaFailure("완전한 JPEG 이미지를 디코딩하지 못했습니다.")
        }
        guard image.width > 0, image.height > 0, image.width <= 200_000, image.height <= 200_000,
              image.width * image.height <= 200_000_000 else { throw PhotosMediaFailure("JPEG 픽셀 크기가 검증 범위를 벗어납니다.") }
        guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
            bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw PhotosMediaFailure("전체 JPEG 픽셀 검증 버퍼를 만들지 못했습니다.") }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard context.makeImage() != nil else { throw PhotosMediaFailure("JPEG 전체 픽셀을 렌더링하지 못했습니다.") }
        let hash = sha256(data)
        if let expected = args["sha256"] {
            guard let expected = expected as? String, isHash(expected), expected == hash else { throw PhotosMediaFailure("JPEG SHA-256이 일치하지 않습니다.") }
        }
        for (key, actual) in [("bytes", data.count), ("width", image.width), ("height", image.height)] {
            if let expected = args[key] {
                guard let number = expected as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                      number.doubleValue == Double(actual) else { throw PhotosMediaFailure("JPEG \(key) 값이 일치하지 않습니다.") }
            }
        }
        return ["path": url.path, "sha256": hash, "bytes": data.count, "width": image.width, "height": image.height]
    }

    private func loadLedger() throws -> [String: MacPhotoBaseline] {
        if !FileManager.default.fileExists(atPath: ledgerURL.path) { return [:] }
        return try JSONDecoder().decode([String: MacPhotoBaseline].self, from: readRegular(ledgerURL, maximum: 16 * 1024 * 1024))
    }
    private func saveLedger(_ ledger: [String: MacPhotoBaseline]) throws {
        try FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true)
        let values = try stateDirectory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else { throw PhotosMediaFailure("상태 기록 폴더가 올바르지 않습니다.") }
        let temporary = stateDirectory.appendingPathComponent(".ledger-\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try writeNew(encoder.encode(ledger), to: temporary)
        guard Darwin.rename(temporary.path, ledgerURL.path) == 0 else { throw PhotosMediaFailure("사진 상태 기록을 확정하지 못했습니다.") }
        try syncDirectory(stateDirectory)
    }
    private func publishExclusive(_ data: Data, at url: URL) throws {
        let parent = url.deletingLastPathComponent(), temporary = parent.appendingPathComponent(".jpeg-\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try writeNew(data, to: temporary)
        guard Darwin.link(temporary.path, url.path) == 0 else { throw PhotosMediaFailure("결과 파일이 이미 있거나 JPEG를 확정하지 못했습니다. 덮어쓰지 않습니다.") }
        try syncDirectory(parent)
    }
    private func writeNew(_ data: Data, to url: URL) throws {
        let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
        guard fd >= 0 else { throw PhotosMediaFailure("새 파일을 만들지 못했습니다.") }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? file.close() }
        try file.write(contentsOf: data); try file.synchronize()
    }
    private func syncDirectory(_ url: URL) throws {
        let fd = Darwin.open(url.path, O_RDONLY | O_DIRECTORY)
        guard fd >= 0 else { throw PhotosMediaFailure("상태 폴더를 열지 못했습니다.") }
        defer { Darwin.close(fd) }
        guard fsync(fd) == 0 else { throw PhotosMediaFailure("상태 폴더 동기화에 실패했습니다.") }
    }
}
