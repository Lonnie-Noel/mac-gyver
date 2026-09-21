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
    private var permissionNoticeLabel: NSTextField?
    private var permissionBusy = false
    private var permissionsNeedRestart = false
    private var statusItem: NSStatusItem?
    private let ui = PhotosUI()
    private var media: PhotosMedia!
    private var importer: PhotosImport!
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
            importer = PhotosImport(stateDirectory: root.appendingPathComponent("state"))
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
        let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.Photos")
        let automation = AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, false)
        return ["accessibility": AXIsProcessTrusted(), "postEvents": CGPreflightPostEventAccess(),
                "screenCapture": CGPreflightScreenCaptureAccess(), "photos": photoStatus,
                "photosAutomation": automation == noErr, "photosAutomationStatus": automation,
                "busy": busy || permissionBusy, "currentRequest": currentID ?? "", "protocolVersion": 2,
                "capabilities": ["input-images-v1"],
                "executable": Bundle.main.executableURL?.path ?? ""]
    }

    private func processNext() async {
        guard !busy, !permissionBusy, root != nil, media != nil else { return }
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
        guard PermissionRegistration.canUseIPC(action, needsRestart: permissionsNeedRestart) else {
            throw HostError("권한을 초기화했습니다. 설정 창에서 보조 앱 종료를 누른 뒤 설정 커맨드를 다시 실행하세요.")
        }
        switch action {
        case "status": return status()
        case "showSetup": showSetup(); return status()
        case "snapshot": return try ui.snapshot()
        case "press": return try ui.press(args)
        case "drag": return try await ui.drag(args)
        case "capture": return try await ui.capture(args)
        case "selection", "albums", "albumItems", "show", "activate": return try PhotosScripting.handle(action, args: args)
        case "inspect", "export", "revert", "verifyJPEG": return try await media.handle(action, args: args)
        case "importImage": return try await importer.importImage(args)
        default: throw HostError("지원하지 않는 명령입니다: \(action)")
        }
    }

    private func showSetup() {
        if let window { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); refreshStatus(); return }
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 640),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Mac 사진 자동화 설정"
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "Mac 사진 자동화 권한")
        title.font = .boldSystemFont(ofSize: 22); stack.addArrangedSubview(title)
        let explanation = NSTextField(wrappingLabelWithString: "아래 권한을 하나씩 요청하고 허용하세요. 이미 거부한 권한은 팝업이 다시 뜨지 않을 수 있습니다. 이때는 옆의 설정 열기에서 ‘MacPhotosBridge’ 또는 ‘Mac 사진 자동화’를 켜세요.")
        stack.addArrangedSubview(explanation)
        let label = NSTextField(wrappingLabelWithString: ""); label.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        stack.addArrangedSubview(label); statusLabel = label
        for (title, request, settings) in [
            ("손쉬운 사용", #selector(requestAccessibility), #selector(openAccessibilitySettings)),
            ("화면 기록", #selector(requestScreenCapture), #selector(openScreenCaptureSettings)),
            ("사진 전체 접근", #selector(requestPhotoLibrary), #selector(openPhotosSettings)),
            ("자동화 → 사진", #selector(requestPhotosAutomation), #selector(openAutomationSettings))] {
            let row = NSStackView(); row.orientation = .horizontal; row.spacing = 12
            let requestButton = NSButton(title: "\(title) 요청", target: self, action: request)
            requestButton.widthAnchor.constraint(equalToConstant: 240).isActive = true
            let settingsButton = NSButton(title: "\(title) 설정 열기", target: self, action: settings)
            row.addArrangedSubview(requestButton); row.addArrangedSubview(settingsButton)
            stack.addArrangedSubview(row)
        }
        let notice = NSTextField(wrappingLabelWithString: "화면 기록 목록에 앱이 없으면 요청 버튼을 누른 뒤 설정에서 +로 앱을 추가하세요. ‘현재 앱 Finder에서 보기’로 실제 앱 위치를 확인할 수 있습니다.")
        notice.font = .systemFont(ofSize: 12)
        notice.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        stack.addArrangedSubview(notice); permissionNoticeLabel = notice
        stack.addArrangedSubview(NSButton(title: "현재 앱 Finder에서 보기", target: self, action: #selector(revealHelper)))
        stack.addArrangedSubview(NSTextField(wrappingLabelWithString: "재빌드 후 권한이 꼬였으면 아래 버튼으로 이 도우미의 네 권한만 초기화하세요. 앱이 종료되면 설정 커맨드를 다시 실행하고 위 권한을 다시 허용하세요."))
        stack.addArrangedSubview(NSButton(title: "이 앱 권한 초기화 후 종료", target: self, action: #selector(resetPermissions)))
        stack.addArrangedSubview(NSTextField(wrappingLabelWithString: "창을 숨겨도 메뉴 막대의 ‘사진 자동화 → 설정 창 열기’에서 다시 열 수 있습니다. 앱을 다시 실행하거나 설정 커맨드를 실행해도 열립니다."))
        let footer = NSStackView(); footer.orientation = .horizontal; footer.spacing = 12
        for (title, action) in [("상태 새로고침", #selector(refreshStatus)), ("설정 창 숨기기", #selector(closeSetup)), ("보조 앱 종료", #selector(quitHelper))] {
            footer.addArrangedSubview(NSButton(title: title, target: self, action: action))
        }
        stack.addArrangedSubview(footer)
        panel.contentView?.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: panel.contentView!.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: panel.contentView!.bottomAnchor, constant: -24)])
        panel.center(); window = panel; panel.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); refreshStatus()
    }

    private func permissionActionAllowed(forReset: Bool = false) -> Bool {
        guard !permissionsNeedRestart else {
            permissionNoticeLabel?.stringValue = "권한을 초기화했습니다. 보조 앱 종료 후 설정 커맨드를 다시 실행해야 새 권한을 요청할 수 있습니다."
            return false
        }
        guard let root else { permissionNoticeLabel?.stringValue = "도우미 초기화 오류를 먼저 해결하세요."; return false }
        do {
            let project = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
            try PermissionRegistration.ensureIdle(ipcRoot: root, projectRoot: project, helperBusy: busy || permissionBusy,
                allowPendingRecovery: !forReset)
            return true
        } catch { permissionNoticeLabel?.stringValue = error.localizedDescription; return false }
    }

    @objc private func requestAccessibility() {
        guard permissionActionAllowed() else { return }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let granted = AXIsProcessTrustedWithOptions(options)
        permissionNoticeLabel?.stringValue = granted ? "손쉬운 사용이 허용되어 있습니다." : "손쉬운 사용 설정에서 이 도우미를 켜세요. 이전 앱 항목이 남아 있으면 권한 초기화 후 다시 등록하세요."
        if !granted { openPrivacySettings("Privacy_Accessibility") }
        refreshStatus()
    }

    @objc private func requestScreenCapture() {
        guard permissionActionAllowed() else { return }
        let granted = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
        permissionNoticeLabel?.stringValue = granted ? "화면 기록이 허용되어 있습니다." : "화면 기록 요청을 보냈습니다. 팝업이 없으면 열린 설정에서 이 앱을 켜거나 +로 추가하세요. 변경 후 보조 앱을 종료하고 다시 실행하세요."
        if !granted { openPrivacySettings("Privacy_ScreenCapture") }
        refreshStatus()
    }

    @objc private func requestPhotoLibrary() {
        guard permissionActionAllowed() else { return }
        permissionBusy = true
        Task { @MainActor in
            defer { permissionBusy = false }
            let authorization = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            permissionNoticeLabel?.stringValue = authorization == .authorized ? "사진 전체 접근이 허용되어 있습니다." : "사진 설정에서 이 도우미의 전체 접근을 허용하세요. 제한된 사진 선택으로는 자동화를 실행할 수 없습니다."
            if authorization != .authorized { openPrivacySettings("Privacy_Photos") }
            refreshStatus()
        }
    }

    @objc private func requestPhotosAutomation() {
        guard permissionActionAllowed() else { return }
        permissionBusy = true
        defer { permissionBusy = false }
        do {
            _ = try PhotosScripting.handle("selection", args: [:])
            permissionNoticeLabel?.stringValue = "자동화 → 사진 접근을 확인했습니다. 사진은 변경하지 않았습니다."
        } catch {
            permissionNoticeLabel?.stringValue = "자동화 → 사진 요청 결과: \(error.localizedDescription)\n설정에서 이 도우미 아래의 사진을 허용하세요."
            openPrivacySettings("Privacy_Automation")
        }
        refreshStatus()
    }

    private func openPrivacySettings(_ pane: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)"), NSWorkspace.shared.open(url) else {
            permissionNoticeLabel?.stringValue = "시스템 설정 → 개인정보 보호 및 보안에서 해당 권한을 직접 열어 주세요."
            return
        }
    }
    @objc private func openAccessibilitySettings() { if permissionActionAllowed() { openPrivacySettings("Privacy_Accessibility") } }
    @objc private func openScreenCaptureSettings() { if permissionActionAllowed() { openPrivacySettings("Privacy_ScreenCapture") } }
    @objc private func openPhotosSettings() { if permissionActionAllowed() { openPrivacySettings("Privacy_Photos") } }
    @objc private func openAutomationSettings() { if permissionActionAllowed() { openPrivacySettings("Privacy_Automation") } }
    @objc private func revealHelper() { NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL]) }

    @objc private func resetPermissions() {
        guard permissionActionAllowed(forReset: true), Bundle.main.bundleIdentifier == PermissionRegistration.bundleID else { return }
        permissionBusy = true
        permissionNoticeLabel?.stringValue = "이 도우미의 권한 기록을 초기화하고 있습니다. 완료되면 앱이 종료됩니다. 설정 커맨드를 다시 실행해 권한을 요청하세요."
        Task { @MainActor in
            let results = await PermissionRegistration.reset()
            permissionsNeedRestart = true
            permissionBusy = false
            if results.allSatisfy(\.succeeded) { NSApp.terminate(nil) }
            else {
                permissionNoticeLabel?.stringValue = "일부 권한을 초기화하지 못했습니다. \(results.filter { !$0.succeeded }.map { "\($0.service): \($0.message ?? "실패")" }.joined(separator: "; "))\n보조 앱을 종료한 뒤 설정 커맨드로 다시 실행하세요."
            }
        }
    }

    @objc private func refreshStatus() {
        let current = status()
        let granted: (String) -> String = { current[$0] as? Bool == true ? "허용" : "설정 필요" }
        let photos = current["photos"] as? String == "authorized" ? "전체 접근 허용" : "설정 필요"
        statusLabel?.stringValue = "손쉬운 사용: \(granted("accessibility"))   화면 기록: \(granted("screenCapture"))\n사진: \(photos)   자동화 → 사진: \(granted("photosAutomation"))\n권한 변경 후에도 설정 필요로 나오면 보조 앱을 종료하고 다시 실행하세요."
    }
    @objc private func closeSetup() { window?.orderOut(nil) }
    @objc private func quitHelper() {
        guard !busy, !permissionBusy else {
            statusLabel?.stringValue = "작업 처리 중에는 종료할 수 없습니다. 현재 요청이 끝난 뒤 다시 시도하세요."
            return
        }
        NSApp.terminate(nil)
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        busy || permissionBusy ? .terminateCancel : .terminateNow
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
