import ApplicationServices

@main
struct AXReadPolicyTests {
    static func main() {
        let subrole = kAXSubroleAttribute as String
        precondition(AXError.failure.rawValue == -25200)
        precondition(AXReadPolicy.canOmit(.failure, attribute: subrole))
        for name in [kAXRoleAttribute, kAXEnabledAttribute, kAXChildrenAttribute,
                     kAXMainWindowAttribute, kAXPositionAttribute, kAXSizeAttribute] {
            precondition(!AXReadPolicy.canOmit(.failure, attribute: name as String))
        }
        for status in [AXError.cannotComplete, .apiDisabled, .invalidUIElement, .illegalArgument, .success] {
            precondition(!AXReadPolicy.canOmit(status, attribute: subrole))
        }
        precondition(AXReadPolicy.canOmit(.attributeUnsupported, attribute: subrole))
        precondition(AXReadPolicy.canOmit(.noValue, attribute: subrole))
        print("AXReadPolicy regression checks passed")
    }
}
