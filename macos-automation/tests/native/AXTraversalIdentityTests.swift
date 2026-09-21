import Foundation
import CoreFoundation
import ApplicationServices

@main
struct AXTraversalIdentityTests {
    static func main() {
        // Force every object into one bucket. Unequal objects must all survive.
        var collisions = AXTraversalIdentity(hash: { _ in 7 })
        let first = CFStringCreateWithCString(nil, "first", CFStringBuiltInEncodings.UTF8.rawValue)!
        let second = CFStringCreateWithCString(nil, "second", CFStringBuiltInEncodings.UTF8.rawValue)!
        let firstAgain = CFStringCreateWithCString(nil, "first", CFStringBuiltInEncodings.UTF8.rawValue)!
        precondition(collisions.visit(first, path: "window/0") == nil)
        precondition(collisions.visit(second, path: "window/1") == nil)
        precondition(collisions.visit(firstAgain, path: "window/2") == "window/0")
        precondition(collisions.visit(second, path: "menuBar/0") == "window/1")
        precondition(collisions.visit(first, path: "window/0/0") == "window/0")

        // AX references are local handles; creating them does not query an app.
        // Separate wrappers for the same application must count as a repeat.
        let app = AXUIElementCreateApplication(12345)
        let sameApp = AXUIElementCreateApplication(12345)
        let otherApp = AXUIElementCreateApplication(12346)
        precondition(CFEqual(app, sameApp))
        precondition(!CFEqual(app, otherApp))
        var references = AXTraversalIdentity(hash: { _ in 0 })
        precondition(references.visit(app, path: "window") == nil)
        precondition(references.visit(otherApp, path: "menuBar") == nil)
        precondition(references.visit(sameApp, path: "window/0/0") == "window")

        // Also exercise the production CFHash path, including repeated handles.
        var normal = AXTraversalIdentity()
        precondition(normal.visit(app, path: "root") == nil)
        precondition(normal.visit(sameApp, path: "root/child") == "root")
        precondition(normal.visit(otherApp, path: "other") == nil)
        print("AXTraversalIdentity regression checks passed")
    }
}
