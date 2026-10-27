export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "从未使用";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 2) return "昨天";
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)} 个月前`;
  return `${Math.floor(diff / 86400 / 365)} 年前`;
}

export function dateOnly(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 域名首字母做条目识别，中文取前两个汉字 */
export function initials(title: string, origin: string): string {
  const src = origin || title;
  if (/[\u4e00-\u9fa5]/.test(title) && !origin) return title.slice(0, 2);
  const parts = src.split(/[.\-_]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

export function strengthLabel(n: number): { text: string; cls: string } {
  if (n >= 4) return { text: "强", cls: "tagok" };
  if (n >= 2) return { text: "中", cls: "tagwarn" };
  return { text: "弱", cls: "tagwarn" };
}

export function maskPassword(pw: string): string {
  return "•".repeat(Math.min(Math.max(pw.length, 8), 20));
}

/** 简单的强度估算，用于「创建主密码」页的刻度 */
export function estimateStrength(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^\w\s]/.test(pw)) score++;
  return Math.min(score, 6);
}
