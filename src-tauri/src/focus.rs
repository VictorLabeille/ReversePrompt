// Retrouver et ramener au premier plan la fenêtre d'un agent, et surveiller le premier plan.
// Méthode et pièges : docs/windows-focus.md.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::thread;

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, TRUE, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationSelectionItemPattern, SetWinEventHook, TreeScope_Descendants, HWINEVENTHOOK,
    UIA_SelectionItemPatternId, UIA_TabItemControlTypeId,
};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, SendInput, INPUT, INPUT_MOUSE, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CallNextHookEx, DispatchMessageW, EnumWindows, GetAncestor, GetForegroundWindow, GetMessageW, GetWindow,
    GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    SetForegroundWindow, SetWindowsHookExW, ShowWindow, TranslateMessage, WindowFromPoint, EVENT_OBJECT_NAMECHANGE,
    EVENT_SYSTEM_DESKTOPSWITCH, EVENT_SYSTEM_FOREGROUND, GA_ROOT, GWL_EXSTYLE, GW_OWNER, HC_ACTION, MSG, MSLLHOOKSTRUCT,
    OBJID_WINDOW, SW_RESTORE, WH_MOUSE_LL, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_LBUTTONDOWN, WM_MBUTTONDOWN,
    WM_RBUTTONDOWN, WS_EX_TOOLWINDOW,
};
use windows::core::BOOL;

// Nom de l'exécutable qui possède la fenêtre (« WindowsTerminal.exe »).
pub fn process_name(hwnd: HWND) -> Option<String> {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(handle);
        ok.ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().map(str::to_owned)
    }
}

pub fn window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }
}

// Fenêtre principale d'application : visible (ou réduite), sans propriétaire, pas une palette.
fn is_app_window(hwnd: HWND) -> bool {
    unsafe {
        IsWindowVisible(hwnd).as_bool()
            && GetWindow(hwnd, GW_OWNER).map_or(true, |o| o.is_invalid())
            && GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW.0 as isize == 0
            && GetWindowTextLengthW(hwnd) > 0
    }
}

// Fenêtres de haut niveau, de la plus haute à la plus basse dans l'ordre Z : la première est
// la plus récemment active.
fn top_level_windows() -> Vec<HWND> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = &mut *(lparam.0 as *mut Vec<HWND>);
        list.push(hwnd);
        TRUE
    }
    let mut list: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut list as *mut _ as isize));
    }
    list
}

fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

// Ramène la cible d'un clic : la fenêtre du programme `process` dont le titre contient `title`,
// sinon celle dont un **onglet** le contient (onglet sélectionné d'abord), sinon la plus
// récemment active du programme. Rend la méthode employée, pour le journal.
pub fn activate(process: &str, title: Option<&str>) -> String {
    let candidates: Vec<HWND> = top_level_windows()
        .into_iter()
        .filter(|&h| is_app_window(h))
        .filter(|&h| process_name(h).is_some_and(|p| p.eq_ignore_ascii_case(process)))
        .collect();
    if let Some(t) = title {
        if let Some(&h) = candidates.iter().find(|&&h| contains_ci(&window_title(h), t)) {
            return format!("onglet déjà actif, {}", bring_to_front(h));
        }
        if let Some(&h) = candidates.iter().find(|&&h| select_tab(h, t)) {
            return format!("onglet sélectionné, {}", bring_to_front(h));
        }
    }
    match candidates.first() {
        Some(&h) if title.is_some() => format!("onglet introuvable, fenêtre : {}", bring_to_front(h)),
        Some(&h) => bring_to_front(h).to_owned(),
        None => "aucune fenêtre trouvée".to_owned(),
    }
}

// Sélectionne, dans la fenêtre `hwnd`, l'onglet dont le nom contient `fragment`, par UI
// Automation (Windows Terminal : élément `TabItem`, motif SelectionItem ; docs/windows-focus.md).
// On parcourt tous les descendants et on filtre sur le type : pas de VARIANT à construire.
fn select_tab(hwnd: HWND, fragment: &str) -> bool {
    unsafe {
        let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let found = (|| -> windows::core::Result<bool> {
            let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let all = uia.ElementFromHandle(hwnd)?.FindAll(TreeScope_Descendants, &uia.CreateTrueCondition()?)?;
            for i in 0..all.Length()? {
                let el = all.GetElement(i)?;
                if el.CurrentControlType()? != UIA_TabItemControlTypeId || !contains_ci(&el.CurrentName()?.to_string(), fragment) {
                    continue;
                }
                el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)?.Select()?;
                return Ok(true);
            }
            Ok(false)
        })()
        .unwrap_or(false);
        if com {
            CoUninitialize();
        }
        found
    }
}

