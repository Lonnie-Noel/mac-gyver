import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers
import Darwin

struct UIError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { "\(code): \(message)" }
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

@MainActor
final class PhotosUI {
    private let photosBundleID = "com.apple.Photos"
    private let maximumNodes = 8_000
    private let maximumDepth = 40

    private struct Entry {
        let element: AXUIElement
        let fields: [String: Any]
    }

    private struct Tree {
        let application: NSRunningApplication
        let windowElement: AXUIElement
        let windowRect: CGRect
        let windowTitle: String
        var entries: [Entry]
        var truncated: Bool
    }

    func snapshot() throws -> [String: Any] {
        let tree = try readTree()
        return ["frontmost": isFrontmost(tree.application), "appPid": Int(tree.application.processIdentifier),
            "window": ["title": tree.windowTitle, "rect": dictionary(tree.windowRect)],
            "nodes": tree.entries.map(\.fields), "truncated": tree.truncated]
    }

    func press(_ args: [String: Any]) throws -> [String: Any] {
        let tree = try actionTree(args)
        guard let selector = args["selector"] as? [String: Any], !selector.isEmpty else {
            throw UIError("INVALID_SELECTOR", "selector 속성이 필요합니다.")
        }
        let allowedKeys: Set<String> = ["role", "subrole", "identifier", "title", "description", "value", "enabled", "selected", "path", "parent"]
        let identityKeys: Set<String> = ["role", "subrole", "identifier", "title", "description", "value"]
        guard Set(selector.keys).isSubset(of: allowedKeys), !Set(selector.keys).isDisjoint(with: identityKeys),
              selector.values.allSatisfy({ scalar($0) != nil }) else {
            throw UIError("INVALID_SELECTOR", "지원하는 단일 값 속성만 selector에 사용할 수 있습니다.")
        }
        let matches = tree.entries.filter { entry in
            selector.allSatisfy { key, expected in
                guard let actual = entry.fields[key] else { return false }
                return scalarEqual(actual, expected)
            }
        }
        guard matches.count == 1, let match = matches.first else {
            throw UIError("AMBIGUOUS_SELECTOR", "현재 화면에서 selector와 일치하는 요소가 \(matches.count)개입니다.")
        }
        guard match.fields["enabled"] as? Bool == true else {
            throw UIError("DISABLED_ELEMENT", "선택한 화면 요소가 비활성 상태입니다.")
        }
        var actions: CFArray?
        let actionResult = AXUIElementCopyActionNames(match.element, &actions)
        guard actionResult == .success, let actionNames = actions as? [String], actionNames.contains(kAXPressAction as String) else {
            throw UIError("PRESS_UNSUPPORTED", "선택한 요소가 AXPress 동작을 제공하지 않습니다.")
        }
        try requireFrontmost(tree.application)
        try requireUnchangedWindow(tree)
        let result = AXUIElementPerformAction(match.element, kAXPressAction as CFString)
        guard result == .success else { throw UIError("AX_PRESS_FAILED", "AXPress 실패: \(result.rawValue)") }
        return ["pressed": true, "path": match.fields["path"] ?? "", "appPid": Int(tree.application.processIdentifier)]
    }

