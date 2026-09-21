import AppKit
import ApplicationServices
import Photos
import ScreenCaptureKit
import Darwin

@MainActor
final class BridgeAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var timer: Timer?
    private var busy = false
    private var window: NSWindow?
    private var statusLabel: NSTextField?
    private var statusItem: NSStatusItem?
    private let ui = PhotosUI()
    private var media: PhotosMedia!
    private var root: URL!
    private var currentID: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let arguments = CommandLine.arguments
            if let index = arguments.firstIndex(of: "--ipc-root"), index + 1 < arguments.count {
                root = URL(fileURLWithPath: arguments[index + 1], isDirectory: true)
            } else {
                root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("MacGyverMacPhotos", isDirectory: true)
            }
            for directory in [root!, root.appendingPathComponent("inbox"), root.appendingPathComponent("outbox"), root.appendingPathComponent("state")] {
                if FileManager.default.fileExists(atPath: directory.path) {
                    let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
                    guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw HostError("IPC 경로는 실제 폴더여야 합니다.") }
                }
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            }
            media = PhotosMedia(stateDirectory: root.appendingPathComponent("state"))
            timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                Task { @MainActor in await self?.processNext() }
            }
            installStatusMenu()
            if !arguments.contains("--background") { showSetup() }
        } catch {
            showSetup()
            statusLabel?.stringValue = "시작 오류: \(error.localizedDescription)"
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showSetup()
        return true
    }

    private func installStatusMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "사진 자동화"
        item.button?.toolTip = "Mac 사진 자동화 설정 및 종료"
        let menu = NSMenu()
        let settings = NSMenuItem(title: "설정 창 열기", action: #selector(openSetup), keyEquivalent: "")
        settings.target = self
        menu.addItem(settings)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "보조 앱 종료", action: #selector(quitHelper), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item
    }

    @objc private func openSetup() { showSetup() }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    private func status() -> [String: Any] {
        let photos = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        let photoStatus: String
        switch photos {
        case .authorized: photoStatus = "authorized"
        case .limited: photoStatus = "limited"
        case .denied: photoStatus = "denied"
        case .restricted: photoStatus = "restricted"
        default: photoStatus = "notDetermined"
        }
        return ["accessibility": AXIsProcessTrusted(), "postEvents": CGPreflightPostEventAccess(),
                "screenCapture": CGPreflightScreenCaptureAccess(), "photos": photoStatus,
                "busy": busy, "currentRequest": currentID ?? "", "protocolVersion": 2,
                "executable": Bundle.main.executableURL?.path ?? ""]
    }

    private func processNext() async {
        guard !busy, root != nil, media != nil else { return }
        do {
            let inbox = root.appendingPathComponent("inbox")
            let files = try FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" && UUID(uuidString: $0.deletingPathExtension().lastPathComponent) != nil }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            for file in files {
                let id = file.deletingPathExtension().lastPathComponent
                let output = root.appendingPathComponent("outbox/\(id).json")
                if FileManager.default.fileExists(atPath: output.path) { continue }
                let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
                guard attributes[.type] as? FileAttributeType == .typeRegular,
                      ((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= 1_048_576 else { continue }
                busy = true; currentID = id
                defer { busy = false; currentID = nil }
                var response: [String: Any] = ["id": id]
                do {
                    let started = root.appendingPathComponent("state/request-\(id).started")
                    guard !FileManager.default.fileExists(atPath: started.path) else {
                        throw HostError("이전 실행에서 결과가 확정되지 않은 요청입니다. UI 명령을 다시 보내지 말고 복구 명령으로 사진 상태를 확인하세요.")
                    }
                    try Data(id.utf8).write(to: started, options: .atomic)
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: started.path)
                    let object = try JSONSerialization.jsonObject(with: Data(contentsOf: file))
                    guard let request = object as? [String: Any], request["id"] as? String == id,
                          let action = request["action"] as? String,
                          let args = request["args"] as? [String: Any] else { throw HostError("요청 형식이 잘못됐습니다.") }
                    // Reject abandoned requests before starting work. Once a
                    // durable export/revert starts, allow it to finish safely.
                    try validateRequestLifetime(request)
                    response["result"] = try await dispatch(action, args: args)
                    response["ok"] = true
                } catch {
                    response["ok"] = false
                    response["error"] = error.localizedDescription
                }
                let data = try JSONSerialization.data(withJSONObject: response, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: output, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
                return
            }
        } catch {
            statusLabel?.stringValue = "요청 처리 오류: \(error.localizedDescription)"
        }
    }

    private func dispatch(_ action: String, args: [String: Any]) async throws -> [String: Any] {
        switch action {
        case "status": return status()
        case "showSetup": showSetup(); return status()
        case "snapshot": return try ui.snapshot()
        case "press": return try ui.press(args)
        case "drag": return try await ui.drag(args)
        case "capture": return try await ui.capture(args)
        case "selection", "albums", "albumItems", "show", "activate": return try PhotosScripting.handle(action, args: args)
        case "inspect", "export", "revert", "verifyJPEG": return try await media.handle(action, args: args)
        default: throw HostError("지원하지 않는 명령입니다: \(action)")
        }
    }

    private func showSetup() {
        if let window { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); refreshStatus(); return }
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 610, height: 460),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Mac 사진 자동화 설정"
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "Mac 사진 자동화 권한")
        title.font = .boldSystemFont(ofSize: 22); stack.addArrangedSubview(title)
        let explanation = NSTextField(wrappingLabelWithString: "사진 앱의 버튼 조작과 창 캡처, 사진 ID 확인, JPEG 저장·원본 복원에 권한이 필요합니다. 아래 버튼은 macOS 권한 요청을 엽니다. 허용 여부는 직접 선택하세요. 입력 감시는 사용하지 않습니다.")
        stack.addArrangedSubview(explanation)
        let label = NSTextField(wrappingLabelWithString: ""); label.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        stack.addArrangedSubview(label); statusLabel = label
        stack.addArrangedSubview(NSTextField(wrappingLabelWithString: "창을 숨겨도 메뉴 막대의 ‘사진 자동화 → 설정 창 열기’에서 다시 열 수 있습니다. 앱을 다시 실행하거나 설정 커맨드를 실행해도 열립니다."))
        for (title, action) in [("권한 요청", #selector(requestPermissions)), ("상태 새로고침", #selector(refreshStatus)), ("설정 창 숨기기", #selector(closeSetup)), ("보조 앱 종료", #selector(quitHelper))] {
            let button = NSButton(title: title, target: self, action: action); stack.addArrangedSubview(button)
        }
        panel.contentView?.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: panel.contentView!.topAnchor, constant: 24)])
        panel.center(); window = panel; panel.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); refreshStatus()
    }

    @objc private func requestPermissions() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        Task { @MainActor in
            _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            do { _ = try PhotosScripting.handle("selection", args: [:]) }
            catch { statusLabel?.stringValue = error.localizedDescription }
            refreshStatus()
        }
    }
    @objc private func refreshStatus() {
        let current = status()
        statusLabel?.stringValue = "손쉬운 사용: \(current["accessibility"]!)   화면 기록: \(current["screenCapture"]!)\n사진: \(current["photos"]!)\n자동화 > 사진 권한은 사진 ID 조회 시 확인됩니다.\n권한 변경 후 보조 앱을 종료하고 다시 열어야 할 수 있습니다."
    }
    @objc private func closeSetup() { window?.orderOut(nil) }
    @objc private func quitHelper() {
        guard !busy else {
            statusLabel?.stringValue = "작업 처리 중에는 종료할 수 없습니다. 현재 요청이 끝난 뒤 다시 시도하세요."
            return
        }
        NSApp.terminate(nil)
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        busy ? .terminateCancel : .terminateNow
    }
}

