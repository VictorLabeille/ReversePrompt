// Sonde de la chaîne de build (J2) : une fenêtre vide.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("échec du lancement de l'app");
}
