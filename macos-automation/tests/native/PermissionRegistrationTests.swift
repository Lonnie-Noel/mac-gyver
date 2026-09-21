import Foundation

private actor RecordedCommands {
    var commands: [[String]] = []
    func run(_ arguments: [String], failScreen: Bool = false, throwPhotos: Bool = false) throws -> Int32 {
        commands.append(arguments)
        if throwPhotos && arguments[1] == "Photos" {
            throw PermissionRegistration.RegistrationError(message: "mock launch failure")
        }
        return failScreen && arguments[1] == "ScreenCapture" ? 9 : 0
    }
    func values() -> [[String]] { commands }
}

private struct Fixture {
    let root: URL
    let project: URL
    let ipc: URL
    var artifacts: URL { project.appendingPathComponent("artifacts") }
    var lease: URL { ipc.appendingPathComponent("workflow-lock.json") }
    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("macgyver-permission-test-\(UUID().uuidString)")
        project = root.appendingPathComponent("project")
        ipc = root.appendingPathComponent("ipc")
        try FileManager.default.createDirectory(at: project.appendingPathComponent("artifacts"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: ipc, withIntermediateDirectories: true)
    }
    func writeLease(_ changes: [String: Any] = [:]) throws {
        var object: [String: Any] = ["pid": 23456, "projectRoot": project.path,
            "pendingPath": artifacts.appendingPathComponent("pending-edit.json").path]
        for (key, value) in changes { object[key] = value }
        try JSONSerialization.data(withJSONObject: object).write(to: lease)
    }
    func clean() { try? FileManager.default.removeItem(at: root) }
}

@main
struct PermissionRegistrationTests {
    private static func assertBlocked(
        _ fixture: Fixture, busy: Bool = false, allowPendingRecovery: Bool = false,
        alive: @escaping (Int32) -> Bool = { _ in false }
    ) async {
        let calls = RecordedCommands()
        var blocked = false
        do {
            try PermissionRegistration.ensureIdle(ipcRoot: fixture.ipc, projectRoot: fixture.project,
                helperBusy: busy, allowPendingRecovery: allowPendingRecovery, processAlive: alive)
            _ = await PermissionRegistration.reset(execute: { try await calls.run($0) })
        } catch {
            blocked = true
            precondition(!error.localizedDescription.isEmpty)
        }
        let commands = await calls.values()
        precondition(blocked, "unsafe permission reset was allowed")
        precondition(commands.isEmpty, "guard rejection must happen before any reset")
    }

