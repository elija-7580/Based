// BSD-164: Verdrahtung der Hülle – offizielle Plugins und das macOS-Menü. Keine App-Logik (ADR 0011):
// Speicher, Update-Abfrage und Tastenkürzel liegen in apps/web (src/desktop.ts).
use std::sync::Mutex;
use tauri::{Emitter, Manager};

mod anywhere;
mod menu;
use menu::{CHECK_UPDATES, CLOSE_TAB, CLOSE_WINDOW, INSTALL_CLI, REPORT_PROBLEM};

/// BSD-310: Label des zuletzt aktiven Fensters. Beim Klick ins Menü meldet macOS `is_focused` nicht immer
/// verlässlich – ohne das landete ⌘W aus einem Seitenfenster im Hauptfenster (dort: zurück zur Startseite).
struct FrontWindow(Mutex<String>);

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// BSD-390: WKWebViewConfiguration mit ausgeschalteten Writing Tools (runder Knopf neben markiertem Text,
/// „Ask Siri“-Vorschläge). Das Verhalten lässt sich nur beim Anlegen der WKWebView setzen; macOS < 15 kennt den
/// Selektor nicht und bekommt eine unveränderte Konfiguration. Wry legt Datenspeicher und URL-Schemata auf dieser
/// Konfiguration selbst an (wie ohne eigene Konfiguration).
#[cfg(target_os = "macos")]
fn webview_configuration_without_writing_tools() -> objc2::rc::Retained<objc2_web_kit::WKWebViewConfiguration> {
    use objc2::{msg_send, sel, MainThreadMarker};
    let mtm = MainThreadMarker::new().expect("Fenster werden im Hauptthread angelegt");
    let config = unsafe { objc2_web_kit::WKWebViewConfiguration::new(mtm) };
    // NSWritingToolsBehaviorNone = -1 (NSInteger)
    let supported: bool = unsafe { msg_send![&*config, respondsToSelector: sel!(setWritingToolsBehavior:)] };
    if supported {
        let none: isize = -1;
        let _: () = unsafe { msg_send![&*config, setWritingToolsBehavior: none] };
    }
    config
}

/// Hauptfenster aus tauri.conf.json („create“: false), auf dem Mac mit eigener WebView-Konfiguration (BSD-390).
fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else { return Ok(()) };
    let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)?;
    #[cfg(target_os = "macos")]
    let builder = builder.with_webview_configuration(webview_configuration_without_writing_tools());
    builder.build()?;
    Ok(())
}

