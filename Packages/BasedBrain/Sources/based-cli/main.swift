// BSD-54: `based` — the command line for a Based server (Developer option). All decisions live in
// BasedBrain/CLI/BasedCLI.swift (tested); this file is only I/O: argv, environment, config file, HTTP, stdin.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif
import BasedBrain

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data(("based: " + message + "\n").utf8))
    exit(code)
}

let env = ProcessInfo.processInfo.environment
let home = env["HOME"] ?? NSHomeDirectory()
let fm = FileManager.default

let parsed: (CLICommand, CLIOptions)
do { parsed = try CLIArguments.parse(Array(CommandLine.arguments.dropFirst())) }
catch { fail("\(error)", code: 2) }
let (command, options) = parsed

func readStdin() -> String {
    String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
}

switch command {
case .login(let url):
    // The token comes from stdin (pipe, or typed without echo) — never from argv.
    var token: String
    if isatty(0) != 0, let p = getpass("Token: ") { token = String(cString: p) } else { token = readStdin() }
    token = token.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !token.isEmpty else { fail("no token on stdin") }
    let path = CLIConfig.path(home: home)
    let dir = (path as NSString).deletingLastPathComponent
    do {
        try fm.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // Create with 0600 before writing the secret.
        if !fm.fileExists(atPath: path) { fm.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
        try Data(CLIConfig.fileContents(url: url, token: token).utf8).write(to: URL(fileURLWithPath: path))
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    } catch { fail("could not write \(path): \(error)") }
    print("Saved \(url) to \(path) (mode 600).")
    exit(0)
case .help, .version:
    break
default:
    break
}

let readFile: (String) -> String? = { p in (try? String(contentsOfFile: p, encoding: .utf8)) }
let fileMode: (String) -> Int? = { p in (try? fm.attributesOfItem(atPath: p)[.posixPermissions] as? NSNumber)?.intValue }

var config: CLIConfig?
if command != .help && command != .version {
    do { config = try CLIConfig.resolve(options: options, env: env, home: home, readFile: readFile, fileMode: fileMode) }
    catch { fail("\(error)") }
}

if command == .config, let c = config {
    print("Server: \(c.url)\nToken:  from \(c.tokenSource)")
    exit(0)
}

let transport: CLITransport = { body in
    guard let c = config, let url = URL(string: c.url.hasSuffix("/") ? c.url + "mcp" : c.url + "/mcp") else { throw CLIError("bad server URL") }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.httpBody = body
    req.timeoutInterval = 120
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.setValue("Bearer " + c.token, forHTTPHeaderField: "Authorization")
    return try await withCheckedThrowingContinuation { cont in
        URLSession.shared.dataTask(with: req) { data, resp, err in
            if let err { cont.resume(throwing: CLIError("cannot reach \(c.url): \(err.localizedDescription)")); return }
            cont.resume(returning: ((resp as? HTTPURLResponse)?.statusCode ?? 0, data ?? Data()))
        }.resume()
    }
}

let cli = BasedCLI(transport: transport, json: options.json)
let done = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0
Task {
    do { try await cli.execute(command, stdin: readStdin, out: { print($0) }) }
    catch { FileHandle.standardError.write(Data(("based: \(error)\n").utf8)); exitCode = 1 }
    done.signal()
}
done.wait()
exit(exitCode)
