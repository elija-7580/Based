// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//! „Write anywhere“ (Mac): ein Tastenkürzel in jedem Programm öffnet ein kleines Based-Fenster, das mit dem Wissen
//! aus dem Gedächtnis im eigenen Ton schreibt und das Ergebnis dort einfügt, wo der Cursor stand.
//!
//! Was die Hülle dafür tut – und was nicht:
//! - Gelesen wird NUR im Moment des Tastendrucks, und nur das Feld mit dem Cursor im vordersten Programm (Text,
//!   Markierung, Name des Programms, Fenstertitel) über die Bedienungshilfen von macOS. Kein Mitlesen im
//!   Hintergrund, keine Bildschirmfotos, keine Passwortfelder (`AXSecureTextField`).
//! - Eingefügt wird über die Zwischenablage und ⌘V im Programm von vorher; der alte Text der Zwischenablage kommt
//!   danach zurück.
//! - Ohne die Freigabe „Bedienungshilfen“ passiert nichts außer der Nachfrage von macOS.
//! Ablauf und Oberfläche: apps/web/src/desktop/anywhere.ts und AnywherePanel.tsx.
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub const WINDOW: &str = "anywhere";
/// Höchstens so viel Text des Feldes geht an die Oberfläche (und von dort an das Modell).
const MAX_TEXT: usize = 4000;

#[derive(Clone, Default, Serialize)]
pub struct AnywhereContext {
    /// Name des Programms vorn (z. B. „Mail“).
    pub app: String,
    /// Titel des Fensters, falls lesbar.
    pub title: String,
    /// Text des Feldes mit dem Cursor (gekürzt auf das Ende), leer wenn nicht lesbar.
    pub text: String,
    /// Markierter Text.
    pub selection: String,
    /// Passwortfeld: nichts gelesen.
    pub secure: bool,
}

#[derive(Default)]
pub struct AnywhereState {
    context: Mutex<AnywhereContext>,
    /// Prozess, der beim Tastendruck vorn war – dorthin wird eingefügt.
    pid: Mutex<i32>,
    shortcut: Mutex<Option<String>>,
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{AnywhereContext, MAX_TEXT};
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::ffi::{c_char, c_void, CStr, CString};

