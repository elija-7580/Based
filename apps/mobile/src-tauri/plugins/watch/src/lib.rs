// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//! Natives Extra der iPhone-Hülle (ADR 0011: „Native Extras als Plugins in Swift“): der Eingang der Apple Watch App.
//! Die Arbeit macht Swift (`ios/Sources/WatchPlugin.swift`): WatchConnectivity nimmt die Dateien der Uhr an und legt
//! sie in einen Ordner der App. Rust reicht nur die drei Befehle durch; was aus einer Notiz wird, entscheidet die
//! Oberfläche (`apps/web/src/mobile/watchInbox.ts`). Auf anderen Systemen ist der Eingang leer.
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_based_watch);

#[cfg(target_os = "ios")]
struct Watch<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[derive(Deserialize, serde::Serialize)]
struct ItemArgs {
    id: String,
}

#[cfg(target_os = "ios")]
fn run<R: Runtime>(app: &AppHandle<R>, command: &str, payload: Value) -> Result<Value, String> {
    use tauri::Manager;
    app.state::<Watch<R>>()
        .0
        .run_mobile_plugin::<Value>(command, payload)
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "ios"))]
fn run<R: Runtime>(_app: &AppHandle<R>, command: &str, _payload: Value) -> Result<Value, String> {
    match command {
        "pending" => Ok(json!({ "items": [] })),
        "done" => Ok(json!({})),
        _ => Err("No Apple Watch on this system.".into()),
    }
}

/// Notizen der Uhr, die noch nicht im Workspace sind: `{ items: [{ id, at, dur, ext }] }`.
#[tauri::command]
async fn pending<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(&app, "pending", json!({}))
}

/// Inhalt einer Notiz: `{ data: <base64> }`.
#[tauri::command]
async fn read<R: Runtime>(app: AppHandle<R>, id: String) -> Result<Value, String> {
    run(&app, "read", json!(ItemArgs { id }))
}

/// Die Notiz ist im Workspace: aus dem Eingang löschen.
#[tauri::command]
async fn done<R: Runtime>(app: AppHandle<R>, id: String) -> Result<Value, String> {
    run(&app, "done", json!(ItemArgs { id }))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("based-watch")
        .invoke_handler(tauri::generate_handler![pending, read, done])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                let handle = _api.register_ios_plugin(init_plugin_based_watch)?;
                _app.manage(Watch(handle));
            }
            Ok(())
        })
        .build()
}
