// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Dünne Hülle (ADR 0011): ein Fenster um apps/web, sonst nichts. Speicher, Sync und Oberfläche liegen in apps/web.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Based konnte nicht starten");
}
