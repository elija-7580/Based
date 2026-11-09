// Dünne Hülle (ADR 0011): Fenster um apps/web, sonst nichts.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Based konnte nicht starten");
}
