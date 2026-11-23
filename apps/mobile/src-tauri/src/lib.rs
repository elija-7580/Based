// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Dünne Hülle (ADR 0011): ein Fenster um apps/web und native Extras als Plugins (plugins/watch: Eingang der Apple
// Watch App). Speicher, Sync und Oberfläche liegen in apps/web.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(based_watch::init())
        .run(tauri::generate_context!())
        .expect("Based konnte nicht starten");
}
