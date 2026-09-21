import Foundation
import CoreFoundation
import Darwin

/// Explicit user-requested reset of this helper's registrations, never a grant.
enum PermissionRegistration {
    static let bundleID = "local.macgyver.photosautomation"
    static let services = ["Accessibility", "ScreenCapture", "Photos", "AppleEvents"]

    // Even after a partial reset, setup must still reopen a hidden window so
    // the user can see the failure and quit. All Photos operations stay blocked.
    static func canUseIPC(_ action: String, needsRestart: Bool) -> Bool {
        !needsRestart || action == "status" || action == "showSetup"
    }

    struct ResetResult: Sendable {
        let service: String
        let exitCode: Int32?
        let message: String?
        var succeeded: Bool { exitCode == 0 && message == nil }
    }

    struct RegistrationError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func reset(
        execute: @Sendable ([String]) async throws -> Int32 = { try await realTccutil($0) }
    ) async -> [ResetResult] {
        var results: [ResetResult] = []
        for service in services {
            do {
                let code = try await execute(["reset", service, bundleID])
                results.append(ResetResult(service: service, exitCode: code,
                    message: code == 0 ? nil : "\(service) 초기화 실패: tccutil 종료 코드 \(code)"))
            } catch {
                results.append(ResetResult(service: service, exitCode: nil,
                    message: "\(service) 초기화 실행 실패: \(error.localizedDescription)"))
            }
        }
        return results
    }

    static func realTccutil(_ arguments: [String]) async throws -> Int32 {
        // Defense in depth: even the process runner cannot target another app/service.
        guard arguments.count == 3, arguments[0] == "reset",
              services.contains(arguments[1]), arguments[2] == bundleID else {
            throw RegistrationError(message: "이 도우미의 지정된 권한만 초기화할 수 있습니다.")
        }
        return try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
            process.arguments = arguments
            process.standardInput = FileHandle.nullDevice
            process.terminationHandler = { task in
                continuation.resume(returning: task.terminationStatus)
            }
            do { try process.run() }
            catch {
                process.terminationHandler = nil
                continuation.resume(throwing: error)
            }
        }
    }

    /// Refuse resets between IPC requests as well as while a single request runs.
    /// Guard files are never removed here, including stale or malformed files.
    /// allowPendingRecovery is only for requesting/opening existing permissions:
    /// interrupted edits may need permission repair before they can be recovered.
    /// Never enable this option before reset().
    static func ensureIdle(
        ipcRoot: URL, projectRoot: URL, helperBusy: Bool,
        allowPendingRecovery: Bool = false,
        processAlive: (Int32) -> Bool = isProcessAlive
    ) throws {
        guard !helperBusy else {
            throw RegistrationError(message: "작업 처리 중에는 권한 설정을 변경할 수 없습니다. 현재 작업을 먼저 중지하세요.")
        }
        let artifacts = projectRoot.appendingPathComponent("artifacts", isDirectory: true)
        if !allowPendingRecovery, try exists(artifacts.appendingPathComponent("pending-edit.json")) {
            throw RegistrationError(message: "미완료 편집 기록이 있습니다. 기존 권한으로 복구한 뒤 초기화하세요.")
        }
        let active = artifacts.appendingPathComponent("active-run.json")
        if try exists(active) {
            guard allowPendingRecovery else {
                throw RegistrationError(message: "실행 기록이 남아 있습니다. 자동화를 종료하고 실행 상태를 확인한 뒤 초기화하세요.")
            }
            let record = try readGuard(active)
            guard let pid = processID(record["pid"]) else {
                throw RegistrationError(message: "실행 기록이 손상되었거나 프로세스 정보가 없습니다.")
            }
            guard !processAlive(pid) else {
                throw RegistrationError(message: "Mac 사진 자동화가 실행 중입니다. 먼저 중지하세요.")
            }
        }
        let lease = ipcRoot.appendingPathComponent("workflow-lock.json")
        guard try exists(lease) else { return }
        do {
            let object = try readGuard(lease)
            guard let pid = processID(object["pid"]),
                  let owner = object["projectRoot"] as? String,
                  let pending = object["pendingPath"] as? String,
                  owner.hasPrefix("/"), pending.hasPrefix("/"),
                  !owner.contains("\0"), !pending.contains("\0") else {
                throw RegistrationError(message: "실행 잠금 기록이 손상되었거나 필수 정보가 없습니다.")
            }
            guard !processAlive(pid) else {
                throw RegistrationError(message: "다른 Mac 사진 자동화가 실행 중입니다. 먼저 중지하세요.")
            }
            if !allowPendingRecovery, try exists(URL(fileURLWithPath: pending)) {
                throw RegistrationError(message: "이전 작업 폴더에 미완료 편집이 있습니다. 해당 폴더에서 먼저 복구하세요.")
            }
        } catch {
            throw RegistrationError(message: "권한 설정 중단: \(error.localizedDescription)")
        }
    }

    static func isProcessAlive(_ pid: Int32) -> Bool {
        guard pid > 1 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }

    private static func processID(_ value: Any?) -> Int32? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite,
              number.doubleValue.rounded(.towardZero) == number.doubleValue,
              number.doubleValue > 1, number.doubleValue <= Double(Int32.max) else { return nil }
        return number.int32Value
    }

    private static func readGuard(_ url: URL) throws -> [String: Any] {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= 1_048_576,
              let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
            throw RegistrationError(message: "작업 상태 파일이 손상되었거나 형식이 올바르지 않습니다: \(url.lastPathComponent)")
        }
        return object
    }

    private static func exists(_ url: URL) throws -> Bool {
        do {
            _ = try FileManager.default.attributesOfItem(atPath: url.path)
            return true
        } catch let error as NSError {
            if error.domain == NSCocoaErrorDomain &&
               [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code) {
                return false
            }
            throw RegistrationError(message: "작업 상태를 확인할 수 없습니다: \(url.lastPathComponent) (\(error.localizedDescription))")
        }
    }
}