/// Feedback 14. 11.: Läuft der Mac auf Akku? Für „Meeting-Transkript erst am Strom“ (`pmset -g ps`; None = unbekannt).
#[tauri::command]
fn power_on_battery() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/bin/pmset").args(["-g", "ps"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        if text.contains("'Battery Power'") {
            return Some(true);
        }
        if text.contains("'AC Power'") {
            return Some(false);
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Feedback 18. 11.: Meeting-Erkennung. Welche Apps nehmen gerade über das Mikrofon auf (Bundle-IDs)? Fragt nur
/// CoreAudio (macOS 14.2+: Prozessliste mit „läuft Eingabe“), hört nichts mit und braucht keine Mikrofon-Freigabe.
/// Ältere macOS: `["*"]`, wenn das Standard-Mikrofon irgendwo läuft (welche App, ist dort nicht bekannt).
/// Das Web-Frontend fragt alle paar Sekunden und entscheidet, ob es ein Meeting ist (Liste bekannter Apps).
#[tauri::command]
fn mic_users() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        mic::users()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
mod mic {
    use std::ffi::c_void;
    use std::os::raw::c_char;

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }

    const fn code(s: &[u8; 4]) -> u32 {
        ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | (s[3] as u32)
    }
    const SYSTEM_OBJECT: u32 = 1; // kAudioObjectSystemObject
    const SCOPE_GLOBAL: u32 = code(b"glob");
    const ELEMENT_MAIN: u32 = 0;
    const PROCESS_LIST: u32 = code(b"prs#"); // kAudioHardwarePropertyProcessObjectList (14.2+)
    const PROCESS_PID: u32 = code(b"ppid"); // kAudioProcessPropertyPID
    const PROCESS_BUNDLE_ID: u32 = code(b"pbid"); // kAudioProcessPropertyBundleID
    const PROCESS_RUNNING_INPUT: u32 = code(b"piri"); // kAudioProcessPropertyIsRunningInput
    const DEFAULT_INPUT: u32 = code(b"dIn "); // kAudioHardwarePropertyDefaultInputDevice
    const RUNNING_SOMEWHERE: u32 = code(b"gone"); // kAudioDevicePropertyDeviceIsRunningSomewhere
    const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectHasProperty(object: u32, address: *const Address) -> u8;
        fn AudioObjectGetPropertyDataSize(object: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: *mut u32) -> i32;
        fn AudioObjectGetPropertyData(object: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: *mut u32, data: *mut c_void) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringGetCString(s: *const c_void, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
        fn CFRelease(object: *const c_void);
    }

    fn address(selector: u32) -> Address {
        Address { selector, scope: SCOPE_GLOBAL, element: ELEMENT_MAIN }
    }

    fn get_u32(object: u32, selector: u32) -> Option<u32> {
        let a = address(selector);
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe { AudioObjectGetPropertyData(object, &a, 0, std::ptr::null(), &mut size, &mut value as *mut u32 as *mut c_void) };
        (status == 0).then_some(value)
    }

    fn get_i32(object: u32, selector: u32) -> Option<i32> {
        get_u32(object, selector).map(|v| v as i32)
    }

    fn bundle_id(object: u32) -> Option<String> {
        let a = address(PROCESS_BUNDLE_ID);
        let mut cf: *const c_void = std::ptr::null();
        let mut size = std::mem::size_of::<*const c_void>() as u32;
        let status = unsafe { AudioObjectGetPropertyData(object, &a, 0, std::ptr::null(), &mut size, &mut cf as *mut *const c_void as *mut c_void) };
        if status != 0 || cf.is_null() {
            return None;
        }
        let mut buffer = [0 as c_char; 256];
        let ok = unsafe { CFStringGetCString(cf, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) };
        unsafe { CFRelease(cf) };
        if ok == 0 {
            return None;
        }
        let text = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }.to_string_lossy().into_owned();
        (!text.is_empty()).then_some(text)
    }

    pub fn users() -> Vec<String> {
        let list = address(PROCESS_LIST);
        if unsafe { AudioObjectHasProperty(SYSTEM_OBJECT, &list) } == 0 {
            return fallback();
        }
        let mut size: u32 = 0;
        if unsafe { AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &list, 0, std::ptr::null(), &mut size) } != 0 || size == 0 {
            return Vec::new();
        }
        let mut ids = vec![0u32; size as usize / std::mem::size_of::<u32>()];
        if unsafe { AudioObjectGetPropertyData(SYSTEM_OBJECT, &list, 0, std::ptr::null(), &mut size, ids.as_mut_ptr() as *mut c_void) } != 0 {
            return Vec::new();
        }
        ids.truncate(size as usize / std::mem::size_of::<u32>());
        let own = std::process::id() as i32;
        let mut out: Vec<String> = Vec::new();
        for id in ids {
            if get_u32(id, PROCESS_RUNNING_INPUT) != Some(1) || get_i32(id, PROCESS_PID) == Some(own) {
                continue;
            }
            if let Some(b) = bundle_id(id) {
                if !out.contains(&b) {
                    out.push(b);
                }
            }
        }
        out
    }

    /// Vor macOS 14.2: nur „das Standard-Mikrofon läuft irgendwo“.
    fn fallback() -> Vec<String> {
        let Some(device) = get_u32(SYSTEM_OBJECT, DEFAULT_INPUT).filter(|d| *d != 0) else { return Vec::new() };
        if get_u32(device, RUNNING_SOMEWHERE) == Some(1) {
            vec!["*".to_string()]
        } else {
            Vec::new()
        }
    }
}

/// BSD-358: HTML der Zwischenablage (public.html) für „Paste“ im Based-Kontextmenü. Das Clipboard-Plugin liefert nur
/// Text – ohne das kam per Rechtsklick nur unformatierter Text an, ⌘V (Systemweg) fügte mit Formatierung ein.
/// Nur lesen, nur auf Anfrage aus dem Menü; None = kein HTML (oder nicht macOS).
#[tauri::command]
fn clipboard_html() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use std::ffi::{c_char, CStr, CString};
        let kind = CString::new("public.html").ok()?;
        unsafe {
            let board: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
            if board.is_null() {
                return None;
            }
            let ns_kind: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: kind.as_ptr()];
            if ns_kind.is_null() {
                return None;
            }
            let html: *mut AnyObject = msg_send![board, stringForType: ns_kind];
            if html.is_null() {
                return None;
            }
            let utf8: *const c_char = msg_send![html, UTF8String];
            if utf8.is_null() {
                return None;
            }
            Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// BSD-357: Rechtschreibvorschläge für das Based-Kontextmenü. WKWebView unterstreicht falsch geschriebene Wörter,
/// gibt die Vorschläge aber nicht an JavaScript; deshalb fragt die Hülle NSSpellChecker (Sprache: automatisch wie
/// macOS). `None` = richtig geschrieben (oder nicht macOS), sonst die Vorschläge (höchstens fünf, auch leer).
#[cfg(target_os = "macos")]
mod spelling {
    use objc2::encode::{Encode, Encoding};
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::ffi::{c_char, CStr, CString};

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct NSRange {
        pub location: usize,
        pub length: usize,
    }
    unsafe impl Encode for NSRange {
        const ENCODING: Encoding = Encoding::Struct("_NSRange", &[usize::ENCODING, usize::ENCODING]);
    }
    const NS_NOT_FOUND: usize = isize::MAX as usize;

