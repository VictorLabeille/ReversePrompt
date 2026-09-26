// Retrouver et ramener au premier plan la fenêtre d'un agent, et surveiller le premier plan.
// Méthode et pièges : docs/windows-focus.md.

use std::sync::OnceLock;
use std::thread;

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, TRUE};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, SendInput, INPUT, INPUT_MOUSE, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, DispatchMessageW, EnumWindows, GetForegroundWindow, GetMessageW, GetWindow,
    GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    SetForegroundWindow, ShowWindow, TranslateMessage, EVENT_SYSTEM_FOREGROUND, GWL_EXSTYLE, GW_OWNER, MSG,
    SW_RESTORE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WS_EX_TOOLWINDOW,
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

fn window_title(hwnd: HWND) -> String {
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

// La fenêtre la plus récemment active du programme `process` ; parmi elles, celle dont le
// titre contient `title` si possible.
pub fn find_window(process: &str, title: Option<&str>) -> Option<HWND> {
    let candidates: Vec<HWND> = top_level_windows()
        .into_iter()
        .filter(|&h| is_app_window(h))
        .filter(|&h| process_name(h).is_some_and(|p| p.eq_ignore_ascii_case(process)))
        .collect();
    if let Some(t) = title {
        let t = t.to_lowercase();
        if let Some(&h) = candidates.iter().find(|&&h| window_title(h).to_lowercase().contains(&t)) {
            return Some(h);
        }
    }
    candidates.first().copied()
}

// Ramène la fenêtre au premier plan, en la restaurant si elle est réduite.
//
// Windows refuse `SetForegroundWindow` à un processus qui n'a pas reçu la dernière entrée
// utilisateur. Or le clic sur l'île arrive dans la fenêtre de WebView2, qui appartient à un
// autre processus (msedgewebview2.exe). D'où trois tentatives, de la plus propre à la plus
// forcée ; chacune est vérifiée par `GetForegroundWindow`.
pub fn bring_to_front(hwnd: HWND) -> &'static str {
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

type ForegroundCallback = Box<dyn Fn(HWND) + Send + Sync>;
static ON_FOREGROUND: OnceLock<ForegroundCallback> = OnceLock::new();

unsafe extern "system" fn on_foreground(_: HWINEVENTHOOK, _: u32, hwnd: HWND, _: i32, _: i32, _: u32, _: u32) {
    if let Some(cb) = ON_FOREGROUND.get() {
        cb(hwnd);
    }
}

// Appelle `callback` à chaque changement de fenêtre au premier plan (hors fenêtres de l'app).
// Un seul abonnement par processus ; le fil a sa propre boucle de messages.
pub fn watch_foreground(callback: impl Fn(HWND) + Send + Sync + 'static) {
    if ON_FOREGROUND.set(Box::new(callback)).is_err() {
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
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}
