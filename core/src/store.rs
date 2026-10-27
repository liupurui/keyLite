//! SQLite 存储层。
//!
//! 明文策略（刻意为之）：
//! - `title / url / origin / username / tags` 明文 —— 搜索和列表要快，且这些本身不算机密。
//! - `password / totp / notes` 一律 AES-256-GCM 密文，AAD 绑定条目 id。
//!
//! 主密码永远不落盘，只存 `kdf_salt` 与 `wrapped_dek`。

use crate::{
    crypto::{self, Key},
    generator,
    now,
    origin::origin_of,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const SCHEMA_VERSION: i64 = 1;
const AAD_DEK: &[u8] = b"keylite:dek:v1";

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("数据库错误：{0}")]
    Sql(#[from] rusqlite::Error),
    #[error("加密错误：{0}")]
    Crypto(#[from] crypto::CryptoError),
    #[error("密码库尚未创建")]
    NotInitialized,
    #[error("密码库已存在")]
    AlreadyInitialized,
    #[error("主密码错误")]
    BadPassword,
    #[error("找不到该条目")]
    NotFound,
    #[error("参数不合法：{0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// 空闲多少分钟后自动锁定，0 = 不自动锁
    pub auto_lock_minutes: u32,
    /// 复制密码后多少秒清空剪贴板，0 = 不清空
    pub clipboard_clear_seconds: u32,
    /// 打开条目时默认以掩码显示密码
    pub hide_password_by_default: bool,
    /// 生成新密码时的默认长度
    pub default_password_length: usize,
    /// system | light | dark
    pub theme: String,
    /// 是否开启多设备同步（v1 仅保存偏好，功能在 M5）
    pub sync_enabled: bool,
    /// 提交登录后怎么处理：auto = 自动保存并在页面上提示；ask = 推到桌面端等确认
    #[serde(default = "default_save_mode")]
    pub save_mode: String,
    /// 是否启用触控 ID 解锁（开启后 DEK 副本会存进登录钥匙串）
    #[serde(default)]
    pub touch_id_enabled: bool,
    /// 关闭窗口时隐藏到菜单栏而不是退出应用
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    /// 是否显示菜单栏图标
    #[serde(default = "default_true")]
    pub show_tray_icon: bool,
}

fn default_true() -> bool {
    true
}

fn default_save_mode() -> String {
    "auto".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_lock_minutes: 0,
            clipboard_clear_seconds: 30,
            hide_password_by_default: true,
            default_password_length: 24,
            theme: "system".into(),
            sync_enabled: false,
            save_mode: default_save_mode(),
            touch_id_enabled: false,
            close_to_tray: true,
            show_tray_icon: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemSummary {
    pub id: String,
    pub title: String,
    pub url: String,
    pub origin: String,
    pub username: String,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub strength: u8,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub use_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemDetail {
    #[serde(flatten)]
    pub summary: ItemSummary,
    pub password: String,
    pub totp: String,
    pub notes: String,
}

/// 新建 / 编辑条目时前端传上来的内容
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemInput {
    pub id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub totp: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
}

pub struct Store {
    conn: Connection,
    path: PathBuf,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        let conn = Connection::open(&path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        let store = Self { conn, path };
        store.migrate()?;
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn migrate(&self) -> Result<(), StoreError> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (
                k TEXT PRIMARY KEY,
                v BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS items (
                id           TEXT PRIMARY KEY,
                title        TEXT NOT NULL,
                url          TEXT NOT NULL DEFAULT '',
                origin       TEXT NOT NULL DEFAULT '',
                username     TEXT NOT NULL DEFAULT '',
                password_enc BLOB NOT NULL,
                totp_enc     BLOB,
                notes_enc    BLOB,
                tags         TEXT NOT NULL DEFAULT '',
                favorite     INTEGER NOT NULL DEFAULT 0,
                strength     INTEGER NOT NULL DEFAULT 0,
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL,
                last_used_at INTEGER,
                use_count    INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS idx_items_origin ON items(origin);
             CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at DESC);",
        )?;
        if self.meta_get("schema_version")?.is_none() {
            self.meta_set("schema_version", &SCHEMA_VERSION.to_le_bytes())?;
        }
        Ok(())
    }

    // ---------- meta ----------

    fn meta_get(&self, k: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let v = self
            .conn
            .query_row("SELECT v FROM meta WHERE k = ?1", params![k], |r| r.get::<_, Vec<u8>>(0))
            .optional()?;
        Ok(v)
    }

    fn meta_set(&self, k: &str, v: &[u8]) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO meta (k, v) VALUES (?1, ?2)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            params![k, v],
        )?;
        Ok(())
    }

    // ---------- 生命周期 ----------

    pub fn is_initialized(&self) -> Result<bool, StoreError> {
        Ok(self.meta_get("wrapped_dek")?.is_some())
    }

    /// 创建密码库：生成 salt + DEK，用主密码派生的 KEK 封装 DEK
    pub fn create(&mut self, password: &str) -> Result<(), StoreError> {
        if password.chars().count() < 8 {
            return Err(StoreError::Invalid("主密码至少 8 位".into()));
        }
        if self.is_initialized()? {
            return Err(StoreError::AlreadyInitialized);
        }
        let salt = crypto::random_bytes(crypto::SALT_LEN);
        let kek = crypto::derive_kek(password, &salt)?;
        let dek = crypto::new_key();
        let wrapped = crypto::seal(&kek, AAD_DEK, &dek[..])?;

        self.meta_set("kdf_salt", &salt)?;
        self.meta_set("wrapped_dek", &wrapped)?;
        self.meta_set(
            "kdf_params",
            format!(
                "argon2id:m={},t={},p={}",
                crypto::KDF_M_COST,
                crypto::KDF_T_COST,
                crypto::KDF_P_COST
            )
            .as_bytes(),
        )?;
        self.meta_set("created_at", &now().to_le_bytes())?;
        self.set_settings(&Settings::default())?;
        Ok(())
    }

    /// 校验主密码并取出 DEK
    pub fn unlock(&self, password: &str) -> Result<Key, StoreError> {
        let salt = self.meta_get("kdf_salt")?.ok_or(StoreError::NotInitialized)?;
        let wrapped = self.meta_get("wrapped_dek")?.ok_or(StoreError::NotInitialized)?;
        let kek = crypto::derive_kek(password, &salt)?;
        let dek = crypto::open(&kek, AAD_DEK, &wrapped).map_err(|_| StoreError::BadPassword)?;
        if dek.len() != 32 {
            return Err(StoreError::BadPassword);
        }
        let mut k = [0u8; 32];
        k.copy_from_slice(&dek);
        Ok(zeroize::Zeroizing::new(k))
    }

    /// 改主密码：只重新封装 DEK，数据一条都不用重写
    pub fn change_master_password(&mut self, old: &str, new: &str) -> Result<(), StoreError> {
        if new.chars().count() < 8 {
            return Err(StoreError::Invalid("新主密码至少 8 位".into()));
        }
        let dek = self.unlock(old)?;
        let salt = crypto::random_bytes(crypto::SALT_LEN);
        let kek = crypto::derive_kek(new, &salt)?;
        let wrapped = crypto::seal(&kek, AAD_DEK, &dek[..])?;
        self.meta_set("kdf_salt", &salt)?;
        self.meta_set("wrapped_dek", &wrapped)?;
        Ok(())
    }

    /// 彻底清空密码库并重建（要求主密码校验通过）。
    /// 会用同一个主密码生成全新的 salt 与 DEK，旧密文即使残留在磁盘上也解不开。
    pub fn wipe(&mut self, password: &str) -> Result<(), StoreError> {
        // 先验主密码，避免误删
        drop(self.unlock(password)?);

        self.conn.execute("DELETE FROM items", [])?;
        self.conn.execute("DELETE FROM meta", [])?;

        // 用同一个主密码重建一个全新的空库（新 salt / 新 DEK / 默认设置）
        self.create(password)?;
        Ok(())
    }

    // ---------- 设置 ----------

    pub fn settings(&self) -> Result<Settings, StoreError> {
        match self.meta_get("settings")? {
            Some(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
            None => Ok(Settings::default()),
        }
    }

    pub fn set_settings(&self, s: &Settings) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec(s).map_err(|e| StoreError::Invalid(e.to_string()))?;
        self.meta_set("settings", &bytes)
    }

    // ---------- 条目 ----------

    fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ItemSummary> {
        let tags: String = row.get(5)?;
        Ok(ItemSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            url: row.get(2)?,
            origin: row.get(3)?,
            username: row.get(4)?,
            tags: split_tags(&tags),
            favorite: row.get::<_, i64>(6)? != 0,
            strength: row.get::<_, i64>(7)? as u8,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            last_used_at: row.get(10)?,
            use_count: row.get(11)?,
        })
    }

    const SUMMARY_COLS: &'static str = "id, title, url, origin, username, tags, favorite, strength, created_at, updated_at, last_used_at, use_count";

    /// 全量列表（本地库通常 < 2000 条，直接在内存里过滤最简单也最快）
    pub fn list(&self, query: Option<&str>, tag: Option<&str>) -> Result<Vec<ItemSummary>, StoreError> {
        let sql = format!(
            "SELECT {} FROM items ORDER BY COALESCE(last_used_at, updated_at) DESC",
            Self::SUMMARY_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], Self::row_to_summary)?;
        let mut out: Vec<ItemSummary> = rows.collect::<rusqlite::Result<_>>()?;

        if let Some(t) = tag.filter(|t| !t.is_empty()) {
            out.retain(|i| i.tags.iter().any(|x| x == t));
        }
        if let Some(q) = query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty()) {
            out.retain(|i| {
                i.title.to_lowercase().contains(&q)
                    || i.url.to_lowercase().contains(&q)
                    || i.username.to_lowercase().contains(&q)
                    || i.tags.iter().any(|t| t.to_lowercase().contains(&q))
            });
        }
        Ok(out)
    }

    /// 浏览器右键菜单用：只返回同注册域的条目
    pub fn find_by_origin(&self, origin: &str) -> Result<Vec<ItemSummary>, StoreError> {
        let o = origin_of(origin);
        if o.is_empty() {
            return Ok(vec![]);
        }
        let sql = format!(
            "SELECT {} FROM items WHERE origin = ?1 ORDER BY COALESCE(last_used_at, updated_at) DESC",
            Self::SUMMARY_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![o], Self::row_to_summary)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn get(&self, id: &str, dek: &[u8; 32]) -> Result<ItemDetail, StoreError> {
        let sql = format!("SELECT {} , password_enc, totp_enc, notes_enc FROM items WHERE id = ?1", Self::SUMMARY_COLS);
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(params![id])?;
        let row = rows.next()?.ok_or(StoreError::NotFound)?;

        let summary = Self::row_to_summary(row)?;
        let password_enc: Vec<u8> = row.get(12)?;
        let totp_enc: Option<Vec<u8>> = row.get(13)?;
        let notes_enc: Option<Vec<u8>> = row.get(14)?;

        let aad = id.as_bytes();
        let password = String::from_utf8_lossy(&crypto::open(dek, aad, &password_enc)?).to_string();
        let totp = match totp_enc {
            Some(b) => String::from_utf8_lossy(&crypto::open(dek, aad, &b)?).to_string(),
            None => String::new(),
        };
        let notes = match notes_enc {
            Some(b) => String::from_utf8_lossy(&crypto::open(dek, aad, &b)?).to_string(),
            None => String::new(),
        };

        Ok(ItemDetail { summary, password, totp, notes })
    }

    /// 新建或更新，返回落库后的摘要
    pub fn save(&self, input: &ItemInput, dek: &[u8; 32]) -> Result<ItemSummary, StoreError> {
        if input.title.trim().is_empty() {
            return Err(StoreError::Invalid("名称不能为空".into()));
        }
        let id = input.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let aad = id.as_bytes();
        let password_enc = crypto::seal(dek, aad, input.password.as_bytes())?;
        let totp_enc = if input.totp.trim().is_empty() {
            None
        } else {
            Some(crypto::seal(dek, aad, input.totp.trim().as_bytes())?)
        };
        let notes_enc = if input.notes.is_empty() {
            None
        } else {
            Some(crypto::seal(dek, aad, input.notes.as_bytes())?)
        };

        let origin = origin_of(&input.url);
        let tags = join_tags(&input.tags);
        let strength = generator::strength(&input.password) as i64;
        let ts = now();

        let exists: Option<String> = self
            .conn
            .query_row("SELECT id FROM items WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?;

        if exists.is_some() {
            self.conn.execute(
                "UPDATE items SET title=?2, url=?3, origin=?4, username=?5, password_enc=?6,
                        totp_enc=?7, notes_enc=?8, tags=?9, favorite=?10, strength=?11, updated_at=?12
                 WHERE id=?1",
                params![
                    id, input.title.trim(), input.url.trim(), origin, input.username.trim(),
                    password_enc, totp_enc, notes_enc, tags, input.favorite as i64, strength, ts
                ],
            )?;
        } else {
            self.conn.execute(
                "INSERT INTO items
                 (id, title, url, origin, username, password_enc, totp_enc, notes_enc, tags,
                  favorite, strength, created_at, updated_at, last_used_at, use_count)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,NULL,0)",
                params![
                    id, input.title.trim(), input.url.trim(), origin, input.username.trim(),
                    password_enc, totp_enc, notes_enc, tags, input.favorite as i64, strength, ts
                ],
            )?;
        }
        self.summary_of(&id)
    }

    fn summary_of(&self, id: &str) -> Result<ItemSummary, StoreError> {
        let sql = format!("SELECT {} FROM items WHERE id = ?1", Self::SUMMARY_COLS);
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(params![id])?;
        let row = rows.next()?.ok_or(StoreError::NotFound)?;
        Ok(Self::row_to_summary(row)?)
    }

    pub fn delete(&self, id: &str) -> Result<(), StoreError> {
        let n = self.conn.execute("DELETE FROM items WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// 记录一次使用（右键填充 / 复制密码 / 打开并登录时调用）
    pub fn touch(&self, id: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE items SET last_used_at = ?2, use_count = use_count + 1 WHERE id = ?1",
            params![id, now()],
        )?;
        Ok(())
    }

    pub fn set_favorite(&self, id: &str, favorite: bool) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE items SET favorite = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, favorite as i64, now()],
        )?;
        Ok(())
    }

    /// 标签去重后的全集（侧栏用）
    pub fn tags(&self) -> Result<Vec<(String, usize)>, StoreError> {
        let items = self.list(None, None)?;
        let mut map: std::collections::BTreeMap<String, usize> = Default::default();
        for i in items {
            for t in i.tags {
                *map.entry(t).or_default() += 1;
            }
        }
        Ok(map.into_iter().collect())
    }

    /// 导出为加密备份（DEK 之外的内容全部已是密文，这里再整体封一层）
    pub fn export_encrypted(&self, dek: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
        let items = self.list(None, None)?;
        let mut payload = Vec::new();
        for s in items {
            let d = self.get(&s.id, dek)?;
            payload.push(serde_json::json!({
                "title": d.summary.title,
                "url": d.summary.url,
                "username": d.summary.username,
                "password": d.password,
                "totp": d.totp,
                "notes": d.notes,
                "tags": d.summary.tags,
                "favorite": d.summary.favorite,
            }));
        }
        let raw = serde_json::to_vec(&payload).map_err(|e| StoreError::Invalid(e.to_string()))?;
        Ok(crypto::seal(dek, b"keylite:export:v1", &raw)?)
    }
}

