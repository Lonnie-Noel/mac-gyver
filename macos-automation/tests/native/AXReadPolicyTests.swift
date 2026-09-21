import ApplicationServices

@main
struct AXReadPolicyTests {
    static func main() {
        let optionalLabels = [kAXSubroleAttribute, kAXDescriptionAttribute].map { $0 as String }
        precondition(AXError.failure.rawValue == -25200)
        for name in optionalLabels {
            precondition(AXReadPolicy.canOmit(.failure, attribute: name))
            precondition(AXReadPolicy.canOmit(.attributeUnsupported, attribute: name))
            precondition(AXReadPolicy.canOmit(.noValue, attribute: name))
            for status in [AXError.cannotComplete, .apiDisabled, .invalidUIElement, .illegalArgument,
                           .notImplemented, .actionUnsupported, .invalidUIElementObserver, .success] {
                precondition(!AXReadPolicy.canOmit(status, attribute: name))
            }
        }
        for name in [kAXRoleAttribute, kAXEnabledAttribute, kAXChildrenAttribute,
                     kAXMainWindowAttribute, kAXMainAttribute, kAXPositionAttribute, kAXSizeAttribute,
                     kAXMenuBarAttribute, kAXParentAttribute, kAXIdentifierAttribute,
                     kAXTitleAttribute, kAXValueAttribute, kAXSelectedAttribute] {
            precondition(!AXReadPolicy.canOmit(.failure, attribute: name as String))
        }
        precondition(!AXReadPolicy.canOmit(.failure, attribute: "AXUnknownAttribute"))
        print("AXReadPolicy regression checks passed")
    }
}
