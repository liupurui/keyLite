//! Chrome Native Messaging 桥。
//!
//! Chrome 会用「4 字节小端长度前缀 + UTF-8 JSON」的帧格式跟这个进程对话，
//! 而 App 的 Unix socket 用的是同一套帧格式，所以这里只做纯粹的字节搬运。
//!
//! 安装位置（Chrome 会读这里）：
//!   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.keylite.host.json

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

fn socket_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join("Library/Application Support/dev.keylite.app")
        .join("ipc.sock")
}

fn main() {
    let path = socket_path();
    let mut sock = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(_) => {
            // 用合法帧回报错误，扩展侧能读到 message
            let body = serde_json::json!({
                "type": "error",
                "code": "app_not_running",
                "message": "密钥库没有在运行"
            })
            .to_string()
            .into_bytes();
            let mut out = io::stdout();
            let mut framed = (body.len() as u32).to_le_bytes().to_vec();
            framed.extend_from_slice(&body);
            let _ = out.write_all(&framed);
            let _ = out.flush();
            return;
        }
    };

    let mut reader_sock = match sock.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };

    // stdin → socket
    std::thread::spawn(move || {
        let mut stdin = io::stdin();
        let mut buf = [0u8; 8192];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if reader_sock.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
        // stdin 关闭（Chrome 结束对话）时主动半关 socket，
        // 让桌面端看到 EOF 并关闭连接，本进程才能干净退出而不是挂着。
        let _ = reader_sock.shutdown(std::net::Shutdown::Write);
    });

    // socket → stdout
    let mut stdout = io::stdout();
    let mut buf = [0u8; 8192];
    loop {
        match sock.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if stdout.write_all(&buf[..n]).is_err() {
                    break;
                }
                let _ = stdout.flush();
            }
        }
    }
}
