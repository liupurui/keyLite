//! 给浏览器扩展用的本机 IPC 通道。
//!
//! 数据流：
//! ```text
//! 扩展  --stdio(4字节长度前缀 + JSON)-->  keylite-host  --Unix socket-->  本进程
//! ```
//! Chrome 的 Native Messaging 只在需要时拉起 `keylite-host`，进程间不能直接共享内存，
//! 所以必须由宿主进程把 stdio 桥接到正在运行的 App 的 Unix socket 上。
//!
//! 安全约束：
//! - socket 文件权限 0600，只有当前用户可读写。
//! - 只有扩展 ID 白名单能调起 host（见 extension/install-host.sh 生成的清单）。
//! - 任何需要明文的操作都要求 App 处于已解锁状态，否则返回 `locked`。
//! - `fill.exec` 会再次校验注册域，避免条目被跨站取用。
//!
//! 具体的协议语义在 `keylite_core::bridge`（纯逻辑，有单测覆盖），
//! 这里只负责「收帧 → 交给 bridge → 发帧」，以及把保存候选转成窗口事件。

use crate::AppState;
use keylite_core::bridge::{handle, Context, Outcome};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

const MAX_FRAME: usize = 4 * 1024 * 1024;

pub fn spawn(app: AppHandle, path: PathBuf) {
    std::thread::spawn(move || {
        // 清掉上次运行残留的 socket 文件
        let _ = std::fs::remove_file(&path);
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[keylite] 无法监听扩展通道：{e}");
                return;
            }
        };
        // 仅当前用户可访问
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));

        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || serve(app, stream));
        }
    });
}

fn serve(app: AppHandle, mut stream: UnixStream) {
    loop {
        let mut len_buf = [0u8; 4];
        if stream.read_exact(&mut len_buf).is_err() {
            return;
        }
        let len = u32::from_le_bytes(len_buf) as usize;
        if len == 0 || len > MAX_FRAME {
            return;
        }
        let mut buf = vec![0u8; len];
        if stream.read_exact(&mut buf).is_err() {
            return;
        }
        let req: Value = serde_json::from_slice(&buf).unwrap_or(Value::Null);
        let resp = dispatch(&app, &req);
        let body = serde_json::to_vec(&resp).unwrap_or_else(|_| b"{}".to_vec());
        let mut framed = (body.len() as u32).to_le_bytes().to_vec();
        framed.extend_from_slice(&body);
        if stream.write_all(&framed).is_err() {
            return;
        }
    }
}

fn dispatch(app: &AppHandle, req: &Value) -> Value {
    let state = app.state::<AppState>();
    let kind = req.get("type").and_then(Value::as_str).unwrap_or("");

    // 锁顺序固定为 session → store，与 commands::with_dek 保持一致，避免死锁
    let session = match state.session.lock() {
        Ok(s) => s,
        Err(_) => return json!({ "type": "error", "code": "state" }),
    };
    let store = match state.store.lock() {
        Ok(s) => s,
        Err(_) => return json!({ "type": "error", "code": "state" }),
    };

    let ctx = Context {
        store: &store,
        session: session.as_ref(),
    };

    // 把主窗口叫到前台（解锁入口）
    if kind == "app.show" {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        return json!({ "type": "ok" });
    }

    // 扩展侧的任何请求都算「用户正在使用密钥库」，
    // 让前端的自动锁定计时器重置——否则你在浏览器里忙 15 分钟，回来就被锁了
    if session.is_some() {
        let _ = app.emit("keylite://activity", ());
    }

    match handle(req, &ctx) {
        Outcome::Reply(v) => {
            // 自动保存成功后让桌面端列表立即刷新
            if v.get("type").and_then(Value::as_str) == Some("save.done") {
                let _ = app.emit("keylite://data-changed", ());
            }
            v
        }
        Outcome::SaveCandidate(payload) => {
            // ask 模式：交给主窗口弹出保存浮窗
            let _ = app.emit("keylite://save-candidate", payload);
            json!({ "type": "save.queued" })
        }
    }
}
