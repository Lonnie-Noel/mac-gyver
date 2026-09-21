import ApplicationServices

enum AXReadPolicy {
    static func canOmit(_ status: AXError, attribute: String) -> Bool {
        if status == .attributeUnsupported || status == .noValue { return true }
        // Some Photos elements report generic failure for their optional
        // subrole. Keep the element and its other attributes in the snapshot.
        // Never suppress failed role/geometry/tree reads or transport errors.
        return status == .failure && attribute == kAXSubroleAttribute as String
    }
}
