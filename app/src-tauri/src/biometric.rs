//! 触控 ID 解锁。
//!
//! 设计取舍（重要）：
//! macOS 的「钥匙串项 + 生物识别 ACL」（`kSecAttrAccessControl`）只在
//! **data protection keychain** 里生效，而那个需要 App 带
//! `keychain-access-groups` 权限并用开发者证书签名——本地 `tauri dev`
//! 的未签名二进制拿不到，会直接 `errSecMissingEntitlement`。
//!
//! 所以这里采用通行做法：
//!   1. 用 `LAContext` 弹出系统触控 ID 验证（这一步无法被绕过）；
//!   2. 验证通过后才去登录钥匙串里读 DEK 副本。
//!
//! 残余风险：同一用户下的其他进程若能直接读该钥匙串项（需通过 macOS 的
//! 钥匙串访问控制，通常会弹系统授权框），可绕过指纹。对本地单机工具可接受，
//! 后续正式签名后可以升级成 data protection keychain + 生物识别 ACL。

#[cfg(target_os = "macos")]
mod imp {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSString, NSError};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::sync::{Arc, Condvar, Mutex};

    const SERVICE: &str = "dev.keylite.app";
    const ACCOUNT: &str = "vault-dek";

    /// 这台机器有没有可用的触控 ID（有硬件且录了指纹）
    pub fn available() -> bool {
        let ctx = unsafe { LAContext::new() };
        unsafe {
            ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
                .is_ok()
        }
    }

    /// 弹出系统触控 ID 验证，阻塞等待结果
    pub fn authenticate(reason: &str) -> Result<(), String> {
        let ctx = unsafe { LAContext::new() };
        let usable = unsafe {
            ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
                .is_ok()
        };
        if !usable {
            return Err("这台 Mac 没有可用的触控 ID，或尚未录入指纹".into());
        }

        let pair: Arc<(Mutex<Option<bool>>, Condvar)> = Arc::new((Mutex::new(None), Condvar::new()));
        let worker = pair.clone();

        let handler = RcBlock::new(move |success: Bool, _err: *mut NSError| {
            let (lock, cv) = &*worker;
            *lock.lock().unwrap() = Some(success.as_bool());
            cv.notify_all();
        });

        unsafe {
            ctx.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthenticationWithBiometrics,
                &NSString::from_str(reason),
                &handler,
            );
        }

        let (lock, cv) = &*pair;
        let mut done = lock.lock().unwrap();
        while done.is_none() {
            done = cv.wait(done).unwrap();
        }
        if done.unwrap() {
            Ok(())
        } else {
            Err("触控 ID 验证未通过".into())
        }
    }

    /// 把 DEK 副本写进登录钥匙串（先用主密码解锁后调用）
    pub fn store_key(dek: &[u8; 32]) -> Result<(), String> {
        let _ = security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT);
        security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, dek)
            .map_err(|e| format!("写入钥匙串失败：{e}"))
    }

    /// 从钥匙串读回 DEK（调用前必须已经过触控 ID 验证）
    pub fn load_key() -> Result<[u8; 32], String> {
        let bytes = security_framework::passwords::get_generic_password(SERVICE, ACCOUNT)
            .map_err(|_| "钥匙串里还没有密钥副本，请先用主密码解锁一次".to_string())?;
        if bytes.len() != 32 {
            return Err("钥匙串里的密钥副本已损坏".into());
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        Ok(key)
    }

    /// 删除钥匙串副本（关闭触控 ID 时调用）
    pub fn forget_key() -> Result<(), String> {
        match security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT) {
            Ok(()) => Ok(()),
            Err(_) => Ok(()), // 本来就没有，视为成功
        }
    }

    /// 钥匙串里有没有副本（决定是否显示触控 ID 按钮）
    pub fn has_key() -> bool {
        security_framework::passwords::get_generic_password(SERVICE, ACCOUNT).is_ok()
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn available() -> bool {
        false
    }
    pub fn authenticate(_reason: &str) -> Result<(), String> {
        Err("当前平台还不支持触控 ID".into())
    }
    pub fn store_key(_dek: &[u8; 32]) -> Result<(), String> {
        Err("当前平台还不支持触控 ID".into())
    }
    pub fn load_key() -> Result<[u8; 32], String> {
        Err("当前平台还不支持触控 ID".into())
    }
    pub fn forget_key() -> Result<(), String> {
        Ok(())
    }
    pub fn has_key() -> bool {
        false
    }
}

pub use imp::*;
