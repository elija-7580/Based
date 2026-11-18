// Das Mac-Menü oben. Die Einträge mit Tastenkürzel kommen aus dem Tastatur-Register der Oberfläche
// (apps/web/src/shell/keymap.ts) – apps/web/src/shell/keymap.test.ts prüft, dass jede `command(…)`-Zeile hier
// (Kennung, Beschriftung, Kürzel, Reihenfolge je Menü) mit dem Register übereinstimmt. Ein Klick schickt
// `desktop://command` mit der Kennung an das Fenster vorn; die Oberfläche führt dann dasselbe aus wie bei der Taste.
// Die Taste selbst bekommt zuerst die Seite (WKWebView gibt sie nur ans Menü weiter, wenn die Seite sie nicht nimmt).
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// Menü-ID für „Check for Updates…“; das Web-Frontend hört auf das Ereignis `desktop://check-updates`.
pub const CHECK_UPDATES: &str = "check-updates";
/// ⌘W schließt den Tab im Fenster vorn (Web-Frontend: `desktop://close-tab`). Beim letzten Tab entscheidet das
/// Web-Frontend (BSD-310): Seitenfenster schließen, Hauptfenster ausblenden, wenn noch andere Fenster offen sind; nur
/// im letzten Fenster wird der letzte Tab zur Startseite.
pub const CLOSE_TAB: &str = "close-tab";
/// BSD-138: „Install Command Line Tool…“ – das Web-Frontend zeigt den Befehl (`desktop://install-cli`).
pub const INSTALL_CLI: &str = "install-cli";
/// ⇧⌘W: Fenster ausblenden – die App läuft weiter, Klick aufs Dock-Symbol holt es zurück (wie Notion).
pub const CLOSE_WINDOW: &str = "close-window";
/// BSD-319: Hilfe → „Report a Problem…“ (⇧⌘B) – das Fenster vorn friert seinen Zustand ein (`desktop://report-problem`).
pub const REPORT_PROBLEM: &str = "report-problem";
/// BSD-551: Hilfe → „Show Welcome Tour“ – das Fenster vorn zeigt den geführten Einstieg noch einmal (`desktop://welcome-tour`).
pub const WELCOME_TOUR: &str = "welcome-tour";
/// Vorsatz der Menü-Kennungen für Befehle aus dem Register.
pub const COMMAND_PREFIX: &str = "cmd:";

/// Eintrag für einen Befehl aus dem Register. Lässt sich das Kürzel nicht lesen, kommt der Eintrag ohne – ein
/// Tippfehler darf den Start der App nicht verhindern.
fn command<R: Runtime>(app: &AppHandle<R>, id: &str, label: &str, accelerator: &str) -> tauri::Result<MenuItem<R>> {
    let menu_id = format!("{COMMAND_PREFIX}{id}");
    MenuItem::with_id(app, menu_id.clone(), label, true, Some(accelerator))
        .or_else(|_| MenuItem::with_id(app, menu_id, label, true, None::<&str>))
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
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
            &command(app, "settings", "Settings…", "CmdOrCtrl+,")?,
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
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &command(app, "palette", "New…", "CmdOrCtrl+N")?,
            &command(app, "newPage", "New Page", "CmdOrCtrl+Alt+N")?,
            &PredefinedMenuItem::separator(app)?,
            &command(app, "newTab", "New Tab", "CmdOrCtrl+T")?,
            &MenuItem::with_id(app, CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?,
            &MenuItem::with_id(app, CLOSE_WINDOW, "Close Window", true, Some("CmdOrCtrl+Shift+W"))?,
        ],
    )?;
    // Bearbeiten: Standardeinträge, damit ⌘C/⌘V/⌘A im WebView ankommen. ⌘Z/⇧⌘Z gehen an die Seite (eigener Undo
    // im Editor); die Einträge stehen trotzdem im Menü.
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
            &PredefinedMenuItem::separator(app)?,
            &command(app, "find", "Find…", "CmdOrCtrl+F")?,
            &command(app, "findNext", "Find Next", "CmdOrCtrl+G")?,
            &command(app, "findPrevious", "Find Previous", "CmdOrCtrl+Shift+G")?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &command(app, "toggleTheme", "Switch Light / Dark", "CmdOrCtrl+Shift+L")?,
            &command(app, "toggleSidebar", "Show / Hide Sidebar", "CmdOrCtrl+\\")?,
            &command(app, "focusSidebar", "Focus Sidebar", "CmdOrCtrl+Shift+E")?,
            &PredefinedMenuItem::separator(app)?,
            &command(app, "nextTab", "Next Tab", "CmdOrCtrl+Shift+]")?,
            &command(app, "previousTab", "Previous Tab", "CmdOrCtrl+Shift+[")?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let go_menu = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &command(app, "quickFind", "Search…", "CmdOrCtrl+K")?,
            &PredefinedMenuItem::separator(app)?,
            &command(app, "back", "Back", "CmdOrCtrl+[")?,
            &command(app, "forward", "Forward", "CmdOrCtrl+]")?,
            &command(app, "openParent", "Parent Page", "CmdOrCtrl+Shift+U")?,
            &PredefinedMenuItem::separator(app)?,
            &command(app, "home", "Home", "CmdOrCtrl+Shift+H")?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;
    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, WELCOME_TOUR, "Show Welcome Tour", true, None::<&str>)?,
            &command(app, "shortcuts", "Keyboard Shortcuts", "CmdOrCtrl+Shift+/")?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, REPORT_PROBLEM, "Report a Problem…", true, Some("CmdOrCtrl+Shift+B"))?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &go_menu, &window_menu, &help_menu])
}
