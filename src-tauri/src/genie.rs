//! macOS-style "genie" window animations (minimize, restore, open, close).
//!
//! Windows cannot animate other applications' windows, so the effect is an
//! overlay: a transparent, click-through window ("genie") that covers one
//! monitor and plays the animation using a snapshot of the app window, which is
//! kept warm in `SNAPS`. For restore / open the real window is made fully
//! transparent while the overlay plays and revealed at the end (with a watchdog
//! that always reveals it again).
//!
//! The whole feature is controlled by the `bloom-dock-openclose-anim` setting.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{CloseHandle, COLORREF, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    DWMWA_TRANSITIONS_FORCEDISABLED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::SetWinEventHook;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetClassNameW, GetWindow, GetWindowLongA, GetWindowThreadProcessId,
    IsIconic, IsWindow, IsWindowVisible, SetLayeredWindowAttributes, SetWindowLongA, SetWindowPos,
    EVENT_OBJECT_DESTROY, EVENT_OBJECT_SHOW, EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND,
    EVENT_SYSTEM_MINIMIZESTART, GA_ROOT, GWL_EXSTYLE, GWL_STYLE, GW_OWNER, LWA_ALPHA,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WINEVENT_OUTOFCONTEXT,
    WS_CAPTION, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_THICKFRAME,
};

const SETTING_KEY: &str = "bloom-dock-openclose-anim";
const GENIE_LABEL: &str = "genie";

static APP: OnceLock<AppHandle> = OnceLock::new();
static READY: AtomicBool = AtomicBool::new(false);
static BUSY_UNTIL: AtomicI64 = AtomicI64::new(0);

#[derive(Clone)]
struct Snap {
    image: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    at: i64,
}

static SNAPS: Mutex<Option<HashMap<isize, Snap>>> = Mutex::new(None);
static SEEN: Mutex<Option<HashSet<isize>>> = Mutex::new(None);
static HIDDEN: Mutex<Option<HashSet<isize>>> = Mutex::new(None);
static PENDING: Mutex<Option<HashMap<isize, String>>> = Mutex::new(None);

#[derive(Deserialize)]
pub struct GenieRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Serialize, Clone, Copy)]
struct CssRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn now_ms() -> i64 {
    crate::utils::get_now_ms()
}

fn enabled() -> bool {
    match APP.get() {
        Some(app) => crate::utils::get_setting_str(app, SETTING_KEY).as_deref() == Some("true"),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

/// A normal, user-facing application window (not a tool window, popup, owned
/// dialog, shell window or Bloom itself).
unsafe fn is_trackable(hwnd: HWND) -> bool {
    if hwnd.0.is_null() || !IsWindow(Some(hwnd)).as_bool() || !IsWindowVisible(hwnd).as_bool() {
        return false;
    }
    if GetAncestor(hwnd, GA_ROOT) != hwnd {
        return false;
    }
    if let Ok(owner) = GetWindow(hwnd, GW_OWNER) {
        if !owner.0.is_null() {
            return false;
        }
    }
    let ex = GetWindowLongA(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_TOOLWINDOW.0 != 0 {
        return false;
    }
    let style = GetWindowLongA(hwnd, GWL_STYLE) as u32;
    if style & WS_CAPTION.0 != WS_CAPTION.0 && style & WS_THICKFRAME.0 == 0 {
        return false;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut _ as *mut _,
        4,
    )
    .is_ok()
        && cloaked != 0
    {
        return false;
    }
    let mut class = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut class).max(0) as usize;
    let name = String::from_utf16_lossy(&class[..n.min(64)]);
    if matches!(
        name.as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    ) {
        return false;
    }
    match frame_rect(hwnd) {
        Some((_, _, w, h)) => w >= 200 && h >= 120,
        None => false,
    }
}

unsafe fn frame_rect(hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
    let mut r = RECT::default();
    DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut r as *mut _ as *mut _,
        std::mem::size_of::<RECT>() as u32,
    )
    .ok()?;
    Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
}

unsafe fn disable_transitions(hwnd: HWND) {
    let v: i32 = 1;
    let _ = DwmSetWindowAttribute(
        hwnd,
        DWMWA_TRANSITIONS_FORCEDISABLED,
        &v as *const _ as *const _,
        4,
    );
}

/// Makes the window fully transparent (it keeps rendering and receiving input).
unsafe fn hide_window(hwnd: HWND) -> bool {
    let ex = GetWindowLongA(hwnd, GWL_EXSTYLE);
    if ex & WS_EX_LAYERED.0 as i32 != 0 {
        return false; // already layered by the app: leave it alone
    }
    SetWindowLongA(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED.0 as i32);
    if SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_ALPHA).is_err() {
        SetWindowLongA(hwnd, GWL_EXSTYLE, ex);
        return false;
    }
    if let Ok(mut g) = HIDDEN.lock() {
        g.get_or_insert_with(HashSet::new).insert(hwnd.0 as isize);
    }
    true
}

