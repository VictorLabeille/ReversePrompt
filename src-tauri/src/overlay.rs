// Fenêtre overlay, côté Win32 : ce que Tauri ne règle pas seul.
//
// - Jamais activable (WS_EX_NOACTIVATE) : l'afficher ou cliquer dessus ne vole pas le focus et
//   ne fait pas sortir une vidéo du plein écran.
// - Absente d'Alt+Tab (WS_EX_TOOLWINDOW).
// - Au premier plan, niveau le plus haut, réaffirmé à chaque apparition.
//
// Piège : Tauri (tao) recalcule tout le style étendu quand il change un de ses propres
// réglages (clics traversants, par exemple) et efface ces bits. `apply_styles` se rappelle
// donc après chaque changement de ce genre.

use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE,
    HWND_TOPMOST, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE,
    WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

pub fn apply_styles(hwnd: HWND) {
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let wanted = (ex | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize) & !(WS_EX_APPWINDOW.0 as isize);
        if wanted != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted);
        }
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

// Affiche sans activer.
pub fn show(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    raise(hwnd);
}

// Repasse au-dessus de toutes les fenêtres « toujours au premier plan » (vidéo plein écran).
pub fn raise(hwnd: HWND) {
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

// Position du curseur en pixels logiques, dans le repère de la fenêtre (sans bordure, donc
// fenêtre = zone cliente).
pub fn cursor_in_window(hwnd: HWND) -> Option<(f64, f64)> {
    unsafe {
        let mut p = POINT::default();
        let mut r = RECT::default();
        GetCursorPos(&mut p).ok()?;
        GetWindowRect(hwnd, &mut r).ok()?;
        let dpi = GetDpiForWindow(hwnd);
        let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
        Some(((p.x - r.left) as f64 / scale, (p.y - r.top) as f64 / scale))
    }
}
