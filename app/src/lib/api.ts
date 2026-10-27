/**
 * 与 Rust 侧的通信层。
 *
 * 关键设计：如果没有跑在 Tauri 里（比如直接 `npm run dev` 用浏览器打开），
 * 自动切换到内存版 mock，界面可以照常点。这样改 UI 不需要每次编译 Rust。
 */

export type ItemSummary = {
  id: string;
  title: string;
  url: string;
  origin: string;
  username: string;
  tags: string[];
  favorite: boolean;
  strength: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  use_count: number;
};

export type ItemDetail = ItemSummary & {
  password: string;
  totp: string;
  notes: string;
};

export type ItemInput = {
  id?: string | null;
  title: string;
  url: string;
  username: string;
  password: string;
  totp: string;
  notes: string;
  tags: string[];
  favorite: boolean;
};

export type Settings = {
  auto_lock_minutes: number;
  clipboard_clear_seconds: number;
  hide_password_by_default: boolean;
  default_password_length: number;
  theme: string;
  sync_enabled: boolean;
  /** auto = 提交后直接保存并在页面提示；ask = 推到桌面端等确认 */
  save_mode: "auto" | "ask";
  /** 是否启用触控 ID 解锁 */
  touch_id_enabled: boolean;
  /** 关闭窗口时隐藏到菜单栏而不是退出 */
  close_to_tray: boolean;
  /** 是否显示菜单栏图标 */
  show_tray_icon: boolean;
};

export type VaultStatus = { initialized: boolean; locked: boolean };

export type GenOptions = {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
};

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  return mock<T>(cmd, args);
}

/* ---------------- 对外 API ---------------- */

export const api = {
  status: () => call<VaultStatus>("vault_status"),
  create: (password: string) => call<void>("create_vault", { password }),
  unlock: (password: string) => call<void>("unlock", { password }),
  lock: () => call<void>("lock"),
  list: (query?: string, tag?: string) => call<ItemSummary[]>("list_items", { query: query ?? null, tag: tag ?? null }),
  get: (id: string) => call<ItemDetail>("get_item", { id }),
  save: (input: ItemInput) => call<ItemSummary>("save_item", { input }),
  remove: (id: string) => call<void>("delete_item", { id }),
  touch: (id: string) => call<void>("touch_item", { id }),
  favorite: (id: string, favorite: boolean) => call<void>("set_favorite", { id, favorite }),
  tags: () => call<[string, number][]>("list_tags"),
  settings: () => call<Settings>("get_settings"),
  saveSettings: (settings: Settings) => call<void>("set_settings", { settings }),
  generate: (options: GenOptions) => call<string>("generate_password", { options }),
  totp: (secret: string) => call<{ code: string; remaining: number }>("totp_now", { secret }),
  changeMaster: (current: string, next: string) => call<void>("change_master", { current, next }),
  /** 用系统默认浏览器打开（WebView 里 window.open 在 Tauri 下无效） */
  openUrl: (url: string) => call<void>("open_url", { url }),
  /** 生成一份加密备份，返回 base64 */
  exportBackup: () => call<string>("export_backup"),

  /* ---- 触控 ID ---- */
  biometricAvailable: () => call<boolean>("biometric_available"),
  biometricEnrolled: () => call<boolean>("biometric_enrolled"),
  biometricUnlock: () => call<void>("biometric_unlock"),
  biometricEnable: () => call<void>("biometric_enable"),
  biometricDisable: () => call<void>("biometric_disable"),

  /** 彻底清空密码库（要求主密码校验通过） */
  wipeVault: (password: string) => call<void>("wipe_vault", { password }),

  /* ---- 菜单栏 ---- */
  setTrayIcon: (enabled: boolean) => call<void>("set_tray_icon", { enabled }),
  setCloseToTray: (enabled: boolean) => call<void>("set_close_to_tray", { enabled }),
};

/* ---------------- 浏览器里的 mock 后端 ---------------- */

const MASTER = "keylite";

type Row = ItemDetail;
let rows: Row[] = [];
let unlocked = false;
let initialized = false;
let settings: Settings = {
  auto_lock_minutes: 15,
  clipboard_clear_seconds: 30,
  hide_password_by_default: true,
  default_password_length: 24,
  theme: "system",
  sync_enabled: false,
  save_mode: "auto",
  touch_id_enabled: false,
  close_to_tray: true,
  show_tray_icon: true,
};