    func drag(_ args: [String: Any]) async throws -> [String: Any] {
        let tree = try actionTree(args)
        guard CGPreflightPostEventAccess() else { throw UIError("EVENT_ACCESS_REQUIRED", "마우스 제어 권한이 필요합니다.") }
        let from = try point(args["from"], name: "from")
        let to = try point(args["to"], name: "to")
        let allowed = try rectangle(args["allowedRect"], name: "allowedRect")
        guard let duration = number(args["durationMs"]), duration >= 100, duration <= 10_000 else {
            throw UIError("INVALID_DRAG", "durationMs는 100~10000 범위여야 합니다.")
        }
        guard contains(tree.windowRect, allowed), allowed.contains(from), allowed.contains(to),
              to.x < from.x, to.y > from.y, abs((from.x - to.x) - (to.y - from.y)) <= 1 else {
            throw UIError("INVALID_DRAG", "드래그는 Photos 창의 allowedRect 안에서 왼쪽 아래 45도로 이동해야 합니다.")
        }
        guard pointIsOnDisplay(from), pointIsOnDisplay(to) else {
            throw UIError("OFFSCREEN_DRAG", "드래그 지점이 활성 디스플레이 밖에 있습니다.")
        }
        let source = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left),
              let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: from, mouseButton: .left) else {
            throw UIError("EVENT_CREATION_FAILED", "마우스 누르기 이벤트를 만들지 못했습니다.")
        }
        try Task.checkCancellation()
        try requireFrontmost(tree.application)
        try requireUnchangedWindow(tree)
        var lastPosition = from
        down.post(tap: .cghidEventTap)
        // Release even if focus changes, geometry changes, or the task is cancelled.
        defer {
            up.location = lastPosition
            up.post(tap: .cghidEventTap)
        }
        let steps = max(2, min(120, Int(ceil(duration / 16))))
        let started = ProcessInfo.processInfo.systemUptime
        for step in 1...steps {
            let planned = duration / 1000 * Double(step) / Double(steps)
            let remaining = planned - (ProcessInfo.processInfo.systemUptime - started)
            if remaining > 0 { try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000)) }
            try Task.checkCancellation()
            try requireFrontmost(tree.application)
            try requireUnchangedWindow(tree)
            let fraction = CGFloat(step) / CGFloat(steps)
            let position = CGPoint(x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction)
            guard pointIsOnDisplay(position) else { throw UIError("OFFSCREEN_DRAG", "드래그 경로가 활성 디스플레이를 벗어났습니다.") }
            guard let event = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged,
                mouseCursorPosition: position, mouseButton: .left) else {
                throw UIError("EVENT_CREATION_FAILED", "마우스 드래그 이벤트를 만들지 못했습니다.")
            }
            event.post(tap: .cghidEventTap)
            lastPosition = position
        }
        return ["dragged": true, "durationMs": duration, "from": ["x": from.x, "y": from.y], "to": ["x": to.x, "y": to.y]]
    }

    func capture(_ args: [String: Any]) async throws -> [String: Any] {
        let tree = try actionTree(args)
        guard CGPreflightScreenCaptureAccess() else {
            throw UIError("SCREEN_ACCESS_REQUIRED", "사진 창 캡처 권한이 필요합니다.")
        }
        guard let filename = args["path"] as? String, filename.hasPrefix("/"), !filename.contains("\0"),
              (filename as NSString).pathExtension.lowercased() == "png" else {
            throw UIError("INVALID_OUTPUT", "PNG의 절대 출력 경로가 필요합니다.")
        }
        let output = URL(fileURLWithPath: filename).standardizedFileURL
        try validateOutput(output)
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let candidates = content.windows.filter {
            $0.owningApplication?.processID == tree.application.processIdentifier && $0.isOnScreen
                && $0.windowLayer == 0 && sameRect($0.frame, tree.windowRect)
        }
        guard candidates.count == 1, let window = candidates.first else {
            throw UIError("AMBIGUOUS_CAPTURE_WINDOW", "Photos의 현재 창과 일치하는 캡처 대상이 \(candidates.count)개입니다.")
        }
        try requireFrontmost(tree.application)
        try requireUnchangedWindow(tree)
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.captureResolution = .best
        configuration.width = Int((filter.contentRect.width * CGFloat(filter.pointPixelScale)).rounded(.up))
        configuration.height = Int((filter.contentRect.height * CGFloat(filter.pointPixelScale)).rounded(.up))
        guard configuration.width > 0, configuration.height > 0,
              configuration.width <= 32_768, configuration.height <= 32_768 else {
            throw UIError("INVALID_CAPTURE_SIZE", "Photos 캡처 크기가 유효하지 않습니다.")
        }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        try requireFrontmost(tree.application)
        try requireUnchangedWindow(tree)
        let encoded = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(encoded, UTType.png.identifier as CFString, 1, nil) else {
            throw UIError("PNG_ENCODING_FAILED", "PNG 인코더를 만들지 못했습니다.")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw UIError("PNG_ENCODING_FAILED", "PNG 저장 데이터 생성에 실패했습니다.") }
        try writeExclusive(encoded as Data, to: output)
        return ["captured": true, "path": output.path, "width": image.width, "height": image.height,
            "windowID": Int(window.windowID), "windowRect": dictionary(tree.windowRect),
            "contentRect": dictionary(filter.contentRect), "pointPixelScale": filter.pointPixelScale]
    }

    private func readTree() throws -> Tree {
        guard AXIsProcessTrusted() else { throw UIError("ACCESSIBILITY_REQUIRED", "Photos 화면을 읽고 조작하려면 접근성 권한이 필요합니다.") }
        let applications = NSRunningApplication.runningApplications(withBundleIdentifier: photosBundleID).filter { !$0.isTerminated }
        guard applications.count == 1, let application = applications.first else {
            throw UIError("PHOTOS_NOT_RUNNING", "실행 중인 Photos 앱을 하나로 식별할 수 없습니다.")
        }
        let appElement = AXUIElementCreateApplication(application.processIdentifier)
        guard AXUIElementSetMessagingTimeout(appElement, 2) == .success else {
            throw UIError("AX_TIMEOUT_SETUP_FAILED", "Photos 접근성 통신 제한 시간을 설정하지 못했습니다.")
        }
        guard let mainWindow = try elementAttribute(appElement, kAXMainWindowAttribute as String),
              let windowRect = try elementRect(mainWindow) else {
            throw UIError("NO_MAIN_WINDOW", "Photos의 주 창과 위치를 확인하지 못했습니다.")
        }
        let mainFlag = try attribute(mainWindow, kAXMainAttribute as String) as? Bool
        guard mainFlag == true else { throw UIError("NO_MAIN_WINDOW", "선택한 Photos 창이 주 창이 아닙니다.") }
        let windowTitle = try attribute(mainWindow, kAXTitleAttribute as String) as? String ?? ""
        var tree = Tree(application: application, windowElement: mainWindow, windowRect: windowRect,
            windowTitle: windowTitle, entries: [], truncated: false)
        var seen: Set<CFHashCode> = []
        try append(mainWindow, path: "window", parent: nil, depth: 0, tree: &tree, seen: &seen)
        if let menuBar = try elementAttribute(appElement, kAXMenuBarAttribute as String) {
            try append(menuBar, path: "menuBar", parent: nil, depth: 0, tree: &tree, seen: &seen)
        }
        return tree
    }

    private func append(_ element: AXUIElement, path: String, parent: String?, depth: Int,
                        tree: inout Tree, seen: inout Set<CFHashCode>) throws {
        guard tree.entries.count < maximumNodes, depth <= maximumDepth else { tree.truncated = true; return }
        guard seen.insert(CFHash(element)).inserted else { tree.truncated = true; return }
        var fields: [String: Any] = ["path": path, "role": try attribute(element, kAXRoleAttribute as String) as? String ?? "AXUnknown",
            "enabled": try attribute(element, kAXEnabledAttribute as String) as? Bool ?? false]
        if let parent { fields["parent"] = parent }
        for (key, name) in [("subrole", kAXSubroleAttribute as String), ("identifier", kAXIdentifierAttribute as String),
                            ("title", kAXTitleAttribute as String), ("description", kAXDescriptionAttribute as String),
                            ("value", kAXValueAttribute as String), ("selected", kAXSelectedAttribute as String)] {
            if let value = try attribute(element, name), let plain = scalar(value) { fields[key] = plain }
        }
        if let rect = try elementRect(element) { fields["rect"] = dictionary(rect) }
        tree.entries.append(Entry(element: element, fields: fields))
        let children = try attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] ?? []
        for (index, child) in children.enumerated() {
            if tree.entries.count >= maximumNodes { tree.truncated = true; break }
            try append(child, path: "\(path)/\(index)", parent: path, depth: depth + 1, tree: &tree, seen: &seen)
        }
    }

    private func actionTree(_ args: [String: Any]) throws -> Tree {
        let tree = try readTree()
        guard !tree.truncated else { throw UIError("TRUNCATED_UI", "화면 구조가 잘려 있어 조작하지 않습니다.") }
        try requireFrontmost(tree.application)
        if let expected = args["expectedWindow"] {
            let expectedRect = try rectangle(expected, name: "expectedWindow")
            guard sameRect(tree.windowRect, expectedRect) else { throw UIError("WINDOW_CHANGED", "Photos 창 위치 또는 크기가 변경되었습니다.") }
        }
        return tree
    }

    private func attribute(_ element: AXUIElement, _ name: String) throws -> Any? {
        var result: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, name as CFString, &result)
        if status == .attributeUnsupported || status == .noValue { return nil }
        guard status == .success else { throw UIError("AX_READ_FAILED", "\(name) 조회 실패: \(status.rawValue)") }
        return result
    }

    private func elementAttribute(_ element: AXUIElement, _ name: String) throws -> AXUIElement? {
        guard let value = try attribute(element, name) else { return nil }
        guard CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() else {
            throw UIError("INVALID_AX_TYPE", "\(name)의 접근성 요소 형식이 잘못되었습니다.")
        }
        return unsafeBitCast(value as CFTypeRef, to: AXUIElement.self)
    }

    private func elementRect(_ element: AXUIElement) throws -> CGRect? {
        guard let position = try attribute(element, kAXPositionAttribute as String),
              let size = try attribute(element, kAXSizeAttribute as String),
              CFGetTypeID(position as CFTypeRef) == AXValueGetTypeID(), CFGetTypeID(size as CFTypeRef) == AXValueGetTypeID() else { return nil }
        let positionValue = unsafeBitCast(position as CFTypeRef, to: AXValue.self)
        let sizeValue = unsafeBitCast(size as CFTypeRef, to: AXValue.self)
        var point = CGPoint.zero
        var dimensions = CGSize.zero
        guard AXValueGetType(positionValue) == .cgPoint, AXValueGetType(sizeValue) == .cgSize,
              AXValueGetValue(positionValue, .cgPoint, &point), AXValueGetValue(sizeValue, .cgSize, &dimensions),
              [point.x, point.y, dimensions.width, dimensions.height].allSatisfy(\.isFinite),
              dimensions.width > 0, dimensions.height > 0 else { return nil }
        return CGRect(origin: point, size: dimensions)
    }

    private func isFrontmost(_ application: NSRunningApplication) -> Bool {
        NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier && !application.isTerminated
    }

    private func requireFrontmost(_ application: NSRunningApplication) throws {
        guard isFrontmost(application) else { throw UIError("PHOTOS_NOT_FRONTMOST", "Photos가 전면 앱이 아니므로 입력을 중단했습니다.") }
    }

    private func requireUnchangedWindow(_ tree: Tree) throws {
        let app = AXUIElementCreateApplication(tree.application.processIdentifier)
        guard let current = try elementAttribute(app, kAXMainWindowAttribute as String),
              CFEqual(current, tree.windowElement), let rect = try elementRect(current), sameRect(rect, tree.windowRect) else {
            throw UIError("WINDOW_CHANGED", "Photos의 주 창 또는 위치가 변경되었습니다.")
        }
    }

    private func scalar(_ value: Any) -> Any? {
        if let string = value as? String { return string }
        if let number = value as? NSNumber, number.doubleValue.isFinite { return number }
        return nil
    }

    private func scalarEqual(_ first: Any, _ second: Any) -> Bool {
        if let a = first as? String, let b = second as? String { return a == b }
        guard let a = first as? NSNumber, let b = second as? NSNumber else { return false }
        let aBoolean = CFGetTypeID(a) == CFBooleanGetTypeID()
        let bBoolean = CFGetTypeID(b) == CFBooleanGetTypeID()
        return aBoolean == bBoolean && a == b
    }

    private func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return number.doubleValue
    }

    private func point(_ value: Any?, name: String) throws -> CGPoint {
        guard let fields = value as? [String: Any], let x = number(fields["x"]), let y = number(fields["y"]) else {
            throw UIError("INVALID_GEOMETRY", "\(name)에 유효한 x, y가 필요합니다.")
        }
        return CGPoint(x: x, y: y)
    }

    private func rectangle(_ value: Any?, name: String) throws -> CGRect {
        guard let fields = value as? [String: Any], let x = number(fields["x"]), let y = number(fields["y"]),
              let width = number(fields["width"]), let height = number(fields["height"]), width > 0, height > 0,
              [x + width, y + height].allSatisfy(\.isFinite) else {
            throw UIError("INVALID_GEOMETRY", "\(name)에 유효한 x, y, width, height가 필요합니다.")
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private func dictionary(_ rect: CGRect) -> [String: Double] {
        ["x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)]
    }

    private func sameRect(_ first: CGRect, _ second: CGRect) -> Bool {
        abs(first.minX - second.minX) <= 1 && abs(first.minY - second.minY) <= 1
            && abs(first.width - second.width) <= 1 && abs(first.height - second.height) <= 1
    }

    private func contains(_ outer: CGRect, _ inner: CGRect) -> Bool {
        inner.minX >= outer.minX && inner.minY >= outer.minY && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY
    }

    private func pointIsOnDisplay(_ point: CGPoint) -> Bool {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return false }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &displays, &count) == .success else { return false }
        return displays.prefix(Int(count)).contains { CGDisplayBounds($0).contains(point) }
    }

    private func validateOutput(_ output: URL) throws {
        let parent = output.deletingLastPathComponent()
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: parent.path, isDirectory: &directory), directory.boolValue,
              parent.resolvingSymlinksInPath().path == parent.path else {
            throw UIError("INVALID_OUTPUT", "출력 폴더가 없거나 심볼릭 링크를 포함합니다.")
        }
        var status = stat()
        if lstat(output.path, &status) == 0 { throw UIError("OUTPUT_EXISTS", "기존 PNG 또는 심볼릭 링크를 덮어쓰지 않습니다.") }
        guard errno == ENOENT else { throw UIError("INVALID_OUTPUT", "출력 경로 상태를 확인하지 못했습니다.") }
    }

    private func writeExclusive(_ data: Data, to output: URL) throws {
        try validateOutput(output)
        let parent = output.deletingLastPathComponent()
        let temporary = parent.appendingPathComponent(".capture-\(UUID().uuidString).tmp")
        let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw UIError("OUTPUT_WRITE_FAILED", "임시 PNG 파일을 만들지 못했습니다.") }
        defer { Darwin.close(fd); Darwin.unlink(temporary.path) }
        try data.withUnsafeBytes { bytes in
            guard let start = bytes.baseAddress else { throw UIError("OUTPUT_WRITE_FAILED", "PNG 데이터가 비어 있습니다.") }
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(fd, start.advanced(by: offset), bytes.count - offset)
                if written < 0 && errno == EINTR { continue }
                guard written > 0 else { throw UIError("OUTPUT_WRITE_FAILED", "PNG 파일 기록을 완료하지 못했습니다.") }
                offset += written
            }
        }
        guard Darwin.fsync(fd) == 0 else { throw UIError("OUTPUT_WRITE_FAILED", "PNG 파일 동기화에 실패했습니다.") }
        try validateOutput(output)
        guard Darwin.link(temporary.path, output.path) == 0 else {
            throw UIError(errno == EEXIST ? "OUTPUT_EXISTS" : "OUTPUT_WRITE_FAILED", "PNG 결과 파일을 독점적으로 저장하지 못했습니다.")
        }
        let directory = Darwin.open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard directory >= 0 else { throw UIError("OUTPUT_WRITE_FAILED", "출력 폴더 동기화를 준비하지 못했습니다.") }
        defer { Darwin.close(directory) }
        guard Darwin.fsync(directory) == 0 else { throw UIError("OUTPUT_WRITE_FAILED", "출력 폴더 동기화에 실패했습니다.") }
    }
}
