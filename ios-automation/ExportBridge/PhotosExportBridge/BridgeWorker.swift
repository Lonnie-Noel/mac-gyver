import Foundation
import Photos
import ImageIO
import CoreImage
import CryptoKit
import UniformTypeIdentifiers

private struct BridgeRequest: Codable {
    let id: String
    let action: String
    let filename: String?
    let assetId: String?
    let expectedOriginalFilename: String?
    let baselineOriginalSHA256: String?
    let verifiedExportSHA256: String?
    let preserveBaseline: Bool?
    let selection: AssetSelection?
}

private struct CreationLocal: Codable, Equatable {
    let year: Int
    let month: Int
    let day: Int
    let hour: Int
    let minute: Int
}

// Photos' information panel displays the creation date to the local minute.
// These fields only narrow the filename candidates; ambiguity still fails closed.
private struct AssetSelection: Codable, Equatable {
    let creationLocal: CreationLocal
    let width: Int
    let height: Int

    private static var localCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }

    func validate() throws {
        let local = creationLocal
        guard (1...9999).contains(local.year), (1...12).contains(local.month),
              (1...31).contains(local.day), (0...23).contains(local.hour),
              (0...59).contains(local.minute), width > 0, height > 0,
              width <= 1_000_000, height <= 1_000_000 else {
            throw BridgeFailure("사진 선택 정보의 날짜, 시간 또는 픽셀 크기가 유효하지 않습니다.")
        }
        let calendar = Self.localCalendar
        let components = DateComponents(timeZone: calendar.timeZone, year: local.year,
            month: local.month, day: local.day, hour: local.hour, minute: local.minute)
        guard let date = calendar.date(from: components),
              Self.localMinute(date, calendar: calendar) == local else {
            throw BridgeFailure("사진 선택 정보의 현지 날짜와 시간이 실제 달력에 존재하지 않습니다.")
        }
    }

    static func metadata(for asset: PHAsset) -> AssetSelection? {
        guard let date = asset.creationDate else { return nil }
        let selection = AssetSelection(creationLocal: localMinute(date, calendar: localCalendar),
            width: asset.pixelWidth, height: asset.pixelHeight)
        do {
            try selection.validate()
            return selection
        } catch { return nil }
    }

    private static func localMinute(_ date: Date, calendar: Calendar) -> CreationLocal {
        let fields = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return CreationLocal(year: fields.year ?? 0, month: fields.month ?? 0,
            day: fields.day ?? 0, hour: fields.hour ?? -1, minute: fields.minute ?? -1)
    }
}

private struct BridgeResponse: Codable {
    var id: String
    var ok = false
    var error: String?
    var assetId: String?
    var originalFilename: String?
    var hasAdjustments: Bool?
    var originalSHA256: String?
    var currentSHA256: String?
    var outputFile: String?
    var sha256: String?
    var bytes: Int?
    var width: Int?
    var height: Int?
    var restored: Bool?
    var selection: AssetSelection?
}

private struct Baseline: Codable {
    var originalFilename: String
    var originalSHA256: String
    var initialCurrentSHA256: String
    var exportSHA256: String?
    var exportedCurrentSHA256: String?
    var revertRequested = false
    var restored = false
}

private struct ImageData {
    let data: Data
    let orientation: CGImagePropertyOrientation
}

private struct BridgeFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

// PhotoKit callbacks and a timeout may race. Complete their continuation exactly once.
private final class CompletionGate<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    init(_ continuation: CheckedContinuation<Value, Error>) { self.continuation = continuation }
    @discardableResult func finish(_ result: Result<Value, Error>) -> Bool {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        guard let pending else { return false }
        pending.resume(with: result)
        return true
    }
}

