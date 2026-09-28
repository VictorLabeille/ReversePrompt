// Contrat d'événement v1 : lecture et validation du corps de `POST /event`.
// Référence : docs/event-contract.md. Rien ici ne connaît un outil en particulier.

use serde::Serialize;
use serde_json::{Map, Value};

pub const VERSION: u64 = 1;
pub const MAX_BODY_BYTES: usize = 4096;
pub const MAX_TEXT_CHARS: usize = 32;
const MAX_SESSION_CHARS: usize = 128;
const MAX_SOURCE_CHARS: usize = 32;
const MAX_PROCESS_CHARS: usize = 64;
const MAX_TITLE_CHARS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Done,
    NeedsInput,
    Dismiss,
}

// La fenêtre à ramener au clic : le programme qui la possède, et un fragment de titre facultatif.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Focus {
    pub process: String,
    pub title: Option<String>,
}

impl Focus {
    // Une fenêtre (programme, titre) est-elle la cible ? Casse ignorée ; sans fragment de titre,
    // toute fenêtre du programme l'est. Dans Windows Terminal, le titre de la fenêtre est celui de
    // l'onglet actif : c'est ce qui distingue deux onglets.
    pub fn matches(&self, process: &str, title: &str) -> bool {
        process.eq_ignore_ascii_case(&self.process)
            && self.title.as_deref().is_none_or(|t| title.to_lowercase().contains(&t.to_lowercase()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Event {
    pub source: String,
    pub kind: Kind,
    pub session: String,
    pub focus: Option<Focus>,
    pub text: Option<String>,
}

pub fn parse(body: &[u8]) -> Result<Event, String> {
    if body.len() > MAX_BODY_BYTES {
        return Err(format!("corps de plus de {MAX_BODY_BYTES} octets"));
    }
    let value: Value = serde_json::from_slice(body).map_err(|e| format!("JSON illisible : {e}"))?;
    let obj = value.as_object().ok_or("le corps doit être un objet JSON")?;

    match obj.get("v") {
        None => return Err("v : champ obligatoire".into()),
        Some(v) => match v.as_u64() {
            Some(n) if (1..=VERSION).contains(&n) => {}
            _ => return Err(format!("v : version non gérée (1 à {VERSION})")),
        },
    }

    let source = required_str(obj, "source")?;
    if !is_source_id(source) {
        return Err("source : [a-z0-9][a-z0-9-]{0,31} attendu".into());
    }

    let kind = match required_str(obj, "kind")? {
        "done" => Kind::Done,
        "needs-input" => Kind::NeedsInput,
        "dismiss" => Kind::Dismiss,
        _ => return Err("kind : done, needs-input ou dismiss".into()),
    };

    let session = required_str(obj, "session")?;
    let n = session.chars().count();
    if n == 0 || n > MAX_SESSION_CHARS {
        return Err(format!("session : 1 à {MAX_SESSION_CHARS} caractères"));
    }

    let focus = match obj.get("focus") {
        None | Some(Value::Null) => None,
        Some(Value::Object(f)) => Some(parse_focus(f)?),
        Some(_) => return Err("focus : objet attendu".into()),
    };

    let text = match obj.get("text") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => clean_text(s),
        Some(_) => return Err("text : chaîne attendue".into()),
    };

    Ok(Event { source: source.to_owned(), kind, session: session.to_owned(), focus, text })
}

fn parse_focus(f: &Map<String, Value>) -> Result<Focus, String> {
    let process = required_str(f, "process").map_err(|e| format!("focus.{e}"))?;
    let n = process.chars().count();
    let valid_chars = process.chars().all(|c| c.is_ascii_alphanumeric() || "._- ".contains(c));
    if n > MAX_PROCESS_CHARS || n <= 4 || !valid_chars || !process.to_ascii_lowercase().ends_with(".exe") {
        return Err("focus.process : nom d'exécutable (*.exe, 64 caractères au plus) attendu".into());
    }
    let title = match f.get("title") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.chars().count() <= MAX_TITLE_CHARS => {
            if s.trim().is_empty() {
                None
            } else {
                Some(s.clone())
            }
        }
        Some(_) => return Err(format!("focus.title : chaîne de {MAX_TITLE_CHARS} caractères au plus")),
    };
    Ok(Focus { process: process.to_owned(), title })
}

fn required_str<'a>(obj: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    match obj.get(key) {
        Some(Value::String(s)) => Ok(s),
        Some(_) => Err(format!("{key} : chaîne attendue")),
        None => Err(format!("{key} : champ obligatoire")),
    }
}

fn is_source_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= MAX_SOURCE_CHARS
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

