// Dünne Hülle (ADR 0011): Fenster um apps/web, sonst nichts.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    based_desktop_lib::run()
}
