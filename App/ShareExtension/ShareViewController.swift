import UIKit
import UniformTypeIdentifiers
import BasedBrain

// BSD-11: "Based" in the iPhone Share sheet. Whatever is shared (a link with its page title, text) is dropped as a
// `SharedItem` into the App Group's ShareInbox; the app files it into Captures (source Share) when it next opens.
// The extension never opens the workspace itself. Not covered by the Linux typecheck (extension APIs); keep it small.

final class ShareViewController: UIViewController {
    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        label.text = "Saving to Based…"
        label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .headline)
        label.frame = view.bounds
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(label)
        Task { await save() }
    }

    private func save() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        var text = items.compactMap { $0.attributedContentText?.string }.joined(separator: "\n")
        var link: String?
        var title = items.compactMap { $0.attributedTitle?.string }.first
        for provider in items.flatMap({ $0.attachments ?? [] }) {
            if link == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
               url.scheme == "http" || url.scheme == "https" {
                link = url.absoluteString
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let s = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                text += (text.isEmpty ? "" : "\n") + s
            }
        }
        if title?.isEmpty == true { title = nil }
        let group = (Bundle.main.object(forInfoDictionaryKey: "BasedAppGroup") as? String) ?? ""
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            finish("Based can't receive shares yet (App Group missing).", after: 1.5)
            return
        }
        do {
            try ShareInbox(directory: container.appendingPathComponent("ShareInbox"))
                .drop(SharedItem(text: text, link: link, pageTitle: title))
            finish("Saved to Captures", after: 0.6)
        } catch {
            finish("Couldn't save: \(error.localizedDescription)", after: 1.5)
        }
    }

    @MainActor
    private func finish(_ message: String, after seconds: Double) {
        label.text = message
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
    }
}
