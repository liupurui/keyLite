use crate::AppState;
use base64::{engine::general_purpose::STANDARD, Engine};
use keylite_core::{generator, totp, ItemDetail, ItemInput, ItemSummary, Settings};
use serde::Serialize;
use tauri::State;

type R<T> = Result<T, String>;

#[derive(Serialize)]
pub struct VaultStatus {
    pub initialized: bool,
    pub locked: bool,
}

/// 取出当前会话的 DEK；已锁定时直接报错，绝不在别处缓存明文
fn with_dek<T>(state: &AppState, f: impl FnOnce(&[u8; 32]) -> R<T>) -> R<T> {
    let guard = state.session.lock().map_err(|_| "会话状态异常".to_string())?;
    match guard.as_ref() {
        Some(dek) => f(dek),
        None => Err("密码库已锁定".into()),
    }
}

#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> R<VaultStatus> {
    // 锁顺序固定为 session → store（与 with_dek 一致）
    let locked = state
        .session
        .lock()
        .map_err(|_| "会话状态异常".to_string())?
        .is_none();
    let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    let initialized = store.is_initialized().map_err(|e| e.to_string())?;
    Ok(VaultStatus { initialized, locked })
}

#[tauri::command]
pub fn create_vault(password: String, state: State<'_, AppState>) -> R<()> {
    let mut store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    store.create(&password).map_err(|e| e.to_string())?;
    let dek = store.unlock(&password).map_err(|e| e.to_string())?;
    drop(store);
    *state.session.lock().map_err(|_| "会话状态异常".to_string())? = Some(dek);
    Ok(())
}

#[tauri::command]
pub fn unlock(password: String, state: State<'_, AppState>) -> R<()> {
    let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    let dek = store.unlock(&password).map_err(|e| e.to_string())?;
    drop(store);
    *state.session.lock().map_err(|_| "会话状态异常".to_string())? = Some(dek);
    Ok(())
}

#[tauri::command]
pub fn lock(state: State<'_, AppState>) -> R<()> {
    let mut guard = state.session.lock().map_err(|_| "会话状态异常".to_string())?;
    *guard = None; // Zeroizing 在 drop 时把密钥清零
    Ok(())
}

