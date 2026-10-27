//! 网址归一化：把任意 URL 收敛成可比较的「注册域」（eTLD+1）。
//!
//! 目的只有一个：**防止钓鱼**。`github.com.evil.cn` 不能匹配到 `github.com` 的条目，
//! `a.b.github.com` 则应该匹配。
//!
//! 这里用内置的二级后缀表做近似，不引入完整 Public Suffix List（约 200KB）。
//! 需要更严格时，把 SUFFIXES 换成 PSL 快照即可，接口不变。

const SUFFIXES: &[&str] = &[
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
    "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn",
    "com.hk", "com.tw", "com.sg", "com.my", "com.ph", "com.vn",
    "co.jp", "co.kr", "co.in", "co.nz", "co.za", "co.id", "co.th",
    "com.au", "net.au", "org.au", "com.br", "com.mx", "com.ar", "com.tr",
];

/// 从 URL 里取出 host（去掉 scheme、认证信息、端口、路径）
pub fn host_of(url: &str) -> String {
    let s = url.trim();
    let s = s.split('#').next().unwrap_or("");
    let s = s.split('?').next().unwrap_or("");
    let after_scheme = match s.find("://") {
        Some(i) => &s[i + 3..],
        None => s,
    };
    let host_port = after_scheme.split('/').next().unwrap_or("");
    let host_port = match host_port.rfind('@') {
        Some(i) => &host_port[i + 1..],
        None => host_port,
    };
    let host = if host_port.starts_with('[') {
        // IPv6 字面量
        host_port.split(']').next().unwrap_or(host_port).trim_start_matches('[')
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    };
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// 归一化后的注册域。无法解析时返回空串（调用方应视为「不匹配任何条目」）
pub fn origin_of(url: &str) -> String {
    let host = host_of(url);
    if host.is_empty() {
        return String::new();
    }
    // IP 或 localhost 原样返回
    if host.parse::<std::net::IpAddr>().is_ok() || host == "localhost" || !host.contains('.') {
        return host;
    }

    let labels: Vec<&str> = host.split('.').collect();
    let n = labels.len();
    if n < 2 {
        return host;
    }

    // 常见二级后缀：保留三段
    let last_two = format!("{}.{}", labels[n - 2], labels[n - 1]);
    if SUFFIXES.contains(&last_two.as_str()) && n >= 3 {
        return format!("{}.{}.{}", labels[n - 3], labels[n - 2], labels[n - 1]);
    }
    last_two
}

/// 两个 URL 是否属于同一注册域
pub fn same_site(a: &str, b: &str) -> bool {
    let (oa, ob) = (origin_of(a), origin_of(b));
    !oa.is_empty() && oa == ob
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_scheme_path_port() {
        assert_eq!(origin_of("https://figma.com/login?x=1#y"), "figma.com");
        assert_eq!(origin_of("http://user:pw@github.com:8443/a/b"), "github.com");
        assert_eq!(origin_of("github.com"), "github.com");
    }

    #[test]
    fn keeps_registrable_domain() {
        assert_eq!(origin_of("https://a.b.figma.com/x"), "figma.com");
        assert_eq!(origin_of("https://dash.cloudflare.com"), "cloudflare.com");
    }

    #[test]
    fn handles_two_level_suffix() {
        assert_eq!(origin_of("https://mail.google.co.uk/inbox"), "google.co.uk");
        assert_eq!(origin_of("https://login.taobao.com.cn"), "taobao.com.cn");
    }

    #[test]
    fn blocks_lookalike_phishing() {
        // 关键安全用例：子域名伪装成别人的注册域
        assert!(!same_site("https://github.com.evil.cn/login", "https://github.com/login"));
        assert!(!same_site("https://github.com.cn", "https://github.com"));
        assert!(same_site("https://gist.github.com", "https://github.com"));
    }

    #[test]
    fn ip_and_localhost() {
        assert_eq!(origin_of("http://127.0.0.1:8080/x"), "127.0.0.1");
        assert_eq!(origin_of("http://localhost:3000"), "localhost");
    }
}
