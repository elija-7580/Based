// BSD-164: Verdrahtung der Hülle – offizielle Plugins und das macOS-Menü. Keine App-Logik (ADR 0011):
// Speicher, Update-Abfrage und Tastenkürzel liegen in apps/web (src/desktop.ts).
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

/// Menü-ID für „Check for Updates…“; das Web-Frontend hört auf das Ereignis `desktop://check-updates`.
const CHECK_UPDATES: &str = "check-updates";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
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
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?;
            Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
        })
        .on_menu_event(|app, event| {
            if event.id() == CHECK_UPDATES {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("desktop://check-updates", ());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Based Next konnte nicht starten");
}
