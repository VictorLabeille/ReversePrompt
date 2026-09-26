// App ReversePrompt : fenêtre overlay de l'île, serveur local, retour à la fenêtre de l'agent,
// icône de zone de notification. Le cœur ne connaît que le contrat (docs/event-contract.md).

pub mod contract;
pub mod core;
pub mod server;
pub mod store;
#[cfg(windows)]
mod focus;
#[cfg(windows)]
mod overlay;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use crate::contract::{Event, Kind};
use crate::core::{Action, Core};

const ISLAND: &str = "island";
const PLAYGROUND: &str = "playground";
const PAUSE: Duration = Duration::from_secs(3600);
// Cadence de lecture du curseur quand l'île est visible (clics traversants hors de la pilule).
const CURSOR_POLL: Duration = Duration::from_millis(16);
// Un passage au premier plan compte comme un retour de l'utilisateur s'il suit une entrée
// clavier ou souris de moins de ce délai.
#[cfg(windows)]
const USER_SWITCH_MS: u32 = 1500;

struct AppState {
    core: Mutex<Core>,
    dir: PathBuf,
    island_visible: AtomicBool,
    island_hwnd: AtomicIsize,
    cursor_thread: OnceLock<thread::Thread>,
}

impl AppState {
    fn log(&self, message: &str) {
        store::log(&self.dir, message);
    }
}

#[derive(Serialize, Clone)]
struct ShowPayload {
    kind: Kind,
    source: String,
    text: Option<String>,
}

#[derive(Serialize, Clone)]
struct DismissPayload {
    reason: &'static str,
}

#[cfg(windows)]
fn island_hwnd(state: &AppState) -> Option<windows::Win32::Foundation::HWND> {
    let raw = state.island_hwnd.load(Ordering::Relaxed);
    (raw != 0).then(|| windows::Win32::Foundation::HWND(raw as *mut _))
}

// Un événement du contrat, d'où qu'il vienne (serveur, menu) : le cœur décide, l'île exécute.
fn dispatch(app: &AppHandle, event: Event) {
    let state = app.state::<AppState>();
    let summary = format!("{:?} source={} session={}", event.kind, event.source, event.session);
    let action = state.core.lock().unwrap().handle(event, Instant::now());
    state.log(&format!("événement {summary} → {action:?}"));
    match action {
        Action::Show { kind, source, text } => {
            #[cfg(windows)]
            if let Some(hwnd) = island_hwnd(&state) {
                overlay::raise(hwnd);
            }
            let _ = app.emit_to(ISLAND, "island://show", ShowPayload { kind, source, text });
        }
        Action::Dismiss => {
            let _ = app.emit_to(ISLAND, "island://dismiss", DismissPayload { reason: "external" });
        }
        Action::Ignore => {}
    }
}

// --- Commandes appelées par l'île (src/app/bridge.ts) ------------------------------------

// L'île est prête : dimensionne la fenêtre (taille lue dans src/config/animation.ts), la place
// en haut au centre de l'écran principal et l'affiche, sans l'activer et traversée par les clics.
#[tauri::command]
fn overlay_ready(window: WebviewWindow, width_px: f64, height_px: f64) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("aucun écran principal")?;
    let scale = monitor.scale_factor();
    let (w, h) = ((width_px * scale).round() as u32, (height_px * scale).round() as u32);
    let x = monitor.position().x + (monitor.size().width as i32 - w as i32) / 2;
    window.set_size(PhysicalSize::new(w, h)).map_err(|e| e.to_string())?;
    window.set_position(PhysicalPosition::new(x, monitor.position().y)).map_err(|e| e.to_string())?;
    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let state = window.state::<AppState>();
        state.island_hwnd.store(hwnd.0 as isize, Ordering::Relaxed);
        let hwnd = windows::Win32::Foundation::HWND(hwnd.0 as *mut _);
        overlay::apply_styles(hwnd);
        overlay::show(hwnd);
    }
    window.state::<AppState>().log(&format!("île prête : {w}×{h} px physiques, échelle {scale}"));
    Ok(())
}

