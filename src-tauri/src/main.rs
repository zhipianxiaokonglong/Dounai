//! Dounai 桌面悬浮窗主进程。
//!
//! 职责（对应 docs/architecture.md）：
//!  - 创建无边框、透明、置顶、跳过任务栏的悬浮窗；
//!  - 托盘菜单：显示/隐藏、勿扰模式、置顶开关、退出；
//!  - 全局快捷键唤起；
//!  - 窗口贴边吸附；
//!  - **不做**任何对话内容的持久化或日志写入（隐私要求）。

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Position, Runtime, WebviewWindow, WindowEvent,
};

mod proxy;

const WIN_W: f64 = 360.0;
const WIN_H: f64 = 420.0;
/// 距离屏幕边缘多少像素内触发吸附
const SNAP_THRESHOLD: i32 = 24;

#[derive(Default)]
struct AppState {
    do_not_disturb: Mutex<bool>,
    always_on_top: Mutex<bool>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            do_not_disturb: Mutex::new(false),
            always_on_top: Mutex::new(true),
        })
        .setup(|app| {
            let window = build_window(app.handle())?;
            attach_window_events(&window);
            build_tray(app.handle())?;
            register_shortcuts(app.handle())?;
            // 启动即显示：本产品是常驻桌面的悬浮窗，用户双击图标后应当直接看到它。
            // 窗口以 visible(false) 建出，是为了等位置算好再显示，避免在默认位置闪一下。
            place_bottom_right(&window);
            let _ = window.show();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_panel_visible,
            get_settings,
            set_do_not_disturb,
            set_always_on_top,
            hide_window,
            quit_app,
            proxy::upstream_request,
        ])
        .run(tauri::generate_context!())
        .expect("Dounai 启动失败：无法初始化主进程");
}

/// 创建悬浮窗。参数含义见需求：默认 logo 静默悬浮，无边框、透明、置顶、不占任务栏。
fn build_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("Dounai")
        .inner_size(WIN_W, WIN_H)
        .min_inner_size(280.0, 240.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .shadow(false)
        .visible(false)
        .build()
}

/// 窗口事件：贴边吸附 + 关闭即隐藏（托盘常驻）。
fn attach_window_events<R: Runtime>(window: &WebviewWindow<R>) {
    let handle = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            // 关闭按钮不退出进程：悬浮窗常驻，退出走托盘菜单
            api.prevent_close();
            let _ = handle.hide();
        }
        WindowEvent::Moved(position) => {
            if let Some(snapped) = snap_to_edges(&handle, *position) {
                let _ = handle.set_position(Position::Physical(snapped));
            }
        }
        _ => {}
    });
}

/// 把悬浮窗放到主显示器右下角，并留出任务栏余量。
///
/// 首次启动如果沿用系统默认位置，会出现在屏幕中央偏上，与「桌面宠物」的预期位置不符，
/// 也容易挡住用户正在看的窗口。
fn place_bottom_right<R: Runtime>(window: &WebviewWindow<R>) {
    use tauri::PhysicalPosition;

    let Some(monitor) = window.current_monitor().ok().flatten() else {
        return;
    };
    let screen = monitor.size();
    let origin = monitor.position();
    let Ok(size) = window.outer_size() else {
        return;
    };

    // 90px 给任务栏留白，避免贴死屏幕底部
    const MARGIN: i32 = 24;
    const TASKBAR: i32 = 90;

    let x = origin.x + screen.width as i32 - size.width as i32 - MARGIN;
    let y = origin.y + screen.height as i32 - size.height as i32 - TASKBAR;
    let _ = window.set_position(Position::Physical(PhysicalPosition::new(x.max(origin.x), y.max(origin.y))));
}

/// 贴边吸附：靠近屏幕左右/上下边缘时对齐，减少「悬浮窗卡在半空」的别扭感。
fn snap_to_edges<R: Runtime>(
    window: &WebviewWindow<R>,
    position: PhysicalPosition<i32>,
) -> Option<PhysicalPosition<i32>> {
    let monitor = window.current_monitor().ok().flatten()?;
    let screen = monitor.size();
    let origin = monitor.position();
    let size = window.outer_size().ok()?;

    let left = origin.x;
    let right = origin.x + screen.width as i32;
    let top = origin.y;
    let bottom = origin.y + screen.height as i32;

    let mut x = position.x;
    let mut y = position.y;
    let mut changed = false;

    if (x - left).abs() <= SNAP_THRESHOLD {
        x = left;
        changed = true;
    } else if (right - (x + size.width as i32)).abs() <= SNAP_THRESHOLD {
        x = right - size.width as i32;
        changed = true;
    }

    if (y - top).abs() <= SNAP_THRESHOLD {
        y = top;
        changed = true;
    } else if (bottom - (y + size.height as i32)).abs() <= SNAP_THRESHOLD {
        y = bottom - size.height as i32;
        changed = true;
    }

    changed.then_some(PhysicalPosition::new(x, y))
}

fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
    let dnd = MenuItem::with_id(app, "dnd", "勿扰模式", true, None::<&str>)?;
    let top = MenuItem::with_id(app, "top", "窗口置顶", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Dounai", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&toggle, &dnd, &top, &sep, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1)
        }))
        .tooltip("Dounai")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_window(app),
            "dnd" => toggle_dnd(app),
            "top" => toggle_on_top(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn toggle_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
            let _ = app.emit("dounai://wake", ());
        }
    }
}

fn toggle_dnd<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let mut flag = state.do_not_disturb.lock().expect("dnd mutex poisoned");
    *flag = !*flag;
    let enabled = *flag;
    let _ = app.emit("dounai://dnd", enabled);
}

fn toggle_on_top<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let mut flag = state.always_on_top.lock().expect("top mutex poisoned");
    *flag = !*flag;
    let enabled = *flag;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(enabled);
    }
}

fn register_shortcuts<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    // Ctrl+Alt+D：唤起/收起悬浮窗
    let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD);
    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(toggle, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_window(&handle);
            }
        })
        .map_err(to_tauri_error)?;

    // Ctrl+Alt+Q：勿扰开关（快速静音）
    let dnd = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyQ);
    let handle2 = app.clone();
    app.global_shortcut()
        .on_shortcut(dnd, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_dnd(&handle2);
            }
        })
        .map_err(to_tauri_error)?;

    Ok(())
}

/// 把插件错误转成 tauri::Error，便于用 `?` 传播。
fn to_tauri_error<E: std::fmt::Display>(error: E) -> tauri::Error {
    tauri::Error::Anyhow(anyhow::anyhow!(error.to_string()))
}

/* ------------------------------------------------------------------ */
/* 前端可调用的命令                                                     */
/* ------------------------------------------------------------------ */

/// 前端告知面板可见性，主进程据此调整窗口高度（收起时只留形象）。
#[tauri::command]
fn set_panel_visible<R: Runtime>(app: AppHandle<R>, visible: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("窗口不存在".into());
    };
    let height = if visible { WIN_H } else { 140.0 };
    window
        .set_size(tauri::LogicalSize::new(WIN_W, height))
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct Settings {
    do_not_disturb: bool,
    always_on_top: bool,
    hotkey_toggle: &'static str,
    hotkey_dnd: &'static str,
}

#[tauri::command]
fn get_settings<R: Runtime>(app: AppHandle<R>) -> Settings {
    let state = app.state::<AppState>();
    // 先取出值再构造返回值：MutexGuard 必须在 `state` 借用结束前释放
    let do_not_disturb = *state.do_not_disturb.lock().expect("dnd mutex poisoned");
    let always_on_top = *state.always_on_top.lock().expect("top mutex poisoned");
    Settings {
        do_not_disturb,
        always_on_top,
        hotkey_toggle: "Ctrl+Alt+D",
        hotkey_dnd: "Ctrl+Alt+Q",
    }
}

#[tauri::command]
fn set_do_not_disturb<R: Runtime>(app: AppHandle<R>, enabled: bool) {
    let state = app.state::<AppState>();
    *state.do_not_disturb.lock().expect("dnd mutex poisoned") = enabled;
    let _ = app.emit("dounai://dnd", enabled);
}

#[tauri::command]
fn set_always_on_top<R: Runtime>(app: AppHandle<R>, enabled: bool) {
    let state = app.state::<AppState>();
    *state.always_on_top.lock().expect("top mutex poisoned") = enabled;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(enabled);
    }
}

#[tauri::command]
fn hide_window<R: Runtime>(app: AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn quit_app<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snap_threshold_is_reasonable() {
        // 吸附阈值必须小于窗口最小宽度的一半，否则会「吸住就动不了」
        assert!(SNAP_THRESHOLD > 0);
        assert!((SNAP_THRESHOLD as f64) < 280.0 / 2.0);
    }

    #[test]
    fn window_defaults_are_defined() {
        assert!(WIN_W >= 280.0);
        assert!(WIN_H >= 240.0);
    }
}
