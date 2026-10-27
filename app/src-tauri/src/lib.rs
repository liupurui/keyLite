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

pub fn run() {
    tauri::Builder::default()
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