// État de l'île : la lecture du curseur ne tourne que quand elle est visible.
#[tauri::command]
fn island_state(window: WebviewWindow, state: String) {
    let app_state = window.state::<AppState>();
    app_state.log(&format!("île : {state}"));
    let visible = state != "hidden";
    app_state.island_visible.store(visible, Ordering::Relaxed);
    if visible {
        if let Some(t) = app_state.cursor_thread.get() {
            t.unpark();
        }
    } else {
        set_click_through(&window, true);
    }
}

// Le curseur est-il sur la pilule ? Oui : la fenêtre capte les clics ; non : elle les laisse passer.
#[tauri::command]
fn set_interactive(window: WebviewWindow, on: bool) {
    set_click_through(&window, !on);
}

fn set_click_through(window: &WebviewWindow, through: bool) {
    let _ = window.set_ignore_cursor_events(through);
    #[cfg(windows)]
    if let Some(hwnd) = island_hwnd(&window.state::<AppState>()) {
        overlay::apply_styles(hwnd);
    }
}

// Clic gauche : ramène la fenêtre de l'agent.
#[tauri::command]
fn activate(window: WebviewWindow) {
    let app = window.app_handle().clone();
    let target = app.state::<AppState>().core.lock().unwrap().take_focus();
    let Some(target) = target else {
        app.state::<AppState>().log("clic : aucune fenêtre à ramener");
        return;
    };
    thread::spawn(move || {
        #[cfg(windows)]
        let result = match focus::find_window(&target.process, target.title.as_deref()) {
            Some(hwnd) => focus::bring_to_front(hwnd),
            None => "aucune fenêtre trouvée",
        };
        #[cfg(not(windows))]
        let result = "non géré hors Windows";
        app.state::<AppState>().log(&format!("clic : {} → {result}", target.process));
    });
}

// Clic droit : ferme sans changer de fenêtre.
#[tauri::command]
fn close(window: WebviewWindow) {
    window.state::<AppState>().core.lock().unwrap().clear();
}

// --- Fils de fond --------------------------------------------------------------------------

fn spawn_cursor_poller(app: AppHandle) {
    let poller = app.clone();
    let handle = thread::Builder::new()
        .name("cursor-poll".into())
        .spawn(move || {
            let mut last = (f64::NAN, f64::NAN);
            let app = poller;
            loop {
                let state = app.state::<AppState>();
                if !state.island_visible.load(Ordering::Relaxed) {
                    last = (f64::NAN, f64::NAN);
                    thread::park();
                    continue;
                }
                #[cfg(windows)]
                if let Some(p) = island_hwnd(&state).and_then(overlay::cursor_in_window) {
                    if p != last {
                        last = p;
                        let _ = app.emit_to(ISLAND, "island://cursor", [p.0, p.1]);
                    }
                }
                thread::sleep(CURSOR_POLL);
            }
        })
        .expect("fil de lecture du curseur");
    let _ = app.state::<AppState>().cursor_thread.set(handle.thread().clone());
}

// Quand la fenêtre de l'agent revient au premier plan par un autre chemin (Alt+Tab, barre des
// tâches), l'île part d'elle-même.
#[cfg(windows)]
fn watch_foreground(app: AppHandle) {
    focus::watch_foreground(move |hwnd| {
        let name = focus::process_name(hwnd);
        let state = app.state::<AppState>();
        let mut core = state.core.lock().unwrap();
        let matches = match (core.focus_process(), name.as_deref()) {
            (Some(target), Some(name)) => target.eq_ignore_ascii_case(name),
            _ => false,
        };
        let by_user = focus::ms_since_last_input() < USER_SWITCH_MS;
        if matches && !by_user {
            state.log("fenêtre de l'agent au premier plan sans action de l'utilisateur → ignoré");
            return;
        }
        if matches {
            core.clear();
            drop(core);
            state.log("fenêtre de l'agent revenue au premier plan → sortie");
            let _ = app.emit_to(ISLAND, "island://dismiss", DismissPayload { reason: "external" });
        }
    });
}

// --- Fenêtres et zone de notification -----------------------------------------------------

