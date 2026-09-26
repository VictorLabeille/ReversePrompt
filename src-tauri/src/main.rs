// Pas de console en version finale : l'app vit dans la zone de notification.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    reverse_prompt_lib::run();
}