    static func main() async throws {
        for action in ["status", "showSetup"] {
            precondition(PermissionRegistration.canUseIPC(action, needsRestart: true))
        }
        for action in ["snapshot", "press", "drag", "capture", "selection", "importImage", "export", "revert", "unknown"] {
            precondition(!PermissionRegistration.canUseIPC(action, needsRestart: true))
            precondition(PermissionRegistration.canUseIPC(action, needsRestart: false))
        }
        let expected = ["Accessibility", "ScreenCapture", "Photos", "AppleEvents"].map {
            ["reset", $0, "local.macgyver.photosautomation"]
        }
        let successCalls = RecordedCommands()
        let successes = await PermissionRegistration.reset(execute: { try await successCalls.run($0) })
        let successCommands = await successCalls.values()
        precondition(successCommands == expected)
        precondition(successes.count == 4 && successes.allSatisfy(\.succeeded))
        precondition(successes.allSatisfy { $0.exitCode == 0 && $0.message == nil })

        let failureCalls = RecordedCommands()
        let failures = await PermissionRegistration.reset(execute: {
            try await failureCalls.run($0, failScreen: true, throwPhotos: true)
        })
        let failureCommands = await failureCalls.values()
        precondition(failureCommands == expected, "a failed service must not hide later results")
        precondition(failures.map(\.service) == expected.map { $0[1] })
        precondition(failures[0].succeeded && failures[3].succeeded)
        precondition(!failures[1].succeeded && failures[1].exitCode == 9)
        precondition(failures[1].message?.contains("9") == true)
        precondition(!failures[2].succeeded && failures[2].exitCode == nil)
        precondition(failures[2].message?.contains("mock launch failure") == true)

        // Invalid scopes reject before Process.run; no real reset is ever called.
        for invalid in [["reset", "All", PermissionRegistration.bundleID],
                        ["reset", "Photos", "com.other.app"],
                        ["reset", "Photos"], ["grant", "Photos", PermissionRegistration.bundleID]] {
            do {
                _ = try await PermissionRegistration.realTccutil(invalid)
                preconditionFailure("invalid reset scope reached process execution")
            } catch { }
        }

        do {
            let fixture = try Fixture(); defer { fixture.clean() }
            try PermissionRegistration.ensureIdle(ipcRoot: fixture.ipc, projectRoot: fixture.project,
                helperBusy: false, processAlive: { _ in false })
            await assertBlocked(fixture, busy: true)
            await assertBlocked(fixture, busy: true, allowPendingRecovery: true)
        }
        for marker in ["pending-edit.json", "active-run.json"] {
            let fixture = try Fixture(); defer { fixture.clean() }
            try Data("not JSON".utf8).write(to: fixture.artifacts.appendingPathComponent(marker))
            await assertBlocked(fixture)
            if marker == "pending-edit.json" {
                try PermissionRegistration.ensureIdle(ipcRoot: fixture.ipc, projectRoot: fixture.project,
                    helperBusy: false, allowPendingRecovery: true, processAlive: { _ in false })
            } else {
                await assertBlocked(fixture, allowPendingRecovery: true)
            }
        }
        do {
            let fixture = try Fixture(); defer { fixture.clean() }
            try fixture.writeLease()
            await assertBlocked(fixture, alive: { $0 == 23456 })
            await assertBlocked(fixture, allowPendingRecovery: true, alive: { $0 == 23456 })
            try PermissionRegistration.ensureIdle(ipcRoot: fixture.ipc, projectRoot: fixture.project,
                helperBusy: false, processAlive: { _ in false })
            precondition(FileManager.default.fileExists(atPath: fixture.lease.path), "stale lease must not be deleted")
        }
        do {
            let fixture = try Fixture(); defer { fixture.clean() }
            let foreign = fixture.root.appendingPathComponent("foreign-pending.json")
            try Data("{}".utf8).write(to: foreign)
            try fixture.writeLease(["projectRoot": fixture.root.appendingPathComponent("other-project").path,
                "pendingPath": foreign.path])
            await assertBlocked(fixture)
            try PermissionRegistration.ensureIdle(ipcRoot: fixture.ipc, projectRoot: fixture.project,
                helperBusy: false, allowPendingRecovery: true, processAlive: { _ in false })
            await assertBlocked(fixture, allowPendingRecovery: true, alive: { _ in true })
        }
        do {
            let fixture = try Fixture(); defer { fixture.clean() }
            let active = fixture.artifacts.appendingPathComponent("active-run.json")
            try JSONSerialization.data(withJSONObject: ["pid": 23456]).write(to: active)
            await assertBlocked(fixture)
            try PermissionRegistration.ensureIdle(ipcRoot: fixture.ipc, projectRoot: fixture.project,
                helperBusy: false, allowPendingRecovery: true, processAlive: { _ in false })
            await assertBlocked(fixture, allowPendingRecovery: true, alive: { _ in true })
            precondition(FileManager.default.fileExists(atPath: active.path), "stale active marker must remain")
        }
        for invalidPID: Any in [true, -1, 12.5, "23456", NSNull()] {
            let fixture = try Fixture(); defer { fixture.clean() }
            let active = fixture.artifacts.appendingPathComponent("active-run.json")
            try JSONSerialization.data(withJSONObject: ["pid": invalidPID]).write(to: active)
            await assertBlocked(fixture, allowPendingRecovery: true)
        }
        for malformed: [String: Any] in [["pid": true], ["pid": -1], ["pid": 12.5],
                ["pid": Int64(Int32.max) + 1], ["pid": "23456"], ["pendingPath": "relative"],
                ["projectRoot": "relative"], ["pendingPath": NSNull()]] {
            let fixture = try Fixture(); defer { fixture.clean() }
            try fixture.writeLease(malformed)
            await assertBlocked(fixture)
            await assertBlocked(fixture, allowPendingRecovery: true)
        }
        for contents in ["not JSON", "[]", "{}"] {
            let fixture = try Fixture(); defer { fixture.clean() }
            try Data(contents.utf8).write(to: fixture.lease)
            await assertBlocked(fixture)
            await assertBlocked(fixture, allowPendingRecovery: true)
        }
        do {
            let fixture = try Fixture(); defer { fixture.clean() }
            try FileManager.default.createDirectory(at: fixture.lease, withIntermediateDirectories: false)
            await assertBlocked(fixture)
        }
        do {
            let fixture = try Fixture(); defer { fixture.clean() }
            let target = fixture.root.appendingPathComponent("target.json")
            try Data("{}".utf8).write(to: target)
            try FileManager.default.createSymbolicLink(at: fixture.lease, withDestinationURL: target)
            await assertBlocked(fixture)
        }
        print("PermissionRegistration regression checks passed (mock resets only)")
    }
}
