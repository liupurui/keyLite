//! 浏览器扩展与本机之间的协议处理（纯逻辑，不依赖 Tauri，可单测）。
//!
//! 放在 core 里而不是 `src-tauri`，是为了让「扩展到底能拿到什么」这件事
//! 能用测试证明，而不是靠人肉点浏览器。

use crate::{
    generator, origin,
    store::{ItemInput, Store},
    Key,
};
use serde_json::{json, Value};

/// 一次请求的上下文
pub struct Context<'a> {
    pub store: &'a Store,
    /// `None` 表示密码库已锁定 —— 任何取明文的请求都会被拒绝
    pub session: Option<&'a Key>,
}

/// 处理结果
pub enum Outcome {
    /// 直接回给扩展
    Reply(Value),
    /// 网页提交了登录表单，需要主窗口弹「保存这条登录？」
    SaveCandidate(Value),
}

fn err(code: &str, message: &str) -> Outcome {
    Outcome::Reply(json!({ "type": "error", "code": code, "message": message }))
}

pub fn handle(req: &Value, ctx: &Context) -> Outcome {
    let kind = req.get("type").and_then(Value::as_str).unwrap_or("");

    match kind {
        "ping" => Outcome::Reply(json!({
            "type": "pong",
            "version": env!("CARGO_PKG_VERSION"),
        })),

        // 右键菜单：只要同注册域的摘要，绝不含密码
        "fill.query" => {
            let raw = req
                .pointer("/payload/origin")
                .and_then(Value::as_str)
                .unwrap_or("");
            match ctx.store.find_by_origin(raw) {
                Ok(items) => Outcome::Reply(json!({
                    "type": "fill.list",
                    "payload": {
                        "items": items.iter().map(|i| json!({
                            "id": i.id,
                            "title": i.title,
                            "label": i.username,
                            "lastUsed": i.last_used_at,
                        })).collect::<Vec<_>>()
                    }
                })),
                Err(e) => err("store", &e.to_string()),
            }
        }

        // 取明文：必须已解锁 + 站点一致
        "fill.exec" => {
            let id = req.pointer("/payload/id").and_then(Value::as_str).unwrap_or("");
            let raw = req
                .pointer("/payload/origin")
                .and_then(Value::as_str)
                .unwrap_or("");

            let Some(dek) = ctx.session else {
                return err("locked", "请先在密钥库中解锁");
            };

            match ctx.store.get(id, dek) {
                Ok(d) => {
                    if !origin::same_site(&d.summary.url, raw) {
                        // 防钓鱼：请求方站点与条目站点不是同一注册域。
                        // 把两边域名都带回去，页面提示才能说清楚为什么被拒。
                        return Outcome::Reply(json!({
                            "type": "error",
                            "code": "origin_mismatch",
                            "message": "站点不匹配，已拒绝填充",
                            "payload": {
                                "itemOrigin": d.summary.origin,
                                "requestOrigin": origin::origin_of(raw),
                            }
                        }));
                    }
                    let _ = ctx.store.touch(id);
                    Outcome::Reply(json!({
                        "type": "fill.credential",
                        "payload": { "username": d.summary.username, "password": d.password }
                    }))
                }
                Err(e) => err("store", &e.to_string()),
            }
        }

        // 网页提交了登录表单。
        // 默认直接保存（用户不用切回桌面端），两条安全线：
        //   1. 密码为空不存（防止把验证码/搜索词当密码存进去）；
        //   2. 同站点同账号已有不同密码时不静默覆盖（可能是你手滑输错）。
        "save.candidate" => {
            let Some(dek) = ctx.session else {
                return err("locked", "请先在密钥库中解锁才能自动保存");
            };

            let p = req.get("payload").cloned().unwrap_or(Value::Null);
            let url = p.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            let raw_origin = p.get("origin").and_then(Value::as_str).unwrap_or("");
            let username = p
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let password = p.get("password").and_then(Value::as_str).unwrap_or("").to_string();

            if password.is_empty() {
                return err("empty_password", "密码为空，没有保存");
            }
            let site = origin::origin_of(if raw_origin.is_empty() { &url } else { raw_origin });
            if site.is_empty() {
                return err("unknown_site", "识别不出站点，没有保存");
            }

            let mode = ctx
                .store
                .settings()
                .map(|s| s.save_mode)
                .unwrap_or_else(|_| "auto".into());
            if mode == "ask" {
                return Outcome::SaveCandidate(p);
            }

            let existing = ctx.store.find_by_origin(&site).unwrap_or_default();
            // 服务端兑底：就算页面抓错了字段（比如用户名为空），
            // 同站点已有相同密码的条目也直接视为“已存在”，不再建重复记录
            let hit = if username.is_empty() {
                existing.iter().find(|i| {
                    ctx.store
                        .get(&i.id, dek)
                        .map(|d| d.password == password)
                        .unwrap_or(false)
                })
            } else {
                existing
                    .iter()
                    .find(|i| i.username.eq_ignore_ascii_case(&username))
            };

            if let Some(item) = hit {
                match ctx.store.get(&item.id, dek) {
                    Ok(d) => {
                        if d.password == password {
                            return Outcome::Reply(json!({
                                "type": "save.done",
                                "payload": { "action": "exists", "itemId": d.summary.id, "title": d.summary.title }
                            }));
                        }
                        // 密码不同：可能你刚改了密码，也可能手滑输错——把决定权交回用户
                        return Outcome::Reply(json!({
                            "type": "save.conflict",
                            "payload": {
                                "itemId": d.summary.id,
                                "title": d.summary.title,
                                "username": d.summary.username
                            }
                        }));
                    }
                    Err(e) => return err("store", &e.to_string()),
                }
            }

            let input = ItemInput {
                id: None,
                title: site.clone(),
                url,
                username,
                password,
                totp: String::new(),
                notes: String::new(),
                tags: vec![],
                favorite: false,
            };
            match ctx.store.save(&input, dek) {
                Ok(s) => Outcome::Reply(json!({
                    "type": "save.done",
                    "payload": { "action": "created", "itemId": s.id, "title": s.title }
                })),
                Err(e) => err("store", &e.to_string()),
            }
        }

        // 冲突时用户选择「更新密码」
        "item.update_password" => {
            let Some(dek) = ctx.session else {
                return err("locked", "请先在密钥库中解锁");
            };
            let id = req.pointer("/payload/id").and_then(Value::as_str).unwrap_or("");
            let pw = req
                .pointer("/payload/password")
                .and_then(Value::as_str)
                .unwrap_or("");
            let raw = req
                .pointer("/payload/origin")
                .and_then(Value::as_str)
                .unwrap_or("");
            if pw.is_empty() {
                return err("empty_password", "密码为空");
            }

            match ctx.store.get(id, dek) {
                Ok(d) => {
                    if !origin::same_site(&d.summary.url, raw) {
                        return err("origin_mismatch", "站点不匹配，已拒绝");
                    }
                    let input = ItemInput {
                        id: Some(id.to_string()),
                        title: d.summary.title.clone(),
                        url: d.summary.url.clone(),
                        username: d.summary.username.clone(),
                        password: pw.to_string(),
                        totp: d.totp.clone(),
                        notes: d.notes.clone(),
                        tags: d.summary.tags.clone(),
                        favorite: d.summary.favorite,
                    };
                    match ctx.store.save(&input, dek) {
                        Ok(s) => Outcome::Reply(json!({
                            "type": "save.done",
                            "payload": { "action": "updated", "itemId": s.id, "title": s.title }
                        })),
                        Err(e) => err("store", &e.to_string()),
                    }
                }
                Err(e) => err("store", &e.to_string()),
            }
        }

        // 撤销刚自动保存的那条（页面上的「撤销」按钮）
        "item.delete" => {
            if ctx.session.is_none() {
                return err("locked", "请先在密钥库中解锁");
            }
            let id = req.pointer("/payload/id").and_then(Value::as_str).unwrap_or("");
            match ctx.store.delete(id) {
                Ok(_) => Outcome::Reply(json!({ "type": "deleted", "payload": { "id": id } })),
                Err(e) => err("store", &e.to_string()),
            }
        }

        // 右键「生成新密码并填入」
        "generate" => {
            let length = req
                .pointer("/payload/length")
                .and_then(Value::as_u64)
                .unwrap_or(24) as usize;
            let opts = generator::GenOptions {
                length,
                lower: true,
                upper: true,
                digits: true,
                symbols: true,
            };
            Outcome::Reply(json!({
                "type": "generated",
                "payload": { "password": generator::generate(&opts) }
            }))
        }

        _ => err("unknown_type", "不认识的请求类型"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{store::ItemInput, Store};
    use serde_json::json;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Store, Key) {
        let dir = TempDir::new().unwrap();
        let mut store = Store::open(dir.path().join("vault.db")).unwrap();
        store.create("correct horse battery").unwrap();
        let dek = store.unlock("correct horse battery").unwrap();
        (dir, store, dek)
    }

    fn item(title: &str, url: &str, user: &str, pw: &str) -> ItemInput {
        ItemInput {
            id: None,
            title: title.into(),
            url: url.into(),
            username: user.into(),
            password: pw.into(),
            totp: String::new(),
            notes: String::new(),
            tags: vec!["工作".into()],
            favorite: false,
        }
    }

    fn reply(o: Outcome) -> Value {
        match o {
            Outcome::Reply(v) => v,
            Outcome::SaveCandidate(_) => panic!("期望 Reply，拿到 SaveCandidate"),
        }
    }

    #[test]
    fn ping_answers() {
        let (_d, store, dek) = setup();
        let v = reply(handle(&json!({"type":"ping"}), &Context { store: &store, session: Some(&dek) }));
        assert_eq!(v["type"], "pong");
    }

    #[test]
    fn fill_query_is_site_scoped_and_has_no_password() {
        let (_d, mut store, dek) = setup();
        store.save(&item("GitHub", "https://github.com/login", "me@x.com", "s3cret!"), &dek).unwrap();
        store.save(&item("Figma", "https://figma.com", "me@x.com", "other"), &dek).unwrap();

        let v = reply(handle(
            &json!({"type":"fill.query","payload":{"origin":"github.com"}}),
            &Context { store: &store, session: Some(&dek) },
        ));
        assert_eq!(v["type"], "fill.list");
        let items = v["payload"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["label"], "me@x.com");
        // 关键：查询结果里不能出现密码字段
        let raw = v.to_string();
        assert!(!raw.contains("s3cret!"), "fill.query 泄漏了密码");
        assert!(!raw.contains("password"), "fill.query 出现了 password 字段");
    }

    #[test]
    fn fill_query_blocks_phishing_origin() {
        let (_d, mut store, dek) = setup();
        store.save(&item("GitHub", "https://github.com/login", "me@x.com", "pw"), &dek).unwrap();

        let v = reply(handle(
            &json!({"type":"fill.query","payload":{"origin":"github.com.evil.cn"}}),
            &Context { store: &store, session: Some(&dek) },
        ));
        assert_eq!(v["payload"]["items"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn fill_exec_returns_credential_when_unlocked_and_same_site() {
        let (_d, mut store, dek) = setup();
        let it = store.save(&item("GitHub", "https://github.com/login", "me@x.com", "s3cret!"), &dek).unwrap();

        let v = reply(handle(
            &json!({"type":"fill.exec","payload":{"id":it.id,"origin":"https://gist.github.com/x"}}),
            &Context { store: &store, session: Some(&dek) },
        ));
        assert_eq!(v["type"], "fill.credential");
        assert_eq!(v["payload"]["password"], "s3cret!");
        assert_eq!(v["payload"]["username"], "me@x.com");

        // 用一次应该记账
        assert_eq!(store.list(None, None).unwrap()[0].use_count, 1);
    }

    #[test]
    fn fill_exec_refuses_when_locked() {
        let (_d, mut store, dek) = setup();
        let it = store.save(&item("GitHub", "https://github.com/login", "me@x.com", "pw"), &dek).unwrap();

        let v = reply(handle(
            &json!({"type":"fill.exec","payload":{"id":it.id,"origin":"github.com"}}),
            &Context { store: &store, session: None },
        ));
        assert_eq!(v["type"], "error");
        assert_eq!(v["code"], "locked");
        assert!(!v.to_string().contains("\"pw\""));
    }

    #[test]
    fn fill_exec_refuses_cross_site() {
        let (_d, mut store, dek) = setup();
        let it = store.save(&item("GitHub", "https://github.com/login", "me@x.com", "s3cret!"), &dek).unwrap();

        let v = reply(handle(
            &json!({"type":"fill.exec","payload":{"id":it.id,"origin":"github.com.evil.cn"}}),
            &Context { store: &store, session: Some(&dek) },
        ));
        assert_eq!(v["type"], "error");
        assert_eq!(v["code"], "origin_mismatch");
        assert!(!v.to_string().contains("s3cret!"));
    }

    fn candidate(user: &str, pw: &str) -> Value {
        json!({"type":"save.candidate","payload":{
            "url":"https://github.com/login","origin":"github.com",
            "username":user,"password":pw
        }})
    }

    #[test]
    fn save_candidate_auto_saves_by_default() {
        let (_d, store, dek) = setup();
        let ctx = Context { store: &store, session: Some(&dek) };

        let v = reply(handle(&candidate("new@x.com", "N3w!pass"), &ctx));
        assert_eq!(v["type"], "save.done");
        assert_eq!(v["payload"]["action"], "created");

        // 真的落库了
        let items = store.list(None, None).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].origin, "github.com");
        assert_eq!(items[0].username, "new@x.com");

        // 再提交一次相同内容：不重复建条目
        let v = reply(handle(&candidate("new@x.com", "N3w!pass"), &ctx));
        assert_eq!(v["payload"]["action"], "exists");
        assert_eq!(store.list(None, None).unwrap().len(), 1);
    }

    #[test]
    fn save_candidate_does_not_silently_overwrite() {
        let (_d, store, dek) = setup();
        let ctx = Context { store: &store, session: Some(&dek) };
        reply(handle(&candidate("new@x.com", "old-pw"), &ctx));

        // 同一账号不同密码 → 交给用户决定，库里不能变
        let v = reply(handle(&candidate("new@x.com", "typo-pw"), &ctx));
        assert_eq!(v["type"], "save.conflict");
        assert_eq!(v["payload"]["username"], "new@x.com");

        let items = store.list(None, None).unwrap();
        assert_eq!(items.len(), 1);
        let d = store.get(&items[0].id, &dek).unwrap();
        assert_eq!(d.password, "old-pw");
    }

    #[test]
    fn save_candidate_ignores_empty_password() {
        let (_d, store, dek) = setup();
        let v = reply(handle(
            &candidate("new@x.com", ""),
            &Context { store: &store, session: Some(&dek) },
        ));
        assert_eq!(v["type"], "error");
        assert_eq!(v["code"], "empty_password");
        assert!(store.list(None, None).unwrap().is_empty());
    }

    #[test]
    fn save_candidate_refuses_when_locked() {
        let (_d, store, _dek) = setup();
        let v = reply(handle(&candidate("a@x.com", "pw"), &Context { store: &store, session: None }));
        assert_eq!(v["code"], "locked");
        assert!(store.list(None, None).unwrap().is_empty());
    }

    #[test]
    fn ask_mode_still_forwards_to_window() {
        let (_d, store, dek) = setup();
        let mut s = store.settings().unwrap();
        s.save_mode = "ask".into();
        store.set_settings(&s).unwrap();

        match handle(&candidate("new@x.com", "pw"), &Context { store: &store, session: Some(&dek) }) {
            Outcome::SaveCandidate(p) => assert_eq!(p["username"], "new@x.com"),
            _ => panic!("ask 模式应该推给主窗口"),
        }
        assert!(store.list(None, None).unwrap().is_empty());
    }

    #[test]
    fn empty_username_with_same_password_does_not_duplicate() {
        let (_d, store, dek) = setup();
        let ctx = Context { store: &store, session: Some(&dek) };

        // 第一次：用户名抓对了
        let v = reply(handle(&candidate("new@x.com", "N3w!pass"), &ctx));
        assert_eq!(v["payload"]["action"], "created");

        // 第二次：登录成功跳转后字段被摘掉，用户名成了空串
        let v = reply(handle(&candidate("", "N3w!pass"), &ctx));
        assert_eq!(v["payload"]["action"], "exists");
        assert_eq!(store.list(None, None).unwrap().len(), 1);
    }

    #[test]
    fn undo_removes_the_saved_item() {
        let (_d, store, dek) = setup();
        let ctx = Context { store: &store, session: Some(&dek) };
        let v = reply(handle(&candidate("new@x.com", "pw"), &ctx));
        let id = v["payload"]["itemId"].as_str().unwrap().to_string();

        let v = reply(handle(&json!({"type":"item.delete","payload":{"id":id}}), &ctx));
        assert_eq!(v["type"], "deleted");
        assert!(store.list(None, None).unwrap().is_empty());
    }

    #[test]
    fn generate_returns_requested_length() {
        let (_d, store, dek) = setup();
        let v = reply(handle(
            &json!({"type":"generate","payload":{"length":32}}),
            &Context { store: &store, session: Some(&dek) },
        ));
        assert_eq!(v["type"], "generated");
        let pw = v["payload"]["password"].as_str().unwrap();
        assert_eq!(pw.chars().count(), 32);
    }

    #[test]
    fn unknown_type_is_rejected() {
        let (_d, store, dek) = setup();
        let v = reply(handle(&json!({"type":"rm -rf"}), &Context { store: &store, session: Some(&dek) }));
        assert_eq!(v["code"], "unknown_type");
    }
}