fn create_island(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    // Taille provisoire : l'île envoie la sienne (overlay_ready) avant que la fenêtre ne s'affiche.
    WebviewWindowBuilder::new(app, ISLAND, WebviewUrl::App("index.html".into()))
        .title("ReversePrompt")
        .inner_size(1.0, 1.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focusable(false)
        .focused(false)
        .visible(false)
        .build()
}

fn open_playground(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PLAYGROUND) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, PLAYGROUND, WebviewUrl::App("playground/index.html".into()))
        .title("ReversePrompt — playground")
        .inner_size(1280.0, 860.0)
        .build();
}

fn build_tray(app: &AppHandle, tooltip: &str) -> tauri::Result<()> {
    let test = MenuItem::with_id(app, "test", "Notification de test", true, None::<&str>)?;
    let playground = MenuItem::with_id(app, "playground", "Ouvrir le playground", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause (1 h)", true, false, None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "Lancer au démarrage", true, autostart_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&test, &playground, &pause, &autostart, &sep, &quit])?;

    let pause_item = pause.clone();
    let autostart_item = autostart.clone();
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("icône de l'app"))
        .tooltip(tooltip)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "test" => dispatch(
                app,
                Event {
                    source: "generic".into(),
                    kind: Kind::NeedsInput,
                    session: format!("test-{:?}", std::time::SystemTime::now()),
                    focus: None,
                    text: Some("Notification de test".into()),
                },
            ),
            "playground" => open_playground(app),
            "pause" => toggle_pause(app, &pause_item),
            "autostart" => {
                let launcher = app.autolaunch();
                let on = launcher.is_enabled().unwrap_or(false);
                let _ = if on { launcher.disable() } else { launcher.enable() };
                let _ = autostart_item.set_checked(launcher.is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn toggle_pause(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let state = app.state::<AppState>();
    let now = Instant::now();
    let mut core = state.core.lock().unwrap();
    if core.is_paused(now) {
        core.pause(None);
        let _ = item.set_checked(false);
        return;
    }
    core.pause(Some(now + PAUSE));
    let _ = item.set_checked(true);
    let (app, item) = (app.clone(), item.clone());
    thread::spawn(move || {
        thread::sleep(PAUSE + Duration::from_secs(1));
        let paused = app.state::<AppState>().core.lock().unwrap().is_paused(Instant::now());
        let _ = item.set_checked(paused);
    });
}

pub fn run() {
    tauri::Builder::default()
        // Une seule instance : une seconde écouterait sur le même port.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            app.state::<AppState>().log("seconde instance ignorée");
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![overlay_ready, island_state, set_interactive, activate, close])
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = app.path().app_data_dir()?;
            let settings = store::load(&dir)?;
            app.manage(AppState {
                core: Mutex::new(Core::default()),
                dir: settings.dir.clone(),
                island_visible: AtomicBool::new(false),
                island_hwnd: AtomicIsize::new(0),
                cursor_thread: OnceLock::new(),
            });
            let state = app.state::<AppState>();
            state.log(&format!("démarrage, port {}", settings.port));

            // Lancement au démarrage : activé au premier lancement d'un build de production,
            // puis réécrit à chaque lancement s'il est actif, pour pointer sur l'exécutable
            // courant (une mise à jour peut le déplacer). Jamais en build de développement, qui
            // détournerait l'entrée vers son propre exécutable.
            if !cfg!(debug_assertions) {
                let launcher = app.autolaunch();
                if !settings.autostart_initialized || launcher.is_enabled().unwrap_or(false) {
                    let enabled = launcher.enable();
                    state.log(&format!("lancement au démarrage → {enabled:?}"));
                    store::mark_autostart_initialized(&settings.dir);
                }
            }

            create_island(&handle)?;
            spawn_cursor_poller(handle.clone());
            #[cfg(windows)]
            watch_foreground(handle.clone());

            let events = handle.clone();
            let tooltip = match server::start(settings.port, settings.token, move |e| dispatch(&events, e)) {
                Ok(()) => format!("ReversePrompt — à l'écoute sur 127.0.0.1:{}", settings.port),
                Err(e) => {
                    state.log(&format!("serveur : {e}"));
                    format!("ReversePrompt — serveur arrêté : {e}")
                }
            };
            build_tray(&handle, &tooltip)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("échec du lancement de l'app");
}
