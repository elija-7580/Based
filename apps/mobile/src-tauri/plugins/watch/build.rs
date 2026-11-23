// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
const COMMANDS: &[&str] = &["pending", "read", "done"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