unsafe fn unhide_window(raw: isize) {
    let was_hidden = HIDDEN
        .lock()
        .ok()
        .map(|mut g| g.get_or_insert_with(HashSet::new).remove(&raw))
        .unwrap_or(false);
    if !was_hidden {
        return;
    }
    let hwnd = HWND(raw as *mut _);
    if !IsWindow(Some(hwnd)).as_bool() {
        return;
    }
    let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
    let ex = GetWindowLongA(hwnd, GWL_EXSTYLE);
    SetWindowLongA(hwnd, GWL_EXSTYLE, ex & !(WS_EX_LAYERED.0 as i32));
    let _ = SetWindowPos(
        hwnd,
        None,
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
    );
}

fn unhide_all() {
    let all: Vec<isize> = HIDDEN
        .lock()
        .ok()
        .map(|g| g.as_ref().map(|s| s.iter().copied().collect()).unwrap_or_default())
        .unwrap_or_default();
    for raw in all {
        unsafe { unhide_window(raw) };
    }
}

unsafe fn exe_of(hwnd: HWND) -> String {
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return String::new();
    }
    let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
        return String::new();
    };
    let mut buf = [0u16; 520];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_WIN32,
        windows::core::PWSTR(buf.as_mut_ptr()),
        &mut len,
    )
    .is_ok();
    let _ = CloseHandle(handle);
    if ok {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

fn capture_snap(raw: isize) {
    let hwnd = HWND(raw as *mut _);
    unsafe {
        if !is_trackable(hwnd) || IsIconic(hwnd).as_bool() {
            return;
        }
        let Some((x, y, w, h)) = frame_rect(hwnd) else {
            return;
        };
        let Some(image) = crate::utils::capture_hwnd_to_base64(hwnd, 1100, 700) else {
            return;
        };
        let first = SNAPS
            .lock()
            .ok()
            .map(|g| !g.as_ref().map(|m| m.contains_key(&raw)).unwrap_or(false))
            .unwrap_or(false);
        if first {
            disable_transitions(hwnd);
        }
        if let Ok(mut g) = SNAPS.lock() {
            let map = g.get_or_insert_with(HashMap::new);
            map.insert(
                raw,
                Snap {
                    image,
                    x,
                    y,
                    w,
                    h,
                    at: now_ms(),
                },
            );
            if map.len() > 12 {
                map.retain(|&k, _| IsWindow(Some(HWND(k as *mut _))).as_bool());
            }
        }
        if let Ok(mut g) = SEEN.lock() {
            g.get_or_insert_with(HashSet::new).insert(raw);
        }
    }
}

fn snap_of(raw: isize) -> Option<Snap> {
    SNAPS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|m| m.get(&raw).cloned()))
}

// ---------------------------------------------------------------------------
// Window events
// ---------------------------------------------------------------------------