#[tauri::command]
pub fn list_items(
    query: Option<String>,
    tag: Option<String>,
    state: State<'_, AppState>,
) -> R<Vec<ItemSummary>> {
    let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    store
        .list(query.as_deref(), tag.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_item(id: String, state: State<'_, AppState>) -> R<ItemDetail> {
    with_dek(&state, |dek| {
        let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
        store.get(&id, dek).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn save_item(input: ItemInput, state: State<'_, AppState>) -> R<ItemSummary> {
    with_dek(&state, |dek| {
        let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
        store.save(&input, dek).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn delete_item(id: String, state: State<'_, AppState>) -> R<()> {
    let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    store.delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn touch_item(id: String, state: State<'_, AppState>) -> R<()> {
    let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    store.touch(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_favorite(id: String, favorite: bool, state: State<'_, AppState>) -> R<()> {
    let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    store.set_favorite(&id, favorite).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> R<Vec<(String, usize)>> {
    let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    store.tags().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> R<Settings> {
    let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    store.settings().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_settings(settings: Settings, state: State<'_, AppState>) -> R<()> {
    let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    store.set_settings(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn generate_password(options: generator::GenOptions) -> R<String> {
    Ok(generator::generate(&options))
}

#[derive(Serialize)]
pub struct TotpNow {
    code: String,
    remaining: u64,
}

#[tauri::command]
pub fn totp_now(secret: String) -> R<TotpNow> {
    let now = keylite_core::now() as u64;
    let code = totp::code_at(&secret, now).map_err(|e| e.to_string())?;
    Ok(TotpNow {
        code,
        remaining: totp::seconds_remaining(now),
    })
}

#[tauri::command]
pub fn change_master(current: String, next: String, state: State<'_, AppState>) -> R<()> {
    let mut store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    store
        .change_master_password(&current, &next)
        .map_err(|e| e.to_string())?;
    let dek = store.unlock(&next).map_err(|e| e.to_string())?;
    drop(store);
    *state.session.lock().map_err(|_| "会话状态异常".to_string())? = Some(dek);
    Ok(())
}

/// 用系统默认浏览器打开链接。
/// WebView 里的 window.open 在 Tauri 里是空操作，必须走后端。
#[tauri::command]
pub fn open_url(url: String) -> R<()> {
    // 只放行 http/https，避免被当成任意协议执行
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("只支持 http/https 链接".into());
    }

    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&url).spawn();

    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();

    spawned.map(|_| ()).map_err(|e| format!("打开浏览器失败：{e}"))
}

/// 导出加密备份（base64），文件内容整体仍是密文
#[tauri::command]
pub fn export_backup(state: State<'_, AppState>) -> R<String> {    with_dek(&state, |dek| {
        let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
        let bytes = store.export_encrypted(dek).map_err(|e| e.to_string())?;
        Ok(STANDARD.encode(bytes))
    })
}

// ---------- 触控 ID ----------

#[tauri::command]
pub fn biometric_available() -> bool {
    crate::biometric::available()
}

#[tauri::command]
pub fn biometric_enrolled() -> bool {
    crate::biometric::has_key()
}

/// 触控 ID 解锁：系统指纹验证通过后，才从钥匙串取出 DEK
#[tauri::command]
pub fn biometric_unlock(state: State<'_, AppState>) -> R<()> {
    crate::biometric::authenticate("解锁密钥库")?;
    let key = crate::biometric::load_key()?;
    *state
        .session
        .lock()
        .map_err(|_| "会话状态异常".to_string())? = Some(zeroize::Zeroizing::new(key));
    Ok(())
}

/// 开启触控 ID：把当前 DEK 副本写进登录钥匙串（要求已解锁）
#[tauri::command]
pub fn biometric_enable(state: State<'_, AppState>) -> R<()> {
    if !crate::biometric::available() {
        return Err("这台 Mac 没有可用的触控 ID，或尚未录入指纹".into());
    }
    with_dek(&state, |dek| {
        crate::biometric::store_key(dek)?;
        let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
        let mut cfg = store.settings().map_err(|e| e.to_string())?;
        cfg.touch_id_enabled = true;
        store.set_settings(&cfg).map_err(|e| e.to_string())
    })
}

/// 关闭触控 ID：删掉钥匙串副本
#[tauri::command]
pub fn biometric_disable(state: State<'_, AppState>) -> R<()> {
    crate::biometric::forget_key()?;
    let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    let mut cfg = store.settings().map_err(|e| e.to_string())?;
    cfg.touch_id_enabled = false;
    store.set_settings(&cfg).map_err(|e| e.to_string())
}

// ---------- 菜单栏 / 后台运行 ----------

#[tauri::command]
pub fn set_tray_icon(enabled: bool, app: tauri::AppHandle, state: State<'_, AppState>) -> R<()> {
    {
        let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
        let mut cfg = store.settings().map_err(|e| e.to_string())?;
        cfg.show_tray_icon = enabled;
        store.set_settings(&cfg).map_err(|e| e.to_string())?;
    }
    if enabled {
        crate::tray::build(&app).map_err(|e| e.to_string())?;
    } else {
        crate::tray::destroy(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn set_close_to_tray(enabled: bool, state: State<'_, AppState>) -> R<()> {
    let store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
    let mut cfg = store.settings().map_err(|e| e.to_string())?;
    cfg.close_to_tray = enabled;
    store.set_settings(&cfg).map_err(|e| e.to_string())
}

/// 彻底清空密码库：校验主密码 → 删除全部条目与密钥材料 → 用同一主密码重建空库
#[tauri::command]
pub fn wipe_vault(password: String, state: State<'_, AppState>) -> R<()> {
    {
        let mut store = state.store.lock().map_err(|_| "存储状态异常".to_string())?;
        store.wipe(&password).map_err(|e| e.to_string())?;
    }
    // 清空会话与钥匙串副本
    *state
        .session
        .lock()
        .map_err(|_| "会话状态异常".to_string())? = None;
    let _ = crate::biometric::forget_key();
    Ok(())
}