private func kernelProcessIdentity(_ pid: Int32) throws -> [String: Any] {
    guard pid > 1 else { throw HostError("요청 프로세스 ID가 유효하지 않습니다.") }
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
          info.pbi_pid == UInt32(pid), info.pbi_status != UInt32(SZOMB),
          info.pbi_uid == geteuid(), info.pbi_start_tvsec > 0 else {
        throw HostError("요청을 만든 실행이 종료됐거나 현재 사용자 프로세스가 아닙니다. 대기 요청을 실행하지 않습니다.")
    }
    return ["pid": Int(pid), "uid": Int(info.pbi_uid),
            "processStart": "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"]
}

private func requestInteger(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double.rounded(.towardZero) == double,
          abs(double) <= 9_007_199_254_740_991 else { return nil }
    return Int64(double)
}

private func validateRequestLifetime(_ request: [String: Any]) throws {
    guard requestInteger(request["protocolVersion"]) == 2,
          let client = request["client"] as? [String: Any],
          let pid = requestInteger(client["pid"]), pid > 1, pid <= Int64(Int32.max),
          let uid = requestInteger(client["uid"]), uid == Int64(geteuid()),
          let processStart = client["processStart"] as? String,
          let session = client["sessionId"] as? String, UUID(uuidString: session) != nil,
          let created = requestInteger(request["createdAtMs"]), created > 0,
          let expires = requestInteger(request["expiresAtMs"]), expires > created else {
        throw HostError("실행 수명 정보가 없는 이전 형식의 요청입니다. 대기 요청을 실행하지 않습니다.")
    }
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    guard created <= now + 1_000, now < expires else {
        throw HostError("요청이 만료됐거나 생성 시간이 유효하지 않습니다. 대기 요청을 실행하지 않습니다.")
    }
    let current = try kernelProcessIdentity(Int32(pid))
    guard current["processStart"] as? String == processStart else {
        throw HostError("요청을 만든 실행과 현재 프로세스가 다릅니다. 이전 실행의 대기 요청을 실행하지 않습니다.")
    }
}

private struct HostError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

@main
struct MacPhotosBridgeMain {
    @MainActor static func main() {
        let arguments = CommandLine.arguments
        if arguments.dropFirst().first == "--client-identity" {
            do {
                guard arguments.count == 3, let pid = Int32(arguments[2]) else {
                    throw HostError("--client-identity 뒤에 실행 프로세스 ID가 필요합니다.")
                }
                let data = try JSONSerialization.data(withJSONObject: kernelProcessIdentity(pid), options: [.sortedKeys])
                FileHandle.standardOutput.write(data + Data([10]))
            } catch {
                FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
                exit(64)
            }
            return
        }
        let app = NSApplication.shared
        let delegate = BridgeAppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}
