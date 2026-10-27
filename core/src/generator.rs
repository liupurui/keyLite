//! 密码生成器（用系统 CSPRNG，不用 `rand::random` 的可预测路径）

use rand::Rng;
use serde::{Deserialize, Serialize};

pub const LOWER: &str = "abcdefghijkmnopqrstuvwxyz"; // 去掉 l
pub const UPPER: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // 去掉 I O
pub const DIGITS: &str = "23456789"; // 去掉 0 1
pub const SYMBOLS: &str = "!@#$%^&*()-_=+[]{};:,.?";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GenOptions {
    pub length: usize,
    pub lower: bool,
    pub upper: bool,
    pub digits: bool,
    pub symbols: bool,
}

impl Default for GenOptions {
    fn default() -> Self {
        Self { length: 24, lower: true, upper: true, digits: true, symbols: true }
    }
}

/// 生成密码：先保证每个被选中的字符类各出现一次，再随机补满并打乱，
/// 避免「要求含数字」的站点被随机漏掉。
pub fn generate(opts: &GenOptions) -> String {
    let mut pools: Vec<&str> = Vec::new();
    if opts.lower { pools.push(LOWER); }
    if opts.upper { pools.push(UPPER); }
    if opts.digits { pools.push(DIGITS); }
    if opts.symbols { pools.push(SYMBOLS); }
    if pools.is_empty() {
        return String::new();
    }

    let len = opts.length.clamp(4, 128);
    let mut rng = rand::thread_rng();
    let mut chars: Vec<char> = Vec::with_capacity(len);

    for pool in &pools {
        let idx = rng.gen_range(0..pool.chars().count());
        chars.push(pool.chars().nth(idx).unwrap());
    }

    let all: String = pools.concat();
    let all_chars: Vec<char> = all.chars().collect();
    while chars.len() < len {
        chars.push(all_chars[rng.gen_range(0..all_chars.len())]);
    }

    // Fisher–Yates 打乱，保证前几位的字符类不固定
    for i in (1..chars.len()).rev() {
        let j = rng.gen_range(0..=i);
        chars.swap(i, j);
    }
    chars.into_iter().collect()
}

/// 0–4 的粗粒度强度评估（用于列表里的「弱密码」标记）
pub fn strength(pw: &str) -> u8 {
    if pw.is_empty() { return 0; }
    let len = pw.chars().count();
    let classes = [
        pw.chars().any(|c| c.is_ascii_lowercase()),
        pw.chars().any(|c| c.is_ascii_uppercase()),
        pw.chars().any(|c| c.is_ascii_digit()),
        pw.chars().any(|c| !c.is_ascii_alphanumeric()),
    ]
    .iter()
    .filter(|b| **b)
    .count();

    let mut score = 0;
    if len >= 8 { score += 1; }
    if len >= 12 { score += 1; }
    if len >= 16 { score += 1; }
    if classes >= 3 { score += 1; }
    if classes == 4 && len >= 12 { score += 1; }
    score.min(4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn respects_length_and_classes() {
        let opts = GenOptions { length: 24, lower: true, upper: true, digits: true, symbols: true };
        for _ in 0..50 {
            let pw = generate(&opts);
            assert_eq!(pw.chars().count(), 24);
            assert!(pw.chars().any(|c| c.is_ascii_lowercase()));
            assert!(pw.chars().any(|c| c.is_ascii_uppercase()));
            assert!(pw.chars().any(|c| c.is_ascii_digit()));
            assert!(pw.chars().any(|c| !c.is_ascii_alphanumeric()));
        }
    }

    #[test]
    fn digits_only_has_no_letters() {
        let opts = GenOptions { length: 12, lower: false, upper: false, digits: true, symbols: false };
        let pw = generate(&opts);
        assert!(pw.chars().all(|c| c.is_ascii_digit()), "got {pw}");
    }

    #[test]
    fn empty_selection_is_empty() {
        let opts = GenOptions { length: 12, lower: false, upper: false, digits: false, symbols: false };
        assert_eq!(generate(&opts), "");
    }

    #[test]
    fn not_all_identical() {
        let opts = GenOptions::default();
        let a = generate(&opts);
        let b = generate(&opts);
        assert_ne!(a, b);
    }

    #[test]
    fn strength_scale() {
        assert_eq!(strength(""), 0);
        assert!(strength("abc") <= 1);
        assert_eq!(strength("Kx7#mQ2!pR9$vL4&"), 4);
    }
}