    type CFRef = *const c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFRef) -> u8;
        fn AXUIElementCreateSystemWide() -> CFRef;
        fn AXUIElementCopyAttributeValue(element: CFRef, attribute: CFRef, value: *mut CFRef) -> i32;
        fn AXUIElementSetMessagingTimeout(element: CFRef, seconds: f32) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: CFRef);
        fn CFGetTypeID(cf: CFRef) -> usize;
        fn CFStringGetTypeID() -> usize;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceCreate(state: i32) -> CFRef;
        fn CGEventCreateKeyboardEvent(source: CFRef, key: u16, down: bool) -> CFRef;
        fn CGEventSetFlags(event: CFRef, flags: u64);
        fn CGEventPost(tap: u32, event: CFRef);
    }

    /// NSString (autoreleased) aus Rust-Text; NSString und CFString sind dasselbe Objekt (toll-free bridging).
    unsafe fn ns(s: &str) -> *mut AnyObject {
        let Ok(c) = CString::new(s) else { return std::ptr::null_mut() };
        msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()]
    }

    unsafe fn text_of(s: *mut AnyObject) -> String {
        if s.is_null() {
            return String::new();
        }
        let utf8: *const c_char = msg_send![s, UTF8String];
        if utf8.is_null() {
            return String::new();
        }
        CStr::from_ptr(utf8).to_string_lossy().into_owned()
    }

    /// Hat Based die Freigabe „Bedienungshilfen“? `prompt`: macOS zeigt seine Nachfrage, falls nicht.
    pub fn trusted(prompt: bool) -> bool {
        autoreleasepool(|_| unsafe {
            if !prompt {
                return AXIsProcessTrustedWithOptions(std::ptr::null()) != 0;
            }
            // { kAXTrustedCheckOptionPrompt: true } – der Schlüssel ist die Zeichenkette „AXTrustedCheckOptionPrompt“.
            let yes: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: true];
            let key = ns("AXTrustedCheckOptionPrompt");
            let options: *mut AnyObject = msg_send![class!(NSDictionary), dictionaryWithObject: yes, forKey: key];
            AXIsProcessTrustedWithOptions(options as CFRef) != 0
        })
    }

    /// Attribut eines AX-Elements; der Aufrufer gibt das Ergebnis frei.
    unsafe fn attribute(element: CFRef, name: &str) -> Option<CFRef> {
        let mut value: CFRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(element, ns(name) as CFRef, &mut value);
        if err != 0 || value.is_null() {
            None
        } else {
            Some(value)
        }
    }

    unsafe fn string_attribute(element: CFRef, name: &str) -> String {
        let Some(value) = attribute(element, name) else { return String::new() };
        let out = if CFGetTypeID(value) == CFStringGetTypeID() { text_of(value as *mut AnyObject) } else { String::new() };
        CFRelease(value);
        out
    }

    /// Das Ende eines langen Textes behalten (dort steht, woran gerade geschrieben wird), an einer Zeichengrenze.
    fn tail(s: String) -> String {
        if s.len() <= MAX_TEXT {
            return s;
        }
        let mut start = s.len() - MAX_TEXT;
        while !s.is_char_boundary(start) {
            start += 1;
        }
        s[start..].to_string()
    }

    /// Programm vorn (Name, Prozess) und das Feld mit dem Cursor. `None`: Based selbst ist vorn.
    pub fn capture() -> Option<(AnywhereContext, i32)> {
        autoreleasepool(|_| unsafe {
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            let front: *mut AnyObject = msg_send![workspace, frontmostApplication];
            if front.is_null() {
                return None;
            }
            let pid: i32 = msg_send![front, processIdentifier];
            if pid == std::process::id() as i32 {
                return None;
            }
            let name: *mut AnyObject = msg_send![front, localizedName];
            let mut ctx = AnywhereContext { app: text_of(name), ..Default::default() };

            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return Some((ctx, pid));
            }
            // Ein Programm, das nicht antwortet, hält den Tastendruck höchstens eine Sekunde auf.
            AXUIElementSetMessagingTimeout(system, 1.0);
            if let Some(focused) = attribute(system, "AXFocusedUIElement") {
                let role = string_attribute(focused, "AXRole");
                let subrole = string_attribute(focused, "AXSubrole");
                if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
                    ctx.secure = true;
                } else {
                    ctx.text = tail(string_attribute(focused, "AXValue"));
                    ctx.selection = tail(string_attribute(focused, "AXSelectedText"));
                }
                if let Some(window) = attribute(focused, "AXWindow") {
                    ctx.title = string_attribute(window, "AXTitle");
                    CFRelease(window);
                }
                CFRelease(focused);
            }
            CFRelease(system);
            Some((ctx, pid))
        })
    }

    unsafe fn pasteboard_text() -> Option<String> {
        let board: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        if board.is_null() {
            return None;
        }
        let s: *mut AnyObject = msg_send![board, stringForType: ns("public.utf8-plain-text")];
        if s.is_null() {
            None
        } else {
            Some(text_of(s))
        }
    }

    unsafe fn set_pasteboard_text(text: &str) {
        let board: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        if board.is_null() {
            return;
        }
        let _: isize = msg_send![board, clearContents];
        let _: bool = msg_send![board, setString: ns(text), forType: ns("public.utf8-plain-text")];
    }

    /// `text` in das Programm `pid` einfügen: nach vorn holen, ⌘V, danach die Zwischenablage zurücksetzen.
    pub fn insert(pid: i32, text: &str) -> bool {
        let before = autoreleasepool(|_| unsafe {
            let before = pasteboard_text();
            set_pasteboard_text(text);
            before
        });
        let activated = autoreleasepool(|_| unsafe {
            let app: *mut AnyObject = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
            if app.is_null() {
                return false;
            }
            // NSApplicationActivateIgnoringOtherApps = 1 << 1
            let options: usize = 1 << 1;
            let _: bool = msg_send![app, activateWithOptions: options];
            true
        });
        if !activated {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(220));
        unsafe {
            // kCGEventSourceStateCombinedSessionState = 0, Taste V = 9, kCGEventFlagMaskCommand = 1 << 20, kCGHIDEventTap = 0
            let source = CGEventSourceCreate(0);
            for down in [true, false] {
                let event = CGEventCreateKeyboardEvent(source, 9, down);
                if !event.is_null() {
                    CGEventSetFlags(event, 1 << 20);
                    CGEventPost(0, event);
                    CFRelease(event);
                }
            }
            if !source.is_null() {
                CFRelease(source);
            }
        }
        // Das Programm liest die Zwischenablage erst beim Einfügen – kurz warten, dann den alten Text zurück.
        std::thread::sleep(std::time::Duration::from_millis(700));
        if let Some(old) = before {
            autoreleasepool(|_| unsafe { set_pasteboard_text(&old) });
        }
        true
    }
}