fn split_tags(s: &str) -> Vec<String> {
    s.split(',')
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .collect()
}

fn join_tags(tags: &[String]) -> String {
    tags.iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh() -> (TempDir, Store) {
        let dir = TempDir::new().unwrap();
        let store = Store::open(dir.path().join("vault.db")).unwrap();
        (dir, store)
    }

    fn input(title: &str, url: &str, pw: &str) -> ItemInput {
        ItemInput {
            id: None,
            title: title.into(),
            url: url.into(),
            username: "me@example.com".into(),
            password: pw.into(),
            totp: String::new(),
            notes: String::new(),
            tags: vec!["工作".into()],
            favorite: false,
        }
    }

    #[test]
    fn create_then_unlock() {
        let (_d, mut s) = fresh();
        assert!(!s.is_initialized().unwrap());
        s.create("correct horse battery").unwrap();
        assert!(s.is_initialized().unwrap());
        assert!(s.unlock("wrong password").is_err());
        assert!(s.unlock("correct horse battery").is_ok());
    }

    #[test]
    fn create_twice_fails() {
        let (_d, mut s) = fresh();
        s.create("correct horse battery").unwrap();
        assert!(matches!(s.create("another password"), Err(StoreError::AlreadyInitialized)));
    }

    #[test]
    fn short_master_password_rejected() {
        let (_d, mut s) = fresh();
        assert!(s.create("short").is_err());
    }

    #[test]
    fn crud_roundtrip() {
        let (_d, mut s) = fresh();
        s.create("correct horse battery").unwrap();
        let dek = s.unlock("correct horse battery").unwrap();

        let saved = s.save(&input("GitHub", "https://github.com/login", "s3cret!"), &dek).unwrap();
        assert_eq!(saved.origin, "github.com");
        assert_eq!(saved.strength, generator::strength("s3cret!"));

        let got = s.get(&saved.id, &dek).unwrap();
        assert_eq!(got.password, "s3cret!");
        assert_eq!(got.summary.title, "GitHub");

        // 更新同一条，不应新增
        let mut upd = input("GitHub 工作", "https://github.com/login", "n3w!");
        upd.id = Some(saved.id.clone());
        s.save(&upd, &dek).unwrap();
        assert_eq!(s.list(None, None).unwrap().len(), 1);
        assert_eq!(s.get(&saved.id, &dek).unwrap().password, "n3w!");

        s.delete(&saved.id).unwrap();
        assert!(s.list(None, None).unwrap().is_empty());
    }

    #[test]
    fn search_and_tag_filter() {
        let (_d, mut s) = fresh();
        s.create("correct horse battery").unwrap();
        let dek = s.unlock("correct horse battery").unwrap();
        s.save(&input("GitHub", "https://github.com", "a"), &dek).unwrap();
        s.save(&input("Figma", "https://figma.com", "b"), &dek).unwrap();

        assert_eq!(s.list(Some("git"), None).unwrap().len(), 1);
        assert_eq!(s.list(Some("FIGMA"), None).unwrap().len(), 1);
        assert_eq!(s.list(Some("me@example"), None).unwrap().len(), 2);
        assert_eq!(s.list(None, Some("工作")).unwrap().len(), 2);
        assert_eq!(s.list(None, Some("金融")).unwrap().len(), 0);
    }

    #[test]
    fn origin_lookup_is_site_scoped() {
        let (_d, mut s) = fresh();
        s.create("correct horse battery").unwrap();
        let dek = s.unlock("correct horse battery").unwrap();
        s.save(&input("GitHub", "https://github.com/login", "a"), &dek).unwrap();
        s.save(&input("Figma", "https://figma.com", "b"), &dek).unwrap();

        assert_eq!(s.find_by_origin("github.com").unwrap().len(), 1);
        assert_eq!(s.find_by_origin("https://gist.github.com/x").unwrap().len(), 1);
        // 钓鱼域不能命中
        assert_eq!(s.find_by_origin("github.com.evil.cn").unwrap().len(), 0);
    }

    #[test]
    fn change_master_keeps_data() {
        let (_d, mut s) = fresh();
        s.create("correct horse battery").unwrap();
        let dek = s.unlock("correct horse battery").unwrap();
        let item = s.save(&input("GitHub", "https://github.com", "keepme"), &dek).unwrap();
        drop(dek);

        s.change_master_password("correct horse battery", "new master pass").unwrap();
        assert!(s.unlock("correct horse battery").is_err());

        let dek2 = s.unlock("new master pass").unwrap();
        assert_eq!(s.get(&item.id, &dek2).unwrap().password, "keepme");
    }

    #[test]
    fn totp_and_notes_encrypted_roundtrip() {
        let (_d, mut s) = fresh();
        s.create("correct horse battery").unwrap();
        let dek = s.unlock("correct horse battery").unwrap();
        let mut i = input("GitHub", "https://github.com", "pw");
        i.totp = "GEZDGNBVGY3TQOJQ".into();
        i.notes = "团队管理员".into();
        let saved = s.save(&i, &dek).unwrap();

        let got = s.get(&saved.id, &dek).unwrap();
        assert_eq!(got.totp, "GEZDGNBVGY3TQOJQ");
        assert_eq!(got.notes, "团队管理员");
    }

    #[test]
    fn password_is_not_plaintext_on_disk() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("vault.db");
        {
            let mut s = Store::open(&path).unwrap();
            s.create("correct horse battery").unwrap();
            let dek = s.unlock("correct horse battery").unwrap();
            s.save(&input("GitHub", "https://github.com", "PLAINTEXT_NEEDLE"), &dek).unwrap();
        }
        // 关闭 WAL 影响：把 -wal 也一起读
        let mut blob = std::fs::read(&path).unwrap();
        for ext in ["-wal", "-shm"] {
            let p = path.with_file_name(format!("vault.db{ext}"));
            if let Ok(more) = std::fs::read(&p) {
                blob.extend_from_slice(&more);
            }
        }
        let needle = b"PLAINTEXT_NEEDLE";
        let found = blob.windows(needle.len()).any(|w| w == needle);
        assert!(!found, "密码明文出现在了数据库文件里");
    }

    #[test]
    fn touch_updates_counters() {
        let (_d, mut s) = fresh();
        s.create("correct horse battery").unwrap();
        let dek = s.unlock("correct horse battery").unwrap();
        let it = s.save(&input("GitHub", "https://github.com", "a"), &dek).unwrap();
        assert_eq!(it.use_count, 0);
        s.touch(&it.id).unwrap();
        s.touch(&it.id).unwrap();
        let after = s.list(None, None).unwrap();
        assert_eq!(after[0].use_count, 2);
        assert!(after[0].last_used_at.is_some());
    }

    #[test]
    fn wipe_needs_password_and_clears_everything() {
        let (_d, mut s) = fresh();
        s.create("correct horse battery").unwrap();
        let dek = s.unlock("correct horse battery").unwrap();
        s.save(&input("GitHub", "https://github.com", "pw"), &dek).unwrap();
        drop(dek);
        assert_eq!(s.list(None, None).unwrap().len(), 1);

        // 密码错误：一个字节都不能动
        assert!(s.wipe("wrong password").is_err());
        assert_eq!(s.list(None, None).unwrap().len(), 1);

        s.wipe("correct horse battery").unwrap();
        assert_eq!(s.list(None, None).unwrap().len(), 0);
        // 同一个主密码仍然可用（用新 salt/DEK 重建）
        assert!(s.unlock("correct horse battery").is_ok());
        // 设置回到默认
        assert_eq!(s.settings().unwrap().auto_lock_minutes, 0);
    }

    #[test]
    fn settings_persist() {
        let (_d, mut s) = fresh();
        s.create("correct horse battery").unwrap();
        let mut cfg = s.settings().unwrap();
        assert_eq!(cfg.auto_lock_minutes, 0); // 默认不空闲锁定，避免反复输主密码
        cfg.auto_lock_minutes = 5;
        cfg.theme = "dark".into();
        s.set_settings(&cfg).unwrap();
        let again = s.settings().unwrap();
        assert_eq!(again.auto_lock_minutes, 5);
        assert_eq!(again.theme, "dark");
    }
}
