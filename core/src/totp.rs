//! TOTP（RFC 6238）—— 只用 SHA-1 + HMAC，不引入额外大依赖。

use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use thiserror::Error;

type HmacSha1 = Hmac<Sha1>;

pub const PERIOD: u64 = 30;
pub const DIGITS: u32 = 6;

#[derive(Debug, Error)]
pub enum TotpError {
    #[error("两步验证密钥不是合法的 Base32")]
    BadSecret,
}

/// 去掉空格、连字符、padding，统一大写（用户从截图里复制时常带空格）
fn normalize(secret: &str) -> String {
    secret
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=' && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

pub fn code_at(secret: &str, unix_secs: u64) -> Result<String, TotpError> {
    let norm = normalize(secret);
    let key = BASE32_NOPAD.decode(norm.as_bytes()).map_err(|_| TotpError::BadSecret)?;
    if key.is_empty() {
        return Err(TotpError::BadSecret);
    }

    let counter = unix_secs / PERIOD;
    let mut mac = HmacSha1::new_from_slice(&key).map_err(|_| TotpError::BadSecret)?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();

    // RFC 4226 dynamic truncation
    let offset = (digest[19] & 0x0f) as usize;
    let bin = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | (digest[offset + 3] as u32);

    let code = bin % 10u32.pow(DIGITS);
    Ok(format!("{:0width$}", code, width = DIGITS as usize))
}

pub fn now_code(secret: &str) -> Result<String, TotpError> {
    code_at(secret, crate::now() as u64)
}

/// 距离下一次刷新还剩几秒
pub fn seconds_remaining(unix_secs: u64) -> u64 {
    PERIOD - (unix_secs % PERIOD)
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 附录 B 的标准测试向量（secret = "12345678901234567890"）
    const SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn rfc6238_vectors() {
        // 6 位截断，取 8 位向量后 6 位
        assert_eq!(code_at(SECRET, 59).unwrap(), "287082");
        assert_eq!(code_at(SECRET, 1111111109).unwrap(), "081804");
        assert_eq!(code_at(SECRET, 1234567890).unwrap(), "005924");
    }

    #[test]
    fn tolerates_spaces_and_lowercase() {
        let messy = "gezd gnbv gy3t qojq gezd gnbv gy3t qojq";
        assert_eq!(code_at(messy, 59).unwrap(), "287082");
    }

    #[test]
    fn bad_secret_errors() {
        assert!(code_at("!!!not base32!!!", 59).is_err());
    }

    #[test]
    fn countdown_wraps() {
        assert_eq!(seconds_remaining(0), 30);
        assert_eq!(seconds_remaining(29), 1);
        assert_eq!(seconds_remaining(30), 30);
    }
}
