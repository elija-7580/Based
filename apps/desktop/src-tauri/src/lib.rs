// BSD-164: Verdrahtung der Hülle – offizielle Plugins und das macOS-Menü. Keine App-Logik (ADR 0011):
// Speicher, Update-Abfrage und Tastenkürzel liegen in apps/web (src/desktop.ts).
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

/// Menü-ID für „Check for Updates…“; das Web-Frontend hört auf das Ereignis `desktop://check-updates`.
const CHECK_UPDATES: &str = "check-updates";
/// ⌘W schließt den Tab, nie das Fenster (Web-Frontend: `desktop://close-tab`; der letzte Tab wird zur Startseite).
const CLOSE_TAB: &str = "close-tab";
/// BSD-138: „Install Command Line Tool…“ – das Web-Frontend zeigt den Befehl (`desktop://install-cli`).
const INSTALL_CLI: &str = "install-cli";
/// ⇧⌘W: Fenster ausblenden – die App läuft weiter, Klick aufs Dock-Symbol holt es zurück (wie Notion).
const CLOSE_WINDOW: &str = "close-window";

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .menu(|app| {
            let name = app.package_info().name.clone();
            let about = AboutMetadata { name: Some(name.clone()), ..Default::default() };
            let app_menu = Submenu::with_items(
                app,
                &name,
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &MenuItem::with_id(app, CHECK_UPDATES, "Check for Updates…", true, None::<&str>)?,
                    &MenuItem::with_id(app, INSTALL_CLI, "Install Command Line Tool…", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            // Bearbeiten: nur Standardeinträge, damit ⌘C/⌘V/⌘A im WebView ankommen. ⌘Z/⇧⌘Z gehen an die Seite
            // (eigener Undo im Editor); die Einträge stehen trotzdem im Menü.
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            let window_menu = Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?,
                    &MenuItem::with_id(app, CLOSE_WINDOW, "Close Window", true, Some("CmdOrCtrl+Shift+W"))?,
                ],
            )?;
            Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
        })
        .on_menu_event(|app, event| {
            // BSD-202: Seiten können in eigenen Fenstern liegen – das Menü wirkt auf das Fenster vorn.
            let front = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
            let Some(window) = front.or_else(|| app.get_webview_window("main")) else { return };
            if event.id() == CHECK_UPDATES {
                let _ = app.emit_to("main", "desktop://check-updates", ());
            } else if event.id() == INSTALL_CLI {
                show_main(app);
                let _ = app.emit_to("main", "desktop://install-cli", ());
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if cfg!(target_os = "macos") && window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
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