// Caractères de contrôle remplacés par des espaces ; vide → texte tiré au hasard par l'île ;
// trop long → tronqué avec « … » (une notification tronquée vaut mieux qu'une perdue).
fn clean_text(s: &str) -> Option<String> {
    let s: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if s.chars().count() <= MAX_TEXT_CHARS {
        return Some(s.to_owned());
    }
    let cut: String = s.chars().take(MAX_TEXT_CHARS - 1).collect();
    Some(format!("{}…", cut.trim_end()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(json: &str) -> Event {
        parse(json.as_bytes()).unwrap_or_else(|e| panic!("{json} refusé : {e}"))
    }

    fn err(json: &str) -> String {
        match parse(json.as_bytes()) {
            Ok(e) => panic!("{json} accepté : {e:?}"),
            Err(e) => e,
        }
    }

    #[test]
    fn minimal_event() {
        let e = ok(r#"{"v":1,"source":"claude-code","kind":"done","session":"s1"}"#);
        assert_eq!(e.kind, Kind::Done);
        assert_eq!(e.source, "claude-code");
        assert_eq!(e.focus, None);
        assert_eq!(e.text, None);
    }

    #[test]
    fn full_event_and_unknown_fields() {
        let e = ok(r#"{"v":1,"source":"x","kind":"needs-input","session":"s",
            "focus":{"process":"WindowsTerminal.exe","title":"proj","extra":1},
            "text":"Salut","future":{"a":1}}"#);
        assert_eq!(e.kind, Kind::NeedsInput);
        assert_eq!(e.focus, Some(Focus { process: "WindowsTerminal.exe".into(), title: Some("proj".into()) }));
        assert_eq!(e.text.as_deref(), Some("Salut"));
    }

    #[test]
    fn nulls_are_absent() {
        let e = ok(r#"{"v":1,"source":"x","kind":"dismiss","session":"s","focus":null,"text":null}"#);
        assert_eq!(e.focus, None);
        assert_eq!(e.text, None);
    }

    #[test]
    fn version() {
        assert!(err(r#"{"source":"x","kind":"done","session":"s"}"#).starts_with("v"));
        assert!(err(r#"{"v":2,"source":"x","kind":"done","session":"s"}"#).starts_with("v"));
        assert!(err(r#"{"v":"1","source":"x","kind":"done","session":"s"}"#).starts_with("v"));
        assert!(err(r#"{"v":0,"source":"x","kind":"done","session":"s"}"#).starts_with("v"));
    }

    #[test]
    fn source_id() {
        for bad in ["", "Claude", "-x", "a_b", "a b", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] {
            let json = format!(r#"{{"v":1,"source":"{bad}","kind":"done","session":"s"}}"#);
            assert!(err(&json).starts_with("source"), "{bad}");
        }
        ok(r#"{"v":1,"source":"0x-2","kind":"done","session":"s"}"#);
    }

    #[test]
    fn kind_and_session() {
        assert!(err(r#"{"v":1,"source":"x","kind":"shown","session":"s"}"#).starts_with("kind"));
        assert!(err(r#"{"v":1,"source":"x","kind":"done","session":""}"#).starts_with("session"));
        assert!(err(r#"{"v":1,"source":"x","kind":"done","session":5}"#).starts_with("session"));
        let long = "é".repeat(129);
        assert!(err(&format!(r#"{{"v":1,"source":"x","kind":"done","session":"{long}"}}"#)).starts_with("session"));
    }

    #[test]
    fn focus_rules() {
        let base = |f: &str| format!(r#"{{"v":1,"source":"x","kind":"done","session":"s","focus":{f}}}"#);
        assert!(err(&base(r#""WindowsTerminal.exe""#)).starts_with("focus"));
        assert!(err(&base(r#"{}"#)).starts_with("focus.process"));
        assert!(err(&base(r#"{"process":"notepad"}"#)).starts_with("focus.process"));
        assert!(err(&base(r#"{"process":".exe"}"#)).starts_with("focus.process"));
        assert!(err(&base(r#"{"process":"C:\\x\\a.exe"}"#)).starts_with("focus.process"));
        assert!(err(&base(r#"{"process":"a.exe","title":3}"#)).starts_with("focus.title"));
        let e = ok(&base(r#"{"process":"Claude.EXE","title":"  "}"#));
        assert_eq!(e.focus.unwrap().title, None);
    }

    #[test]
    fn text_cleanup() {
        let t = |s: &str| ok(&format!(r#"{{"v":1,"source":"x","kind":"done","session":"s","text":{s}}}"#)).text;
        assert_eq!(t(r#""  ""#), None);
        assert_eq!(t(r#""a\nb""#).as_deref(), Some("a b"));
        let long = t(r#""abcdefghijklmnopqrstuvwxyz0123456789""#).unwrap();
        assert_eq!(long.chars().count(), MAX_TEXT_CHARS);
        assert!(long.ends_with('…'));
        assert_eq!(t(&format!(r#""{}""#, "é".repeat(32))).unwrap().chars().count(), 32);
        assert!(err(r#"{"v":1,"source":"x","kind":"done","session":"s","text":1}"#).starts_with("text"));
    }

    #[test]
    fn body_shape() {
        assert!(err("[]").contains("objet"));
        assert!(err("{").contains("JSON"));
        let big = format!(r#"{{"v":1,"pad":"{}"}}"#, "x".repeat(MAX_BODY_BYTES));
        assert!(err(&big).contains("octets"));
    }

    #[test]
    fn focus_matches_process_then_title_fragment() {
        let tab = Focus { process: "WindowsTerminal.exe".into(), title: Some("5F0C2D".into()) };
        assert!(tab.matches("windowsterminal.exe", "ReversePrompt · 5f0c2d"));
        assert!(!tab.matches("WindowsTerminal.exe", "ReversePrompt · 9a8b7c"));
        assert!(!tab.matches("Code.exe", "ReversePrompt · 5f0c2d"));
        let window = Focus { process: "claude.exe".into(), title: None };
        assert!(window.matches("Claude.exe", "n'importe quel titre"));
    }
}
