#if os(macOS) && canImport(SwiftTerm)
import SwiftUI
import AppKit
import SwiftTerm
import BasedCore
import BasedBrain

/// Real terminals (SwiftTerm) for agent sessions: `claude` / `codex` running interactively in the session's folder.
/// Views are cached per key so switching between Transcript and Terminal keeps the process and scrollback.
@MainActor
final class TerminalRegistry {
    static let shared = TerminalRegistry()
    private var views: [String: LocalProcessTerminalView] = [:]

    func view(key: String, cwd: String, command: String) -> LocalProcessTerminalView {
        if let v = views[key] { return v }
        let v = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 480))
        v.font = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
        var env = ShellEnvironment.environment()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["LANG"] = env["LANG"] ?? "en_US.UTF-8"
        let dir = cwd.hasPrefix("/") ? cwd : NSHomeDirectory()
        let quoted = "'" + dir.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let shell = env["SHELL"] ?? "/bin/zsh"
        v.startProcess(executable: shell, args: ["-l", "-c", "cd \(quoted) && exec \(command)"],
                       environment: env.map { "\($0.key)=\($0.value)" }, execName: nil)
        views[key] = v
        Log.info("terminal: \(command) in \(dir)", category: "agents")
        return v
    }

    func isRunning(_ key: String) -> Bool { views[key] != nil }

    func close(_ key: String) {
        views[key]?.terminate()
        views.removeValue(forKey: key)
    }
}

/// Hosts a cached terminal view; the first responder goes to the terminal so typing works immediately.
struct AgentTerminalView: NSViewRepresentable {
    let key: String
    let cwd: String
    let command: String

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        attach(to: container)
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        if container.subviews.first !== TerminalRegistry.shared.view(key: key, cwd: cwd, command: command) {
            container.subviews.forEach { $0.removeFromSuperview() }
            attach(to: container)
        }
    }

    private func attach(to container: NSView) {
        let term = TerminalRegistry.shared.view(key: key, cwd: cwd, command: command)
        term.removeFromSuperview()
        term.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(term)
        NSLayoutConstraint.activate([
            term.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 6),
            term.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -6),
            term.topAnchor.constraint(equalTo: container.topAnchor, constant: 4),
            term.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -4),
        ])
        DispatchQueue.main.async { term.window?.makeFirstResponder(term) }
    }
}
#endif
