import Foundation

// BSD-118: Settings → Developer → "Install command line". The Mac app ships the `based` binary in
// Contents/Helpers (build phase in project.yml); installing means a symlink in a bin folder on the PATH. The
// decisions (which folder, what is installed now, the Terminal command for a sandboxed build) live here and are
// tested; the app only performs the symlink or shows the command.
public enum CLIInstall {
    /// Where the link goes and how to make it by hand.
    public struct Plan: Equatable, Sendable {
        public var directory: String
        public var linkPath: String
        /// `mkdir -p … && ln -sf …` for Terminal (sandboxed builds can't write outside their container).
        public var shellCommand: String
        /// The folder is not one a login shell has on the PATH by default.
        public var needsPathHint: Bool
        public var pathHint: String? {
            needsPathHint ? "If `based` isn't found, add  export PATH=\"\(directory):$PATH\"  to ~/.zshrc" : nil
        }
    }

    public enum State: Equatable, Sendable {
        case notInstalled
        /// The link exists and points at this app's binary.
        case installed(String)
        /// Something else lives at the link path (another build, a copied binary) — "Install" replaces a link only.
        case other(String)
    }

    /// Single-quoted for /bin/sh.
    public static func quote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    /// /usr/local/bin when it is writable, otherwise ~/.local/bin (never asks for an admin password).
    public static func plan(helper: String, home: String, isWritable: (String) -> Bool) -> Plan {
        let system = "/usr/local/bin"
        let dir = isWritable(system) ? system : home + "/.local/bin"
        let link = dir + "/based"
        let cmd = "mkdir -p \(quote(dir)) && ln -sf \(quote(helper)) \(quote(link))"
        return Plan(directory: dir, linkPath: link, shellCommand: cmd, needsPathHint: dir != system)
    }

    /// What is at `linkPath` now. `destination` reads a symlink (nil = no link), `exists` checks any file.
    public static func state(linkPath: String, helper: String, destination: (String) -> String?, exists: (String) -> Bool) -> State {
        if let d = destination(linkPath) {
            let joined = d.hasPrefix("/") ? d : ((linkPath as NSString).deletingLastPathComponent as NSString).appendingPathComponent(d)
            let resolved = (joined as NSString).standardizingPath
            return resolved == (helper as NSString).standardizingPath ? .installed(linkPath) : .other(resolved)
        }
        return exists(linkPath) ? .other(linkPath) : .notInstalled
    }

    /// Creates or replaces the symlink (never overwrites a regular file). Throws CLIError with a readable message.
    public static func install(_ plan: Plan, helper: String, fileManager fm: FileManager = .default) throws {
        guard fm.isExecutableFile(atPath: helper) else {
            throw CLIError("This build has no command line binary (Contents/Helpers/based). Build with `make install-cli` instead.")
        }
        try fm.createDirectory(atPath: plan.directory, withIntermediateDirectories: true)
        if (try? fm.destinationOfSymbolicLink(atPath: plan.linkPath)) != nil {
            try fm.removeItem(atPath: plan.linkPath)
        } else if fm.fileExists(atPath: plan.linkPath) {
            throw CLIError("\(plan.linkPath) already exists and is not a link — remove it first.")
        }
        try fm.createSymbolicLink(atPath: plan.linkPath, withDestinationPath: helper)
    }
}