actor BridgeWorker {
    private let documents: URL
    private let stateURL: URL
    private let encoder: JSONEncoder
    private var processing = false
    private var lastMalformedDigest: String?

    init() {
        documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        stateURL = support.appendingPathComponent("export-ledger.json")
        encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    }

    func processPendingRequest() async -> String? {
        guard !processing else { return nil }
        let requestURL = documents.appendingPathComponent("request.json")
        guard let data = try? Data(contentsOf: requestURL) else { return nil }
        let request: BridgeRequest
        do {
            request = try JSONDecoder().decode(BridgeRequest.self, from: data)
            guard UUID(uuidString: request.id) != nil,
                  ["inspect", "export", "revert"].contains(request.action) else {
                throw BridgeFailure("요청 ID 또는 동작 형식이 잘못되었습니다.")
            }
        } catch {
            let digest = sha256(data)
            guard digest != lastMalformedDigest else { return nil }
            lastMalformedDigest = digest
            // Invalid IDs must never be used as filesystem paths.
            let response = BridgeResponse(id: "invalid-request", error: error.localizedDescription)
            try? write(response, to: documents.appendingPathComponent("invalid-request-response.json"))
            return "요청 형식 오류: \(error.localizedDescription)"
        }
        let responseURL = documents.appendingPathComponent("\(request.id)-response.json")
        // A completed request ID is immutable, even when request.json is pushed again.
        guard !FileManager.default.fileExists(atPath: responseURL.path) else { return nil }
        processing = true
        defer { processing = false }
        var response = BridgeResponse(id: request.id)
        do {
            let authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            guard authorization == .authorized else {
                throw BridgeFailure("전체 사진 접근 권한이 필요합니다. 제한된 접근으로는 파일명 중복을 확인할 수 없습니다. 앱에서 '사진 접근 권한 설정' 또는 iOS 설정으로 전체 접근을 허용한 뒤 새 요청 ID로 다시 실행하세요.")
            }
            switch request.action {
            case "inspect": response = try await inspect(request)
            case "export": response = try await export(request)
            case "revert": response = try await revert(request)
            default: throw BridgeFailure("지원하지 않는 요청입니다.")
            }
            response.ok = true
        } catch {
            response.error = error.localizedDescription
        }
        do {
            try write(response, to: responseURL)
        } catch {
            return "응답 저장 실패: \(error.localizedDescription). 앱을 종료하지 말고 Mac에서 상태를 확인하세요."
        }
        return response.ok ? "\(request.action) 완료: \(response.originalFilename ?? request.id)"
            : "\(request.action) 실패: \(response.error ?? "알 수 없는 오류")"
    }

    private func inspect(_ request: BridgeRequest) async throws -> BridgeResponse {
        guard let filename = request.filename, !filename.isEmpty,
              filename == (filename as NSString).lastPathComponent else {
            throw BridgeFailure("inspect에는 경로가 아닌 원본 파일명이 필요합니다.")
        }
        let requestedName = filename.precomposedStringWithCanonicalMapping.lowercased()
        let requestedHasExtension = !(filename as NSString).pathExtension.isEmpty
        try request.selection?.validate()
        let recoveryIdentitySupplied = request.assetId != nil || request.baselineOriginalSHA256 != nil
        if recoveryIdentitySupplied {
            guard request.preserveBaseline == true, let assetID = request.assetId, !assetID.isEmpty,
                  let hash = request.baselineOriginalSHA256, hash.count == 64,
                  hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
                throw BridgeFailure("사진 ID로 재검사하려면 초기 원본 SHA-256과 preserveBaseline이 함께 필요합니다.")
            }
        }
        let assets: PHFetchResult<PHAsset>
        if let assetID = request.assetId {
            assets = PHAsset.fetchAssets(withLocalIdentifiers: [assetID], options: nil)
        } else {
            assets = PHAsset.fetchAssets(with: .image, options: nil)
        }
        var matches: [PHAsset] = []
        assets.enumerateObjects { asset, _, stop in
            guard asset.mediaType == .image else { return }
            let resources = PHAssetResource.assetResources(for: asset)
            if resources.contains(where: {
                guard $0.type == .photo else { return false }
                let name = requestedHasExtension ? $0.originalFilename : ($0.originalFilename as NSString).deletingPathExtension
                return name.precomposedStringWithCanonicalMapping.lowercased() == requestedName
            }) {
                if let selection = request.selection, AssetSelection.metadata(for: asset) != selection { return }
                matches.append(asset)
                if matches.count > 1 { stop.pointee = true }
            }
        }
        guard matches.count == 1, let asset = matches.first else {
            throw BridgeFailure(matches.isEmpty
                ? "사진 식별 정보와 일치하는 사진을 찾지 못했습니다. 사진 권한, 파일명, 날짜와 크기를 확인하세요."
                : "같은 사진 식별 정보에 해당하는 사진이 여러 장입니다. 사진을 고유하게 식별할 수 없어 중단했습니다.")
        }
        let resolvedFilename = try originalFilename(asset)
        let original = try await imageData(asset, version: .original)
        let current = try await imageData(asset, version: .current)
        let originalHash = sha256(original.data)
        let currentHash = sha256(current.data)
        if recoveryIdentitySupplied {
            guard let expectedHash = request.baselineOriginalSHA256, expectedHash == originalHash,
                  let baseline = try loadLedger()[asset.localIdentifier],
                  baseline.originalFilename == resolvedFilename, baseline.originalSHA256 == expectedHash else {
                throw BridgeFailure("재검사할 사진의 파일명 또는 원본 해시가 편집 전 초기 기록과 일치하지 않습니다.")
            }
        }
        let refreshed = try assetWithID(asset.localIdentifier)
        guard refreshed.modificationDate == asset.modificationDate,
              refreshed.creationDate == asset.creationDate,
              refreshed.pixelWidth == asset.pixelWidth, refreshed.pixelHeight == asset.pixelHeight else {
            throw BridgeFailure("검사 중 사진이 변경되었습니다. 새 요청으로 다시 확인하세요.")
        }
        let adjusted = hasAdjustments(refreshed)
        if !adjusted && request.preserveBaseline != true {
            var ledger = try loadLedger()
            if let previous = ledger[asset.localIdentifier], previous.revertRequested && !previous.restored {
                // Keep the recovery receipt until the explicit revert retry verifies completion.
                throw BridgeFailure("이 사진의 미완료 복원 기록이 있습니다. Mac에서 기존 작업 복구를 먼저 실행하세요.")
            }
            ledger[asset.localIdentifier] = Baseline(originalFilename: resolvedFilename,
                originalSHA256: originalHash, initialCurrentSHA256: currentHash)
            try saveLedger(ledger)
        }
        var response = BridgeResponse(id: request.id, assetId: asset.localIdentifier,
            originalFilename: resolvedFilename, hasAdjustments: adjusted,
            originalSHA256: originalHash, currentSHA256: currentHash)
        response.width = asset.pixelWidth
        response.height = asset.pixelHeight
        response.selection = AssetSelection.metadata(for: refreshed)
        return response
    }

    private func export(_ request: BridgeRequest) async throws -> BridgeResponse {
        let (asset, name, originalHash, baseline) = try await checkedAsset(request)
        guard !baseline.revertRequested else {
            throw BridgeFailure("복원을 이미 요청한 사진입니다. 새 내보내기 전에 기존 복원을 확인하세요.")
        }
        guard hasAdjustments(asset) else { throw BridgeFailure("편집 결과가 저장된 사진만 내보낼 수 있습니다.") }
        let current = try await imageData(asset, version: .current)
        let jpeg = try makeJPEG(current)
        let refreshed = try assetWithID(asset.localIdentifier)
        guard refreshed.modificationDate == asset.modificationDate, hasAdjustments(refreshed) else {
            throw BridgeFailure("내보내기 중 사진이 변경되어 JPEG를 확정하지 않았습니다.")
        }
        let outputName = "\(request.id)-result.jpg"
        let outputURL = documents.appendingPathComponent(outputName)
        try jpeg.data.write(to: outputURL, options: .atomic)
        let currentHash = sha256(current.data)
        let outputHash = sha256(jpeg.data)
        var ledger = try loadLedger()
        var updated = baseline
        updated.exportSHA256 = outputHash
        updated.exportedCurrentSHA256 = currentHash
        ledger[asset.localIdentifier] = updated
        try saveLedger(ledger)
        return BridgeResponse(id: request.id, assetId: asset.localIdentifier, originalFilename: name,
            hasAdjustments: true, originalSHA256: originalHash, currentSHA256: currentHash,
            outputFile: outputName, sha256: outputHash, bytes: jpeg.data.count,
            width: jpeg.width, height: jpeg.height)
    }

    private func revert(_ request: BridgeRequest) async throws -> BridgeResponse {
        let (asset, name, originalHash, baseline) = try await checkedAsset(request)
        guard let verifiedHash = request.verifiedExportSHA256,
              verifiedHash == baseline.exportSHA256,
              baseline.exportedCurrentSHA256 != nil else {
            throw BridgeFailure("Mac 검증이 완료된 JPEG의 SHA-256이 내보내기 기록과 일치해야 복원할 수 있습니다.")
        }
        let alreadyUnadjusted = !hasAdjustments(asset)
        if alreadyUnadjusted {
            guard baseline.revertRequested else {
                throw BridgeFailure("기록된 복원 요청 없이 사진 상태가 바뀌었습니다. 자동으로 완료 처리하지 않습니다.")
            }
        } else {
            let current = try await imageData(asset, version: .current)
            guard sha256(current.data) == baseline.exportedCurrentSHA256 else {
                throw BridgeFailure("내보내기 후 사진이 추가로 변경되었습니다. 복원하지 않고 중단했습니다.")
            }
            guard asset.canPerform(.content) else { throw BridgeFailure("이 사진은 내용 편집을 지원하지 않습니다.") }
            try await downloadOriginalResources(asset)
            let beforeRevert = try assetWithID(asset.localIdentifier)
            let latestCurrent = try await imageData(beforeRevert, version: .current)
            guard hasAdjustments(beforeRevert), try originalFilename(beforeRevert) == name,
                  sha256(latestCurrent.data) == baseline.exportedCurrentSHA256 else {
                throw BridgeFailure("복원 준비 중 사진이 변경되었습니다. 복원하지 않고 중단했습니다.")
            }
            var ledger = try loadLedger()
            var requested = baseline
            requested.revertRequested = true
            ledger[asset.localIdentifier] = requested
            try saveLedger(ledger)
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest(for: beforeRevert).revertAssetContentToOriginal()
            }
        }
        var restoredAsset = try assetWithID(asset.localIdentifier)
        for _ in 0..<20 {
            if !hasAdjustments(restoredAsset) { break }
            try await Task.sleep(nanoseconds: 250_000_000)
            restoredAsset = try assetWithID(asset.localIdentifier)
        }
        guard !hasAdjustments(restoredAsset), try originalFilename(restoredAsset) == name else {
            throw BridgeFailure("복원 후 사진 식별 또는 편집 상태 검증에 실패했습니다.")
        }
        let restoredOriginal = try await imageData(restoredAsset, version: .original)
        guard sha256(restoredOriginal.data) == originalHash else {
            throw BridgeFailure("복원 후 원본 해시가 실행 전 기록과 다릅니다.")
        }
        let restoredCurrent = try await imageData(restoredAsset, version: .current)
        guard sha256(restoredCurrent.data) == baseline.initialCurrentSHA256 else {
            throw BridgeFailure("복원 후 현재 이미지가 실행 전 이미지와 일치하지 않습니다.")
        }
        var ledger = try loadLedger()
        var finished = ledger[asset.localIdentifier] ?? baseline
        finished.restored = true
        ledger[asset.localIdentifier] = finished
        try saveLedger(ledger)
        return BridgeResponse(id: request.id, assetId: asset.localIdentifier, originalFilename: name,
            hasAdjustments: false, originalSHA256: originalHash,
            currentSHA256: sha256(restoredCurrent.data), restored: true)
    }

    private func checkedAsset(_ request: BridgeRequest) async throws -> (PHAsset, String, String, Baseline) {
        guard let assetID = request.assetId, let expectedName = request.expectedOriginalFilename,
              let expectedHash = request.baselineOriginalSHA256,
              expectedHash.count == 64 else { throw BridgeFailure("사진 ID, 원본 파일명, 초기 원본 SHA-256이 필요합니다.") }
        let asset = try assetWithID(assetID)
        let name = try originalFilename(asset)
        guard name == expectedName else { throw BridgeFailure("사진 ID와 원본 파일명이 일치하지 않습니다.") }
        guard let baseline = try loadLedger()[assetID], baseline.originalFilename == name,
              baseline.originalSHA256 == expectedHash else {
            throw BridgeFailure("편집 전 미편집 상태를 확인한 초기 기록이 없거나 일치하지 않습니다.")
        }
        let original = try await imageData(asset, version: .original)
        let hash = sha256(original.data)
        guard hash == expectedHash else { throw BridgeFailure("원본 이미지가 실행 전 기록과 달라 작업을 중단했습니다.") }
        return (asset, name, hash, baseline)
    }

    private func assetWithID(_ id: String) throws -> PHAsset {
        let fetched = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        guard fetched.count == 1, let asset = fetched.firstObject, asset.mediaType == .image else {
            throw BridgeFailure("해당 사진 ID를 찾을 수 없거나 정지 이미지가 아닙니다.")
        }
        return asset
    }

    private func originalFilename(_ asset: PHAsset) throws -> String {
        let originals = PHAssetResource.assetResources(for: asset).filter { $0.type == .photo }
        guard originals.count == 1, let resource = originals.first else {
            throw BridgeFailure("사진의 원본 이미지 리소스를 하나로 식별할 수 없습니다.")
        }
        return resource.originalFilename
    }

    private func hasAdjustments(_ asset: PHAsset) -> Bool {
        asset.hasAdjustments || PHAssetResource.assetResources(for: asset).contains { $0.type == .adjustmentData }
    }

    private func imageData(_ asset: PHAsset, version: PHImageRequestOptionsVersion) async throws -> ImageData {
        try await withCheckedThrowingContinuation { continuation in
            let gate = CompletionGate<ImageData>(continuation)
            let options = PHImageRequestOptions()
            options.version = version
            options.isNetworkAccessAllowed = true
            options.deliveryMode = .highQualityFormat
            options.resizeMode = .none
            let manager = PHImageManager.default()
            let requestID = manager.requestImageDataAndOrientation(for: asset, options: options) { data, _, orientation, info in
                if let error = info?[PHImageErrorKey] as? Error { gate.finish(.failure(error)); return }
                guard (info?[PHImageCancelledKey] as? Bool) != true, let data, !data.isEmpty else {
                    gate.finish(.failure(BridgeFailure("사진 데이터를 읽지 못했거나 요청이 취소되었습니다."))); return
                }
                gate.finish(.success(ImageData(data: data, orientation: orientation)))
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 180) {
                if gate.finish(.failure(BridgeFailure("사진 다운로드가 180초 안에 끝나지 않았습니다."))) {
                    manager.cancelImageRequest(requestID)
                }
            }
        }
    }

    private func downloadOriginalResources(_ asset: PHAsset) async throws {
        let originals = PHAssetResource.assetResources(for: asset).filter {
            [.photo, .alternatePhoto, .pairedVideo, .video, .audio].contains($0.type)
        }
        for resource in originals {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let gate = CompletionGate<Void>(continuation)
                let options = PHAssetResourceRequestOptions()
                options.isNetworkAccessAllowed = true
                let manager = PHAssetResourceManager.default()
                let id = manager.requestData(for: resource, options: options, dataReceivedHandler: { _ in }) { error in
                    gate.finish(error.map { .failure($0) } ?? .success(()))
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + 180) {
                    if gate.finish(.failure(BridgeFailure("복원용 원본 자료 다운로드가 시간 안에 끝나지 않았습니다."))) {
                        manager.cancelDataRequest(id)
                    }
                }
            }
        }
    }

    private func makeJPEG(_ image: ImageData) throws -> (data: Data, width: Int, height: Int) {
        guard let input = CIImage(data: image.data, options: [.applyOrientationProperty: false]) else {
            throw BridgeFailure("현재 이미지 데이터를 디코딩하지 못했습니다.")
        }
        let oriented = input.oriented(forExifOrientation: Int32(image.orientation.rawValue))
        let extent = oriented.extent.integral
        guard extent.width > 0, extent.height > 0, !extent.isInfinite else {
            throw BridgeFailure("현재 이미지의 픽셀 크기가 유효하지 않습니다.")
        }
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        let context = CIContext(options: [.workingColorSpace: colorSpace, .outputColorSpace: colorSpace])
        guard let rendered = context.createCGImage(oriented, from: extent, format: .RGBA8, colorSpace: colorSpace) else {
            throw BridgeFailure("최대 크기 JPEG용 이미지 렌더링에 실패했습니다.")
        }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw BridgeFailure("JPEG 저장기를 만들지 못했습니다.")
        }
        CGImageDestinationAddImage(destination, rendered, [
            kCGImageDestinationLossyCompressionQuality: 1.0,
            kCGImagePropertyOrientation: 1
        ] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw BridgeFailure("JPEG 저장을 완료하지 못했습니다.") }
        return (data as Data, rendered.width, rendered.height)
    }

    private func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func loadLedger() throws -> [String: Baseline] {
        guard FileManager.default.fileExists(atPath: stateURL.path) else { return [:] }
        return try JSONDecoder().decode([String: Baseline].self, from: Data(contentsOf: stateURL))
    }
    private func saveLedger(_ ledger: [String: Baseline]) throws { try write(ledger, to: stateURL) }
    private func write<Value: Encodable>(_ value: Value, to url: URL) throws {
        try encoder.encode(value).write(to: url, options: .atomic)
    }
}
