//! 密钥库核心库
//!
//! 只做三件事：**加密**、**存储**、**生成**。
//! 不依赖任何 UI 框架，因此可以独立单测（`cargo test -p keylite-core`）。
//!
//! 密钥层级：
//! ```text
//! 主密码 ──Argon2id(salt)──► KEK ──AES-GCM 解包──► DEK ──AES-256-GCM──► 每条记录的密文字段
//! ```
//! 改主密码只需用新 KEK 重新封装同一个 DEK，无需重加密整库。

pub mod bridge;
pub mod crypto;
pub mod generator;
pub mod origin;
pub mod store;
pub mod totp;

pub use crypto::Key;
pub use store::{ItemDetail, ItemInput, ItemSummary, Settings, Store, StoreError};

/// 当前 unix 秒
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
