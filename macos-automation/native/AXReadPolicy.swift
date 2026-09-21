import ApplicationServices

enum AXReadPolicy {
    static func canOmit(_ status: AXError, attribute: String) -> Bool {
        if status == .attributeUnsupported || status == .noValue { return true }
        // Some Photos elements report generic failure for their optional
        // subrole or description. Keep the element and its other attributes
        // in the snapshot. A selector requiring an omitted field cannot match.
        // Never suppress failed role/geometry/tree reads or transport errors.
        guard status == .failure else { return false }
        return attribute == kAXSubroleAttribute as String || attribute == kAXDescriptionAttribute as String
    }
}
