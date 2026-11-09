import SwiftUI
import BasedCore
#if os(macOS)
import AppKit
#endif

/// Shown instead of the shell when the workspace file can't be opened (BSD-15). There is no in-memory
/// fallback: typing into a workspace that is never saved would lose everything.
struct StorageErrorView: View {
    @Environment(AppModel.self) private var model
    let error: WorkspaceOpener.OpenError
    @State private var copied = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "externaldrive.badge.exclamationmark")
                .font(.system(size: 40))
                .foregroundStyle(.red)
            Text("Based can't open your workspace")
                .font(.system(size: 20, weight: .semibold))
            Text("Nothing was changed or deleted. Check that the folder exists and that you have permission to write to it, then try again.")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 440)
            Text(error.description)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
            HStack(spacing: 10) {
                Button("Try Again") { model.retryOpenWorkspace() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("storageError.retry")
                #if os(macOS)
                Button("Show Folder in Finder") { NSWorkspace.shared.activateFileViewerSelecting([model.dataDirectory]) }
                #endif
                Button(copied ? "Copied" : "Copy Diagnostic Report") {
                    AppDiagnostics.copyReport(model: model)
                    copied = true
                }
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("storageError")
    }
}

/// Red bar at the top of the window while the store can't save (`WorkspaceStore.writeFailure`).
struct StorageWriteBanner: View {
    @Environment(AppModel.self) private var model
    let failure: WriteFailure

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text("Based can't save. Changes are paused.")
                .font(.system(size: 13, weight: .semibold))
            // BSD-121: with the background writer, edits made before the failure may still be waiting.
            let unsaved = model.store.unsavedChangeCount
            Text(unsaved > 0 ? "Some changes aren't saved yet (\(unsaved)). \(failure.message)" : failure.message)
                .font(.system(size: 12))
                .lineLimit(1)
                .opacity(0.85)
            Spacer(minLength: 8)
            Button("Try Again") { model.retryStoreWrites() }
                .accessibilityIdentifier("writeFailure.retry")
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .frame(height: 34)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.92)))
        .padding(.horizontal, 16)
        .padding(.top, 44)
        .help("\(failure.rejected) change(s) were not saved since \(failure.since.formatted(date: .omitted, time: .shortened))")
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("writeFailure")
    }
}