const now = () => Math.floor(Date.now() / 1000);

function originOf(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function seed() {
  const base = now();
  const raw: [string, string, string, string, number, string[]][] = [
    ["GitHub", "https://github.com/login", "liupurui@me.com", "Kx7#mQ2!pR9$vL4&", 2 * 3600, ["工作", "开发"]],
    ["Figma", "https://figma.com/login", "liupurui@me.com", "fG!8sQ2#wZ5^rT1m", 2 * 3600, ["工作"]],
    ["Stripe 后台", "https://dashboard.stripe.com", "finance@keylite.dev", "St#9kL2$mP4^qR7w", 3 * 86400, ["工作", "金融"]],
    ["支付宝", "https://alipay.com", "138****8123", "Ap!5nM8@kL2#vB6x", 7 * 86400, ["金融"]],
    ["Notion", "https://notion.so", "liupurui@me.com", "Nt3$pQ7!vB2#wZ8m", 7 * 86400, ["工作"]],
    ["阿里云", "https://aliyun.com", "liupurui@me.com", "Al9@kM3#nB7$vC2x", 14 * 86400, ["开发"]],
    ["Vercel", "https://vercel.com/login", "dev@keylite.dev", "Vc4!nB8@mK2#pQ9w", 30 * 86400, ["开发"]],
    ["Linear", "https://linear.app", "liupurui@me.com", "Ln6$vC2!bN8@mK4q", 30 * 86400, ["工作"]],
    ["Cloudflare", "https://dash.cloudflare.com", "ops@keylite.dev", "Cf2#mQ9!vB4@nK7p", 60 * 86400, ["开发"]],
    ["Slack", "https://keylite.slack.com", "liupurui@me.com", "Sl8@nK4#vB2!mQ6w", 60 * 86400, ["工作"]],
    ["微信公众平台", "https://mp.weixin.qq.com", "keylite2024", "Wx1!bN6@mK3#vC8q", 120 * 86400, ["工作"]],
    ["AWS 控制台", "https://console.aws.amazon.com", "ops@keylite.dev", "1234", 150 * 86400, ["开发"]],
  ];
  rows = raw.map(([title, url, username, password, age, tags], i) => ({
    id: `demo-${i}`,
    title,
    url,
    origin: originOf(url),
    username,
    tags,
    favorite: i < 3,
    strength: password.length < 8 ? 1 : 4,
    created_at: base - age - 86400 * 30,
    updated_at: base - age,
    last_used_at: i < 6 ? base - age : null,
    use_count: 30 - i,
    password,
    totp: i === 0 ? "GEZDGNBVGY3TQOJQ" : "",
    notes: i === 0 ? "团队管理员账号，两步验证已开启。改密码后记得同步给设计组。" : "",
  }));
}

function summarize(r: Row): ItemSummary {
  const { password, totp, notes, ...rest } = r;
  void password;
  void totp;
  void notes;
  return rest;
}

async function mock<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const a = (args ?? {}) as Record<string, never>;
  const delay = () => new Promise((r) => setTimeout(r, 80));

  switch (cmd) {
    case "vault_status":
      return { initialized, locked: !unlocked } as T;

    case "create_vault":
    case "unlock": {
      await delay();
      const pw = (a as unknown as { password: string }).password;
      if (cmd === "create_vault") {
        if (initialized) throw "密码库已存在";
        if (pw.length < 8) throw "主密码至少 8 位";
        initialized = true;
        unlocked = true;
        seed();
        return undefined as T;
      }
      if (!initialized) throw "密码库尚未创建";
      if (pw !== MASTER) throw "主密码错误";
      unlocked = true;
      return undefined as T;
    }

    case "lock":
      unlocked = false;
      return undefined as T;

    case "list_items": {
      const { query, tag } = a as unknown as { query: string | null; tag: string | null };
      let out = [...rows].sort(
        (x, y) => (y.last_used_at ?? y.updated_at) - (x.last_used_at ?? x.updated_at)
      );
      if (tag) out = out.filter((r) => r.tags.includes(tag));
      if (query) {
        const q = query.toLowerCase();
        out = out.filter(
          (r) =>
            r.title.toLowerCase().includes(q) ||
            r.url.toLowerCase().includes(q) ||
            r.username.toLowerCase().includes(q) ||
            r.tags.some((t) => t.toLowerCase().includes(q))
        );
      }
      return out.map(summarize) as T;
    }

    case "get_item": {
      const { id } = a as unknown as { id: string };
      const r = rows.find((x) => x.id === id);
      if (!r) throw "找不到该条目";
      return r as T;
    }

    case "save_item": {
      const { input } = a as unknown as { input: ItemInput };
      if (!input.title.trim()) throw "名称不能为空";
      const id = input.id ?? `demo-${Date.now()}`;
      const ts = now();
      const existing = rows.find((r) => r.id === id);
      const row: Row = {
        id,
        title: input.title.trim(),
        url: input.url.trim(),
        origin: originOf(input.url),
        username: input.username.trim(),
        tags: input.tags,
        favorite: input.favorite,
        strength: input.password.length >= 12 ? 4 : input.password.length >= 8 ? 2 : 1,
        created_at: existing?.created_at ?? ts,
        updated_at: ts,
        last_used_at: existing?.last_used_at ?? null,
        use_count: existing?.use_count ?? 0,
        password: input.password,
        totp: input.totp,
        notes: input.notes,
      };
      rows = existing ? rows.map((r) => (r.id === id ? row : r)) : [row, ...rows];
      return summarize(row) as T;
    }

    case "delete_item": {
      const { id } = a as unknown as { id: string };
      rows = rows.filter((r) => r.id !== id);
      return undefined as T;
    }

    case "touch_item": {
      const { id } = a as unknown as { id: string };
      rows = rows.map((r) =>
        r.id === id ? { ...r, last_used_at: now(), use_count: r.use_count + 1 } : r
      );
      return undefined as T;
    }

    case "set_favorite": {
      const { id, favorite } = a as unknown as { id: string; favorite: boolean };
      rows = rows.map((r) => (r.id === id ? { ...r, favorite } : r));
      return undefined as T;
    }

    case "list_tags": {
      const map = new Map<string, number>();
      rows.forEach((r) => r.tags.forEach((t) => map.set(t, (map.get(t) ?? 0) + 1)));
      return [...map.entries()].sort() as T;
    }

    case "get_settings":
      return settings as T;

    case "set_settings": {
      settings = (a as unknown as { settings: Settings }).settings;
      return undefined as T;
    }

    case "generate_password": {
      const o = (a as unknown as { options: GenOptions }).options;
      const pools = [
        o.lower ? "abcdefghijkmnopqrstuvwxyz" : "",
        o.upper ? "ABCDEFGHJKLMNPQRSTUVWXYZ" : "",
        o.digits ? "23456789" : "",
        o.symbols ? "!@#$%^&*()-_=+[]{};:,.?" : "",
      ].filter(Boolean);
      if (!pools.length) return "" as T;
      const all = pools.join("");
      const out: string[] = pools.map((p) => p[Math.floor(Math.random() * p.length)]);
      while (out.length < o.length) out.push(all[Math.floor(Math.random() * all.length)]);
      return out.sort(() => Math.random() - 0.5).join("") as T;
    }

    case "totp_now": {
      const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
      return { code: "482917", remaining } as T;
    }

    case "change_master":
      return undefined as T;

    case "open_url": {
      const { url } = a as unknown as { url: string };
      window.open(url, "_blank", "noopener");
      return undefined as T;
    }

    case "export_backup":
      return "ZGVtby1iYWNrdXA=" as T;

    case "biometric_available":
      return false as T;
    case "biometric_enrolled":
      return false as T;
    case "biometric_unlock":
      throw "浏览器预览模式没有触控 ID，请用主密码解锁";
    case "biometric_enable":
    case "biometric_disable":
    case "set_tray_icon":
    case "set_close_to_tray":
      return undefined as T;
    case "wipe_vault": {
      const { password } = a as unknown as { password: string };
      if (password !== MASTER) throw "主密码错误";
      rows = [];
      return undefined as T;
    }

    default:
      throw `未实现的命令：${cmd}`;
  }
}
