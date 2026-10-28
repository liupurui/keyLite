mod biometric;
mod commands;
mod ipc;
mod tray;

use keylite_core::{Key, Store};
use std::sync::Mutex;
use tauri::Manager;

/// 进程级状态。
/// - `store` 负责落盘，`session` 里只在解锁期间持有 DEK，锁定即清空并归零。
pub struct AppState {
    pub store: Mutex<Store>,
    pub session: Mutex<Option<Key>>,
}

/// 唤起 / 收起全局搜索窗口
fn toggle_search(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let Some(win) = app.get_webview_window("search") else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit_to("search", "keylite://search-focus", ());
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_search(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;

            let store = Store::open(dir.join("vault.db"))?;
            app.manage(AppState {
                store: Mutex::new(store),
                session: Mutex::new(None),
            });

            // 给浏览器扩展用的本机 IPC 通道
            ipc::spawn(app.handle().clone(), dir.join("ipc.sock"));

            // 全局快捷键：⌘⇧Space 唤起搜索窗口
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let sc = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);
                if let Err(e) = app.global_shortcut().register(sc) {
                    eprintln!("[keylite] 全局快捷键注册失败（可能被其他应用占用）：{e}");
                }
            }

            // 菜单栏图标（设置里可关）
            let show_tray = app
                .state::<AppState>()
                .store
                .lock()
                .ok()
                .and_then(|s| s.settings().ok())
                .map(|cfg| cfg.show_tray_icon)
                .unwrap_or(true);
            if show_tray {
                let _ = tray::build(app.handle());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // 搜索窗口：失去焦点就收起（像 Spotlight 一样）
            if window.label() == "search" {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
                return;
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if tray::should_hide_on_close(app) {
                    // 隐藏到菜单栏，进程继续跑，扩展照样能用
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::create_vault,
            commands::unlock,
            commands::lock,
            commands::list_items,
            commands::get_item,
            commands::save_item,
            commands::delete_item,
            commands::touch_item,
            commands::set_favorite,
            commands::list_tags,
            commands::get_settings,
            commands::set_settings,
            commands::generate_password,
            commands::totp_now,
            commands::change_master,
            commands::open_url,
            commands::export_backup,
            commands::biometric_available,
            commands::biometric_enrolled,
            commands::biometric_unlock,
            commands::biometric_enable,
            commands::biometric_disable,
            commands::set_tray_icon,
            commands::set_close_to_tray,
            commands::wipe_vault,
        ])
        .build(tauri::generate_context!())
        .expect("启动密钥库失败")
        .run(|app, event| {
            // 点 Dock 图标时把窗口叫回来（窗口被隐藏后 macOS 的默认行为不适用）
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_main(app);
            }
        });
}