unsafe extern "system" fn genie_proc(
    _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    if hwnd.0.is_null() {
        return;
    }
    if (event == EVENT_OBJECT_SHOW || event == EVENT_OBJECT_DESTROY)
        && (id_object != 0 || id_child != 0)
    {
        return;
    }
    if !enabled() {
        return;
    }
    let raw = hwnd.0 as isize;

    if event == EVENT_SYSTEM_FOREGROUND {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(160));
            capture_snap(raw);
        });
    } else if event == EVENT_SYSTEM_MINIMIZESTART {
        if snap_of(raw).is_some() && now_ms() >= BUSY_UNTIL.load(Ordering::Relaxed) {
            std::thread::spawn(move || request("minimize", raw));
        }
    } else if event == EVENT_SYSTEM_MINIMIZEEND {
        if snap_of(raw).is_some()
            && now_ms() >= BUSY_UNTIL.load(Ordering::Relaxed)
            && is_trackable(hwnd)
            && hide_window(hwnd)
        {
            std::thread::spawn(move || request("restore", raw));
        }
    } else if event == EVENT_OBJECT_SHOW {
        let already = SEEN
            .lock()
            .ok()
            .map(|g| g.as_ref().map(|s| s.contains(&raw)).unwrap_or(false))
            .unwrap_or(true);
        if already || IsIconic(hwnd).as_bool() || !is_trackable(hwnd) {
            return;
        }
        if now_ms() < BUSY_UNTIL.load(Ordering::Relaxed) {
            return;
        }
        if let Ok(mut g) = SEEN.lock() {
            g.get_or_insert_with(HashSet::new).insert(raw);
        }
        if !hide_window(hwnd) {
            return;
        }
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(320));
            capture_snap(raw);
            if snap_of(raw).is_some() {
                request("open", raw);
            } else {
                unsafe { unhide_window(raw) };
            }
        });
    } else if event == EVENT_OBJECT_DESTROY {
        let snap = SNAPS
            .lock()
            .ok()
            .and_then(|mut g| g.as_mut().and_then(|m| m.remove(&raw)));
        if let Ok(mut g) = SEEN.lock() {
            if let Some(s) = g.as_mut() {
                s.remove(&raw);
            }
        }
        if let Some(snap) = snap {
            if now_ms() >= BUSY_UNTIL.load(Ordering::Relaxed) && now_ms() - snap.at < 20_000 {
                std::thread::spawn(move || play_snap("close", raw, snap, None));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

fn monitor_for_point(app: &AppHandle, px: i32, py: i32) -> Option<tauri::Monitor> {
    let monitors = app.available_monitors().ok()?;
    for m in &monitors {
        let p = m.position();
        let s = m.size();
        if px >= p.x && px < p.x + s.width as i32 && py >= p.y && py < p.y + s.height as i32 {
            return Some(m.clone());
        }
    }
    app.primary_monitor().ok().flatten()
}

/// Asks the dock on the window's monitor where its icon is; falls back to a
/// default target if it does not answer in time.
fn request(kind: &str, raw: isize) {
    let Some(app) = APP.get() else { return };
    let Some(snap) = snap_of(raw) else {
        unsafe { unhide_window(raw) };
        return;
    };
    let center = (snap.x + snap.w / 2, snap.y + snap.h / 2);
    let mut label = "dock".to_string();
    if let (Ok(monitors), Some(primary)) = (app.available_monitors(), app.primary_monitor().ok().flatten())
    {
        let pp = (primary.position().x, primary.position().y);
        for (index, m) in monitors.iter().enumerate() {
            let p = m.position();
            let s = m.size();
            let inside = center.0 >= p.x
                && center.0 < p.x + s.width as i32
                && center.1 >= p.y
                && center.1 < p.y + s.height as i32;
            if inside && (p.x, p.y) != pp {
                let candidate = format!("dock-m{}", index);
                if app.get_webview_window(&candidate).is_some() {
                    label = candidate;
                }
            }
        }
    }
    if let Ok(mut g) = PENDING.lock() {
        g.get_or_insert_with(HashMap::new)
            .insert(raw, kind.to_string());
    }
    let exe = unsafe { exe_of(HWND(raw as *mut _)) };
    let _ = app.emit_to(
        label.as_str(),
        "genie-request",
        serde_json::json!({ "kind": kind, "hwnd": raw, "exe": exe }),
    );

    // Dock did not answer: use a default target.
    std::thread::sleep(std::time::Duration::from_millis(400));
    let still_pending = PENDING
        .lock()
        .ok()
        .and_then(|mut g| g.as_mut().and_then(|m| m.remove(&raw)))
        .is_some();
    if still_pending {
        play(kind, raw, None);
    }
}

#[tauri::command]
pub fn genie_play(
    app: AppHandle,
    kind: String,
    hwnd: isize,
    label: String,
    icon: Option<GenieRect>,
) {
    let was_pending = PENDING
        .lock()
        .ok()
        .and_then(|mut g| g.as_mut().and_then(|m| m.remove(&hwnd)))
        .is_some();
    if !was_pending {
        return; // already played with the default target
    }
    // Convert the icon rect from the dock page's CSS px to screen physical px.
    let screen = icon.and_then(|r| {
        let win = app.get_webview_window(&label)?;
        let pos = win.inner_position().ok()?;
        let sf = win.scale_factor().ok()?;
        Some((
            pos.x + (r.x * sf).round() as i32,
            pos.y + (r.y * sf).round() as i32,
            (r.w * sf).round() as i32,
            (r.h * sf).round() as i32,
        ))
    });
    std::thread::spawn(move || play(&kind, hwnd, screen));
}

fn play(kind: &str, raw: isize, icon: Option<(i32, i32, i32, i32)>) {
    let Some(snap) = snap_of(raw) else {
        unsafe { unhide_window(raw) };
        return;
    };
    play_snap(kind, raw, snap, icon);
}

fn play_snap(kind: &str, raw: isize, mut snap: Snap, icon: Option<(i32, i32, i32, i32)>) {
    let Some(app) = APP.get() else {
        unsafe { unhide_window(raw) };
        return;
    };
    let abort = |reason: &str| {
        let _ = reason;
        unsafe { unhide_window(raw) };
    };
    if !READY.load(Ordering::Relaxed) || now_ms() < BUSY_UNTIL.load(Ordering::Relaxed) {
        return abort("not ready");
    }
    let Some(win) = app.get_webview_window(GENIE_LABEL) else {
        return abort("no window");
    };

    // For restore / open the window is on screen now: use its real rect.
    if kind == "restore" || kind == "open" {
        if let Some((x, y, w, h)) = unsafe { frame_rect(HWND(raw as *mut _)) } {
            if w > 100 && h > 80 {
                snap.x = x;
                snap.y = y;
                snap.w = w;
                snap.h = h;
            }
        }
    }

    let Some(monitor) = (match icon {
        Some((ix, iy, iw, ih)) => monitor_for_point(app, ix + iw / 2, iy + ih / 2),
        None => monitor_for_point(app, snap.x + snap.w / 2, snap.y + snap.h / 2),
    }) else {
        return abort("no monitor");
    };
    let mp = *monitor.position();
    let ms = *monitor.size();
    let sf = monitor.scale_factor().max(0.5);

    let target = icon.unwrap_or((
        mp.x + ms.width as i32 / 2 - 24,
        mp.y + ms.height as i32 - 56,
        48,
        48,
    ));

    let to_css = |x: i32, y: i32, w: i32, h: i32| CssRect {
        x: (x - mp.x) as f64 / sf,
        y: (y - mp.y) as f64 / sf,
        w: w as f64 / sf,
        h: h as f64 / sf,
    };
    let duration: i64 = if kind == "close" { 240 } else { 560 };
    BUSY_UNTIL.store(now_ms() + duration + 500, Ordering::Relaxed);

    let _ = win.set_position(tauri::PhysicalPosition::new(mp.x, mp.y));
    let _ = win.set_size(tauri::PhysicalSize::new(ms.width, ms.height));
    let _ = win.set_ignore_cursor_events(true);
    let _ = win.show();
    if let Ok(hwnd) = win.hwnd() {
        crate::utils::re_assert_topmost(hwnd);
    }

    let _ = app.emit_to(
        GENIE_LABEL,
        "genie-play",
        serde_json::json!({
            "kind": kind,
            "image": snap.image,
            "from": to_css(snap.x, snap.y, snap.w, snap.h),
            "to": to_css(target.0, target.1, target.2, target.3),
            "duration": duration,
        }),
    );

    // Watchdog: whatever happens, the real window comes back.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis((duration + 1300) as u64));
        unhide_all();
        if now_ms() >= BUSY_UNTIL.load(Ordering::Relaxed) {
            if let Some(w) = handle.get_webview_window(GENIE_LABEL) {
                let _ = w.hide();
            }
        }
    });
}

/// The overlay finished drawing: reveal the real window.
#[tauri::command]
pub fn genie_reveal() {
    unhide_all();
}

/// The overlay is cleared: hide its window.
#[tauri::command]
pub fn genie_done(app: AppHandle) {
    unhide_all();
    if let Some(w) = app.get_webview_window(GENIE_LABEL) {
        let _ = w.hide();
    }
    BUSY_UNTIL.store(now_ms() + 50, Ordering::Relaxed);
}

#[tauri::command]
pub fn genie_ready() {
    READY.store(true, Ordering::Relaxed);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/// Creates the (hidden) overlay window when the feature is enabled.
pub fn ensure_window(app: &AppHandle) {
    if !enabled() || app.get_webview_window(GENIE_LABEL).is_some() {
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(
        app,
        GENIE_LABEL,
        tauri::WebviewUrl::App("genie.html".into()),
    )
    .title("Bloom Genie")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .focused(false)
    .visible(false)
    .inner_size(300.0, 200.0)
    .build();
    if let Ok(win) = built {
        let _ = win.set_ignore_cursor_events(true);
    }
}

/// Runs `ensure_window` off the calling thread (window creation must not block).
pub fn ensure_window_async(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_window(&app));
}

unsafe extern "system" fn seed_proc(hwnd: HWND, _lparam: LPARAM) -> windows::core::BOOL {
    if is_trackable(hwnd) {
        if let Ok(mut g) = SEEN.lock() {
            g.get_or_insert_with(HashSet::new).insert(hwnd.0 as isize);
        }
    }
    true.into()
}

pub fn setup(app: AppHandle) {
    let _ = APP.set(app.clone());

    // Windows that already exist must not play the "open" animation.
    unsafe {
        let _ = EnumWindows(Some(seed_proc), LPARAM(0));

        for (from, to) in [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            (EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW),
            (EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY),
        ] {
            let hook = SetWinEventHook(
                from,
                to,
                None,
                Some(genie_proc),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            Box::leak(Box::new(hook));
        }
    }

    // Keep the snapshot of the foreground window fresh while the user works.
    let refresher = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        if !enabled() {
            continue;
        }
        unsafe {
            let fg = windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
            if is_trackable(fg) && !IsIconic(fg).as_bool() {
                capture_snap(fg.0 as isize);
            }
        }
        let _ = &refresher;
    });

    // The settings cache is ready by now; create the overlay window if needed.
    ensure_window_async(&app);
}
