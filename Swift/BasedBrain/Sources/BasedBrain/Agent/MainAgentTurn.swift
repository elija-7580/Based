import Foundation

// BSD-128: the home screen's input sends one message to the main agent with its own compute level, an exact model
// and a permission mode. These options apply to that message only; the main agent's defaults stay as they are.

/// Per-message options of the main agent's input field.
public struct MainTurnOptions: Equatable, Sendable {
    /// nil = the main agent's own level (Low).
    public var compute: ComputeLevel?
    /// Exact "provider/model"; "" = picked from the General route at `compute`.
    public var model: String
    /// nil = the permissions the main agent has anyway.
    public var permission: PermissionMode?

    public init(compute: ComputeLevel? = nil, model: String = "", permission: PermissionMode? = nil) {
        self.compute = compute; self.model = model; self.permission = permission
    }

    public static let `default` = MainTurnOptions()

    /// Short label for the field's menu ("Low", "Auto · Sonnet 5.5", "High · Plan mode").
    public var label: String {
        var parts: [String] = []
        if !model.isEmpty { parts.append(String(model.split(separator: "/").last ?? Substring(model))) }
        else { parts.append((compute ?? .low).title) }
        if let permission { parts.append(permission.title) }
        return parts.joined(separator: " · ")
    }
}

public extension MainAgent {
    /// Model, effort and level for one main-agent turn. An exact model that is configured wins (its effort stays
    /// the provider's); otherwise the General route at the chosen level (default: the agent's own Low).
    func turn(_ options: MainTurnOptions) -> (modelRef: String?, effort: String, compute: ComputeLevel) {
        let level = options.compute ?? compute
        if !options.model.isEmpty, options.model.contains("/"), runtime.registry.resolve(options.model) != nil {
            return (options.model, "", level)
        }
        let d = router.decision(routeID: "general", reason: "main agent", compute: level, forceLow: false,
                                registry: runtime.registry, installed: [], defaultModel: defaultModel)
        if case .model(let ref) = d.choice { return (ref, d.effort, level) }
        return (nil, "", level)
    }
}
