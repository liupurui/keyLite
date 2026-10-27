//! 菜单栏图标（macOS 状态栏 / Windows 通知区）。
//!
//! 行为：
//! - 关闭主窗口 = 隐藏到菜单栏，不退出进程（可在设置里关掉）
//! - 点图标出菜单：显示主窗口 / 快速搜索 / 设置 / 锁定 / 退出
//! - 图标本身可在设置里关掉；关掉后「关闭窗口」就恢复成退出应用，
//!   避免出现「窗口没了、图标也没有、找不回来」的死局

use crate::AppState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

pub const TRAY_ID: &str = "keylite-tray";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "快速搜索", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let lock = MenuItem::with_id(app, "lock", "锁定密码库", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出密钥库", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&show, &quick, &sep1, &settings, &lock, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("密钥库");

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .build(app)?;

    Ok(())
}

pub fn destroy(app: &AppHandle) {
    app.remove_tray_by_id(TRAY_ID);
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "show" => show_main(app),
        "quick" => {
            show_main(app);
            let _ = app.emit("keylite://quick-search", ());
        }
        "settings" => {
            show_main(app);
            let _ = app.emit("keylite://open-settings", ());
        }
        "lock" => {
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut guard) = state.session.lock() {
                    *guard = None;
                }
            }
            let _ = app.emit("keylite://locked", ());
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 关闭窗口时是否应该隐藏而不是退出。
/// 图标被关掉时强制退出，否则用户会找不到应用。
pub fn should_hide_on_close(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    let Ok(store) = state.store.lock() else {
        return false;
    };
    let Ok(cfg) = store.settings() else {
        return false;
    };
    cfg.close_to_tray && cfg.show_tray_icon
}