/// Freigabe „Bedienungshilfen“ vorhanden? Mit `prompt` fragt macOS nach.
#[tauri::command(async)]
pub fn anywhere_trusted(prompt: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::trusted(prompt)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = prompt;
        false
    }
}

/// Was beim letzten Tastendruck gelesen wurde (das kleine Fenster holt es beim Öffnen).
#[tauri::command]
pub fn anywhere_context(state: tauri::State<'_, AnywhereState>) -> AnywhereContext {
    state.context.lock().map(|c| c.clone()).unwrap_or_default()
}

/// Ergebnis dort einfügen, wo der Cursor beim Tastendruck stand. Das kleine Fenster blendet sich vorher aus.
#[tauri::command(async)]
pub fn anywhere_insert(app: tauri::AppHandle, state: tauri::State<'_, AnywhereState>, text: String) -> bool {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.hide();
    }
    let pid = state.pid.lock().map(|p| *p).unwrap_or(0);
    #[cfg(target_os = "macos")]
    {
        pid > 0 && mac::insert(pid, &text)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (pid, text);
        false
    }
}

/// Tastendruck: lesen, merken, das kleine Fenster zeigen.
fn open(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if !mac::trusted(true) {
            return;
        }
        // Based selbst vorn: dort gibt es „Ask AI“ – nichts tun.
        let Some((context, pid)) = mac::capture() else { return };
        let state = app.state::<AnywhereState>();
        if let Ok(mut c) = state.context.lock() {
            *c = context;
        }
        if let Ok(mut p) = state.pid.lock() {
            *p = pid;
        }
        if let Some(window) = app.get_webview_window(WINDOW) {
            let _ = window.center();
            let _ = window.show();
            let _ = window.set_focus();
            let _ = app.emit_to(WINDOW, "anywhere://open", ());
            return;
        }
        let built = tauri::WebviewWindowBuilder::new(app, WINDOW, tauri::WebviewUrl::App("index.html?window=anywhere".into()))
            .title("Based")
            .inner_size(600.0, 340.0)
            .center()
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .focused(true)
            .build();
        if let Err(e) = built {
            eprintln!("anywhere: window: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Tastenkürzel an- oder abmelden (Einstellung „Write anywhere on this Mac“). Gibt zurück, ob es jetzt gilt.
#[tauri::command(async)]
pub fn anywhere_enable(app: tauri::AppHandle, state: tauri::State<'_, AnywhereState>, shortcut: Option<String>) -> Result<bool, String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let mut current = state.shortcut.lock().map_err(|e| e.to_string())?;
    if *current == shortcut {
        return Ok(shortcut.is_some());
    }
    if let Some(old) = current.take() {
        let _ = app.global_shortcut().unregister(old.as_str());
    }
    let Some(keys) = shortcut else { return Ok(false) };
    app.global_shortcut()
        .on_shortcut(keys.as_str(), |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let app = app.clone();
                // Nicht im Ereignis-Thread lesen: ein hängendes Programm darf Based nicht aufhalten.
                std::thread::spawn(move || open(&app));
            }
        })
        .map_err(|e| e.to_string())?;
    *current = Some(keys);
    Ok(true)
}
