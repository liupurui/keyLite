use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use thiserror::Error;
use zeroize::Zeroizing;

/// 32 字节密钥，Drop 时清零
pub type Key = Zeroizing<[u8; 32]>;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("密钥派生失败：{0}")]
    Kdf(String),
    #[error("加密失败")]
    Encrypt,
    #[error("解密失败：主密码错误，或数据被篡改")]
    Decrypt,
}

/// Argon2id 参数（OWASP 2024 推荐档位，M 系列芯片约 120–200ms）
pub const KDF_M_COST: u32 = 64 * 1024; // KiB = 64 MiB
pub const KDF_T_COST: u32 = 3;
pub const KDF_P_COST: u32 = 4;

pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 12;

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut v);
    v
}

pub fn new_key() -> Key {
    let mut k = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut k);
    Zeroizing::new(k)
}

/// 主密码 → KEK
pub fn derive_kek(password: &str, salt: &[u8]) -> Result<Key, CryptoError> {
    let params = Params::new(KDF_M_COST, KDF_T_COST, KDF_P_COST, Some(32))
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    Ok(Zeroizing::new(out))
}

/// AES-256-GCM 加密。输出 `nonce(12) || ciphertext || tag(16)`
pub fn seal(key: &[u8; 32], aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::Encrypt)?;
    let nonce_bytes = random_bytes(NONCE_LEN);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, Payload { msg: plain, aad })
        .map_err(|_| CryptoError::Encrypt)?;

    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn open(key: &[u8; 32], aad: &[u8], blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if blob.len() <= NONCE_LEN {
        return Err(CryptoError::Decrypt);
    }
    let (nonce_bytes, ct) = blob.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::Decrypt)?;
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), Payload { msg: ct, aad })
        .map_err(|_| CryptoError::Decrypt)?;
    Ok(Zeroizing::new(pt))
}

pub mod b64 {
    use base64::{engine::general_purpose::STANDARD, Engine};

    pub fn encode(b: &[u8]) -> String {
        STANDARD.encode(b)
    }

    pub fn decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
        STANDARD.decode(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let key = new_key();
        let blob = seal(&key, b"item:1", b"hunter2").unwrap();
        assert_ne!(&blob[12..], b"hunter2");
        let pt = open(&key, b"item:1", &blob).unwrap();
        assert_eq!(&pt[..], b"hunter2");
    }

    #[test]
    fn aad_is_bound() {
        let key = new_key();
        let blob = seal(&key, b"item:1", b"secret").unwrap();
        // AAD 不一致必须解不开（防止密文在条目之间搬运）
        assert!(open(&key, b"item:2", &blob).is_err());
    }

    #[test]
    fn tamper_is_detected() {
        let key = new_key();
        let mut blob = seal(&key, b"a", b"secret").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xff;
        assert!(open(&key, b"a", &blob).is_err());
    }

    #[test]
    fn wrong_key_fails() {
        let k1 = new_key();
        let k2 = new_key();
        let blob = seal(&k1, b"a", b"secret").unwrap();
        assert!(open(&k2, b"a", &blob).is_err());
    }

    #[test]
    fn nonce_is_unique_per_call() {
        let key = new_key();
        let a = seal(&key, b"", b"same").unwrap();
        let b = seal(&key, b"", b"same").unwrap();
        assert_ne!(a[..12], b[..12]);
    }

    #[test]
    fn kek_is_deterministic_and_salt_dependent() {
        let salt = random_bytes(SALT_LEN);
        let a = derive_kek("correct horse", &salt).unwrap();
        let b = derive_kek("correct horse", &salt).unwrap();
        assert_eq!(&a[..], &b[..]);

        let salt2 = random_bytes(SALT_LEN);
        let c = derive_kek("correct horse", &salt2).unwrap();
        assert_ne!(&a[..], &c[..]);
    }
}
