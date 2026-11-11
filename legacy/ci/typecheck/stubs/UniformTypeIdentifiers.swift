#if STUB_IOS
import StubBase
#else
import AppKit
#endif
public struct UTType: Hashable, Sendable {
    public init?(filenameExtension: String) {}
    public init?(_ identifier: String) {}
    public init?(mimeType: String) {}
    public init(exportedAs: String) {}
    public init(importedAs: String) {}
    public var identifier: String { "" }
    public var preferredFilenameExtension: String? { nil }
    public var preferredMIMEType: String? { nil }
    public func conforms(to t: UTType) -> Bool { false }
    public static let plainText = UTType(exportedAs: ""), utf8PlainText = UTType(exportedAs: ""), text = UTType(exportedAs: ""), json = UTType(exportedAs: ""), html = UTType(exportedAs: ""), zip = UTType(exportedAs: ""), image = UTType(exportedAs: ""), png = UTType(exportedAs: ""), jpeg = UTType(exportedAs: ""), pdf = UTType(exportedAs: ""), url = UTType(exportedAs: ""), fileURL = UTType(exportedAs: ""), data = UTType(exportedAs: ""), content = UTType(exportedAs: ""), item = UTType(exportedAs: ""), folder = UTType(exportedAs: ""), directory = UTType(exportedAs: ""), movie = UTType(exportedAs: ""), audio = UTType(exportedAs: ""), audiovisualContent = UTType(exportedAs: ""), commaSeparatedText = UTType(exportedAs: ""), rtf = UTType(exportedAs: ""), archive = UTType(exportedAs: ""), sourceCode = UTType(exportedAs: ""), gif = UTType(exportedAs: ""), svg = UTType(exportedAs: ""), mpeg4Movie = UTType(exportedAs: ""), quickTimeMovie = UTType(exportedAs: ""), mp3 = UTType(exportedAs: ""), heic = UTType(exportedAs: ""), webP = UTType(exportedAs: ""), tiff = UTType(exportedAs: ""), spreadsheet = UTType(exportedAs: ""), presentation = UTType(exportedAs: ""), xml = UTType(exportedAs: ""), yaml = UTType(exportedAs: ""), propertyList = UTType(exportedAs: ""), emailMessage = UTType(exportedAs: ""), markdown = UTType(exportedAs: "")
}
extension NSItemProvider {
    public func loadDataRepresentation(for type: UTType, completionHandler: @escaping @Sendable (Data?, Error?) -> Void) -> Progress { Progress(totalUnitCount: 1) }
    public func hasItemConformingToTypeIdentifier(_ t: UTType) -> Bool { false }
    public func registeredContentTypes() -> [UTType] { [] }
}
#if !STUB_IOS
extension NSSavePanel {
    public var allowedContentTypes: [UTType] { get { [] } set {} }
}
#endif
