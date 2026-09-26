// Fichiers de l'app dans son dossier de données (%APPDATA%\<identifiant>) : jeton, réglages,
// journal. Format documenté dans docs/event-contract.md, « Fichiers de l'app ».

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const DEFAULT_PORT: u16 = 47625;
const LOG_MAX_BYTES: u64 = 256 * 1024;
const AUTOSTART_MARKER: &str = "autostart-initialized";

#[derive(Serialize, Deserialize)]
struct ConfigFile {
    port: u16,
}

pub struct Settings {
    pub dir: PathBuf,
    pub port: u16,
    pub token: String,
    // Faux tant qu'un build de production n'a pas activé le lancement au démarrage une première
    // fois (marqueur `autostart-initialized`). Indépendant de config.json, que les builds de
    // développement créent aussi.
    pub autostart_initialized: bool,
}

pub fn load(dir: &Path) -> Result<Settings, String> {
    fs::create_dir_all(dir).map_err(|e| format!("dossier {} : {e}", dir.display()))?;

    let config_path = dir.join("config.json");
    let port = match fs::read_to_string(&config_path) {
        Ok(s) => serde_json::from_str::<ConfigFile>(&s).map(|c| c.port).unwrap_or(DEFAULT_PORT),
        Err(_) => {
            let json = serde_json::to_string_pretty(&ConfigFile { port: DEFAULT_PORT }).unwrap();
            fs::write(&config_path, json + "\n").map_err(|e| format!("config.json : {e}"))?;
            DEFAULT_PORT
        }
    };

    let token_path = dir.join("token");
    let token = match fs::read_to_string(&token_path) {
        Ok(s) if is_token(s.trim()) => s.trim().to_owned(),
        _ => {
            let token = new_token()?;
            fs::write(&token_path, &token).map_err(|e| format!("token : {e}"))?;
            token
        }
    };

    let autostart_initialized = dir.join(AUTOSTART_MARKER).exists();
    Ok(Settings { dir: dir.to_owned(), port, token, autostart_initialized })
}

pub fn mark_autostart_initialized(dir: &Path) {
    let _ = fs::write(dir.join(AUTOSTART_MARKER), "");
}

fn is_token(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("générateur aléatoire : {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// Journal court et borné (reverse-prompt.log, puis .old) : de quoi comprendre après coup ce
// que l'app a reçu et fait, sans jamais grossir.
pub fn log(dir: &Path, message: &str) {
    let path = dir.join("reverse-prompt.log");
    if fs::metadata(&path).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("reverse-prompt.log.old"));
    }
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{ms} {message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_then_reuses_token_and_config() {
        let dir = std::env::temp_dir().join(format!("rp-store-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let a = load(&dir).unwrap();
        assert!(!a.autostart_initialized);
        assert_eq!(a.port, DEFAULT_PORT);
        assert!(is_token(&a.token));
        mark_autostart_initialized(&dir);
        let b = load(&dir).unwrap();
        assert!(b.autostart_initialized);
        assert_eq!(a.token, b.token);
        fs::write(dir.join("config.json"), r#"{"port":50000}"#).unwrap();
        fs::write(dir.join("token"), "abîmé").unwrap();
        let c = load(&dir).unwrap();
        assert_eq!(c.port, 50000);
        assert_ne!(c.token, a.token);
        fs::remove_dir_all(&dir).unwrap();
    }
}