// Ramène la fenêtre au premier plan, en la restaurant si elle est réduite.
//
// Windows refuse `SetForegroundWindow` à un processus qui n'a pas reçu la dernière entrée
// utilisateur. Or le clic sur l'île arrive dans la fenêtre de WebView2, qui appartient à un
// autre processus (msedgewebview2.exe). D'où trois tentatives, de la plus propre à la plus
// forcée ; chacune est vérifiée par `GetForegroundWindow`.
fn bring_to_front(hwnd: HWND) -> &'static str {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd).as_bool() && GetForegroundWindow() == hwnd {
            return "direct";
        }
        // Une entrée souris vide, injectée par ce processus, fait de lui le destinataire de la
        // dernière entrée : le verrou tombe (méthode de PowerToys). Aucune touche simulée, donc
        // pas de menu Alt qui s'ouvre dans l'app visée.
        let input = INPUT { r#type: INPUT_MOUSE, ..Default::default() };
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        if SetForegroundWindow(hwnd).as_bool() && GetForegroundWindow() == hwnd {
            return "entrée injectée";
        }
        // Dernier recours : partager la file d'entrée du premier plan actuel le temps de l'appel.
        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let me = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        if attached {
            let _ = AttachThreadInput(me, fg_thread, false);
        }
        if GetForegroundWindow() == hwnd {
            "file d'entrée partagée"
        } else {
            "échec"
        }
    }
}

// Millisecondes écoulées depuis la dernière entrée clavier ou souris de l'utilisateur.
// Sert à distinguer un changement de premier plan voulu (Alt+Tab, clic dans la barre des tâches)
// d'un changement subi (une notification Windows qui disparaît rend le premier plan à la
// fenêtre d'avant ; au verrouillage, Windows le redonne aussi sans action de l'utilisateur).
pub fn ms_since_last_input() -> u32 {
    unsafe {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if !GetLastInputInfo(&mut info).as_bool() {
            return u32::MAX;
        }
        GetTickCount().wrapping_sub(info.dwTime)
    }
}

// Instant (GetTickCount) du dernier changement de bureau : verrouillage, déverrouillage, écran
// d'élévation. 0 : aucun depuis le lancement.
static LAST_DESKTOP_SWITCH: AtomicU32 = AtomicU32::new(0);

// Millisecondes depuis le dernier changement de bureau. Au déverrouillage, le mot de passe
// tapé compte comme une entrée et Windows rend le premier plan au terminal : sans ce délai,
// l'île partait au moment précis où l'utilisateur revenait la voir.
pub fn ms_since_desktop_switch() -> u32 {
    match LAST_DESKTOP_SWITCH.load(Ordering::Relaxed) {
        0 => u32::MAX,
        t => unsafe { GetTickCount() }.wrapping_sub(t),
    }
}

unsafe extern "system" fn on_desktop_switch(_: HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
    LAST_DESKTOP_SWITCH.store(GetTickCount().max(1), Ordering::Relaxed);
}

type ForegroundCallback = Box<dyn Fn(HWND) + Send + Sync>;
static ON_FOREGROUND: OnceLock<ForegroundCallback> = OnceLock::new();
type ClickCallback = Box<dyn Fn(HWND) + Send + Sync>;
static ON_CLICK: OnceLock<ClickCallback> = OnceLock::new();

unsafe extern "system" fn on_foreground(_: HWINEVENTHOOK, _: u32, hwnd: HWND, _: i32, _: i32, _: u32, _: u32) {
    if let Some(cb) = ON_FOREGROUND.get() {
        cb(hwnd);
    }
}

// Titre changé : ne compte que celui de la fenêtre au premier plan elle-même. Dans Windows
// Terminal, changer d'onglet change le titre de la fenêtre sans changer de premier plan.
unsafe extern "system" fn on_name_change(_: HWINEVENTHOOK, _: u32, hwnd: HWND, id_object: i32, id_child: i32, _: u32, _: u32) {
    if id_object != OBJID_WINDOW.0 || id_child != 0 || hwnd.is_invalid() || hwnd != GetForegroundWindow() {
        return;
    }
    if let Some(cb) = ON_FOREGROUND.get() {
        cb(hwnd);
    }
}

// Clic dans la fenêtre déjà au premier plan : Windows n'émet aucun changement de premier plan,
// c'est le seul signal que l'utilisateur y est revenu. Un clic ailleurs change le premier plan
// et passe par `on_foreground`. Le crochet doit rendre la main vite : il retarde toute la souris.
unsafe extern "system" fn on_mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && matches!(wparam.0 as u32, WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN) {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let root = GetAncestor(WindowFromPoint(POINT { x: info.pt.x, y: info.pt.y }), GA_ROOT);
        if !root.is_invalid() && root == GetForegroundWindow() {
            if let Some(cb) = ON_CLICK.get() {
                cb(root);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

// Appelle `on_change` à chaque changement de fenêtre au premier plan ou de son titre (hors
// fenêtres de l'app), et `on_click` à chaque clic dans la fenêtre déjà au premier plan.
// Un seul abonnement par processus ; le fil a sa propre boucle de messages.
pub fn watch_foreground(
    on_change: impl Fn(HWND) + Send + Sync + 'static,
    on_click: impl Fn(HWND) + Send + Sync + 'static,
) {
    if ON_FOREGROUND.set(Box::new(on_change)).is_err() || ON_CLICK.set(Box::new(on_click)).is_err() {
        return;
    }
    let _ = thread::Builder::new().name("foreground-watch".into()).spawn(|| unsafe {
        let _hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(on_foreground),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        let _name_hook = SetWinEventHook(
            EVENT_OBJECT_NAMECHANGE,
            EVENT_OBJECT_NAMECHANGE,
            None,
            Some(on_name_change),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        let _mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), None, 0);
        let _desktop_hook = SetWinEventHook(
            EVENT_SYSTEM_DESKTOPSWITCH,
            EVENT_SYSTEM_DESKTOPSWITCH,
            None,
            Some(on_desktop_switch),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}
