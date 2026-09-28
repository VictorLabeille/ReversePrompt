// Cœur de l'app : décide ce que devient chaque événement du contrat.
// Règles : docs/event-contract.md, « Règles de l'app ». Aucune notion d'outil ici.

use std::time::{Duration, Instant};

use crate::contract::{Event, Focus, Kind};

// Deux événements identiques (session, type, texte) à moins de cet écart : le second est ignoré.
pub const DEDUP_WINDOW: Duration = Duration::from_secs(2);

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Show { kind: Kind, source: String, text: Option<String> },
    Dismiss,
    Ignore,
}

#[derive(Default)]
pub struct Core {
    // L'événement affiché par l'île : sa session et sa cible de focus.
    current: Option<Event>,
    last: Option<(String, Kind, Option<String>, Instant)>,
    paused_until: Option<Instant>,
}

impl Core {
    pub fn handle(&mut self, event: Event, now: Instant) -> Action {
        if event.kind == Kind::Dismiss {
            return match &self.current {
                Some(c) if c.session == event.session => {
                    self.current = None;
                    Action::Dismiss
                }
                _ => Action::Ignore,
            };
        }
        if self.is_paused(now) {
            return Action::Ignore;
        }
        if let Some((session, kind, text, at)) = &self.last {
            if *session == event.session
                && *kind == event.kind
                && *text == event.text
                && now.saturating_duration_since(*at) < DEDUP_WINDOW
            {
                return Action::Ignore;
            }
        }
        self.last = Some((event.session.clone(), event.kind, event.text.clone(), now));
        let action = Action::Show { kind: event.kind, source: event.source.clone(), text: event.text.clone() };
        self.current = Some(event);
        action
    }

    // Clic gauche : rend la fenêtre à ramener et oublie l'événement.
    pub fn take_focus(&mut self) -> Option<Focus> {
        self.current.take().and_then(|e| e.focus)
    }

    // Clic droit, île cachée : oublie l'événement sans rien ramener.
    pub fn clear(&mut self) {
        self.current = None;
    }

    // Fenêtre (ou onglet) dont le passage au premier plan doit faire partir l'île.
    pub fn target(&self) -> Option<&Focus> {
        self.current.as_ref()?.focus.as_ref()
    }

    pub fn pause(&mut self, until: Option<Instant>) {
        self.paused_until = until;
    }

    pub fn is_paused(&self, now: Instant) -> bool {
        self.paused_until.is_some_and(|t| now < t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(session: &str, kind: Kind, text: Option<&str>) -> Event {
        Event {
            source: "test".into(),
            kind,
            session: session.into(),
            focus: Some(Focus { process: format!("{session}.exe"), title: None }),
            text: text.map(Into::into),
        }
    }

    fn is_show(a: &Action) -> bool {
        matches!(a, Action::Show { .. })
    }

    #[test]
    fn last_event_wins_and_sets_target() {
        let mut c = Core::default();
        let t = Instant::now();
        assert!(is_show(&c.handle(ev("a", Kind::Done, None), t)));
        assert!(is_show(&c.handle(ev("b", Kind::NeedsInput, None), t)));
        assert_eq!(c.target().unwrap().process, "b.exe");
        assert_eq!(c.take_focus().unwrap().process, "b.exe");
        assert_eq!(c.target(), None);
    }

    #[test]
    fn duplicates_within_window_are_ignored() {
        let mut c = Core::default();
        let t = Instant::now();
        assert!(is_show(&c.handle(ev("a", Kind::Done, Some("x")), t)));
        assert_eq!(c.handle(ev("a", Kind::Done, Some("x")), t + Duration::from_millis(500)), Action::Ignore);
        // Même session mais autre type ou autre texte : ce n'est pas un doublon.
        assert!(is_show(&c.handle(ev("a", Kind::NeedsInput, Some("x")), t + Duration::from_millis(600))));
        assert!(is_show(&c.handle(ev("a", Kind::NeedsInput, Some("y")), t + Duration::from_millis(700))));
        // Hors fenêtre : accepté.
        assert!(is_show(&c.handle(ev("a", Kind::NeedsInput, Some("y")), t + Duration::from_secs(3))));
    }

    #[test]
    fn dismiss_only_for_its_session() {
        let mut c = Core::default();
        let t = Instant::now();
        c.handle(ev("a", Kind::Done, None), t);
        assert_eq!(c.handle(ev("b", Kind::Dismiss, None), t), Action::Ignore);
        assert_eq!(c.target().unwrap().process, "a.exe");
        assert_eq!(c.handle(ev("a", Kind::Dismiss, None), t), Action::Dismiss);
        assert_eq!(c.handle(ev("a", Kind::Dismiss, None), t), Action::Ignore);
    }

    #[test]
    fn pause_blocks_shows_but_not_dismiss() {
        let mut c = Core::default();
        let t = Instant::now();
        c.handle(ev("a", Kind::Done, None), t);
        c.pause(Some(t + Duration::from_secs(3600)));
        assert_eq!(c.handle(ev("b", Kind::Done, None), t), Action::Ignore);
        assert_eq!(c.handle(ev("a", Kind::Dismiss, None), t), Action::Dismiss);
        assert!(is_show(&c.handle(ev("b", Kind::Done, None), t + Duration::from_secs(3601))));
        c.pause(None);
        assert!(!c.is_paused(t));
    }

    #[test]
    fn clear_forgets_target() {
        let mut c = Core::default();
        c.handle(ev("a", Kind::Done, None), Instant::now());
        c.clear();
        assert_eq!(c.take_focus(), None);
    }
}
