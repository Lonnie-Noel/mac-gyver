import CoreFoundation

// A hash selects a bucket; CFEqual decides whether an AX object was visited.
// Keep the original object alive throughout traversal so identity comparisons
// remain valid, and retain its path for repeated-element diagnostics.
struct AXTraversalIdentity {
    private struct Visit {
        let element: CFTypeRef
        let path: String
    }

    private var buckets: [CFHashCode: [Visit]] = [:]
    private let hash: (CFTypeRef) -> CFHashCode

    init(hash: @escaping (CFTypeRef) -> CFHashCode = { CFHash($0) }) {
        self.hash = hash
    }

    // Returns the first path for a repeated equal object; otherwise records it.
    mutating func visit(_ element: CFTypeRef, path: String) -> String? {
        let code = hash(element)
        if let first = buckets[code]?.first(where: { CFEqual($0.element, element) }) {
            return first.path
        }
        buckets[code, default: []].append(Visit(element: element, path: path))
        return nil
    }
}