    fn ns_string(s: &str) -> Option<Retained<AnyObject>> {
        let c = CString::new(s).ok()?;
        unsafe { msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()] }
    }

    fn checker() -> Option<Retained<AnyObject>> {
        unsafe { msg_send![class!(NSSpellChecker), sharedSpellChecker] }
    }

    pub fn check(word: &str) -> Option<Vec<String>> {
        let checker = checker()?;
        let text = ns_string(word)?;
        unsafe {
            let miss: NSRange = msg_send![&*checker, checkSpellingOfString: &*text, startingAt: 0usize];
            if miss.location == NS_NOT_FOUND || miss.length == 0 {
                return None;
            }
            let lang: *mut AnyObject = std::ptr::null_mut();
            let guesses: Option<Retained<AnyObject>> =
                msg_send![&*checker, guessesForWordRange: miss, inString: &*text, language: lang, inSpellDocumentWithTag: 0isize];
            let mut out = Vec::new();
            if let Some(list) = guesses {
                let n: usize = msg_send![&*list, count];
                for i in 0..n.min(5) {
                    let item: *mut AnyObject = msg_send![&*list, objectAtIndex: i];
                    if item.is_null() {
                        continue;
                    }
                    let utf8: *const c_char = msg_send![item, UTF8String];
                    if !utf8.is_null() {
                        out.push(CStr::from_ptr(utf8).to_string_lossy().into_owned());
                    }
                }
            }
            Some(out)
        }
    }

    pub fn learn(word: &str) {
        if let (Some(checker), Some(text)) = (checker(), ns_string(word)) {
            unsafe {
                let _: () = msg_send![&*checker, learnWord: &*text];
            }
        }
    }

    pub fn ignore(word: &str) {
        if let (Some(checker), Some(text)) = (checker(), ns_string(word)) {
            unsafe {
                let _: () = msg_send![&*checker, ignoreWord: &*text, inSpellDocumentWithTag: 0isize];
            }
        }
    }
}

#[tauri::command]
fn spell_check(word: String) -> Option<Vec<String>> {
    #[cfg(target_os = "macos")]
    {
        spelling::check(&word)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = word;
        None
    }
}

#[tauri::command]
fn spell_learn(word: String) {
    #[cfg(target_os = "macos")]
    spelling::learn(&word);
    #[cfg(not(target_os = "macos"))]
    let _ = word;
}

#[tauri::command]
fn spell_ignore(word: String) {
    #[cfg(target_os = "macos")]
    spelling::ignore(&word);
    #[cfg(not(target_os = "macos"))]
    let _ = word;
}

pub fn run() {
    tauri::Builder::default()
        .manage(FrontWindow(Mutex::new("main".to_string())))
        .manage(anywhere::AnywhereState::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        // BSD-319: Fehlerberichte nach ~/.config/based/reports (Rechte nur dort, capabilities/default.json) und im Finder zeigen.
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        // BSD-449: „Change folder…“ für Backups (Ordnerdialog, nur im Hauptfenster erlaubt)
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            power_on_battery, mic_users, clipboard_html, spell_check, spell_learn, spell_ignore,
            anywhere::anywhere_trusted, anywhere::anywhere_context, anywhere::anywhere_insert, anywhere::anywhere_enable
        ])
        .setup(|app| {
            create_main_window(app)?;
            Ok(())
        })
        .menu(menu::build)
        .on_menu_event(|app, event| {
            // BSD-202: Seiten können in eigenen Fenstern liegen – das Menü wirkt auf das Fenster vorn.
            let focused = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
            let last = app
                .state::<FrontWindow>()
                .0
                .lock()
                .ok()
                .and_then(|label| app.get_webview_window(label.as_str()))
                .filter(|w| w.is_visible().unwrap_or(false));
            let Some(window) = focused.or(last).or_else(|| app.get_webview_window("main")) else { return };
            if let Some(id) = event.id().as_ref().strip_prefix(menu::COMMAND_PREFIX) {
                // Befehl aus dem Tastatur-Register: die Oberfläche des Fensters vorn führt ihn aus.
                let _ = app.emit_to(window.label(), "desktop://command", id.to_string());
            } else if event.id() == CHECK_UPDATES {
                let _ = app.emit_to("main", "desktop://check-updates", ());
            } else if event.id() == INSTALL_CLI {
                show_main(app);
                let _ = app.emit_to("main", "desktop://install-cli", ());
            } else if event.id() == REPORT_PROBLEM {
                let _ = app.emit_to(window.label(), "desktop://report-problem", ());
            } else if event.id() == CLOSE_TAB {
                let _ = app.emit_to(window.label(), "desktop://close-tab", ());
            } else if event.id() == CLOSE_WINDOW {
                if window.label() == "main" {
                    let _ = window.hide();
                } else {
                    let _ = window.close();
                }
            }
        })
        // Roter Knopf: auf dem Mac blendet er das Hauptfenster nur aus, die App (und offene Tabs) bleiben; Beenden
        // über ⌘Q. Seitenfenster (BSD-202) schließen normal.
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if cfg!(target_os = "macos") && window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Focused(true) => {
                if let Ok(mut label) = window.state::<FrontWindow>().0.lock() {
                    *label = window.label().to_string();
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("Based Next konnte nicht starten")
        .run(|app, event| {
            // Klick aufs Dock-Symbol bei ausgeblendetem Fenster.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if !has_visible_windows {
                    show_main(app);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
