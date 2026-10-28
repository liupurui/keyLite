import { useCallback, useEffect, useRef, useState } from "react";
import { api, isTauri, type ItemSummary, type Settings, type VaultStatus } from "./lib/api";
import { Gate } from "./screens/Gate";
import { Vault } from "./screens/Vault";
import { QuickSearch } from "./components/QuickSearch";
import { SavePrompt, type SaveCandidate } from "./components/SavePrompt";
import { Toast } from "./components/Toast";
import { applyTheme, watchSystemTheme, type ThemePref } from "./lib/theme";

export default function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [quickSearch, setQuickSearch] = useState(false);
  const [candidate, setCandidate] = useState<SaveCandidate | null>(null);
  const [allTags, setAllTags] = useState<string[]>([]);
  const lastActivity = useRef<number>(Date.now());

  const showToast = useCallback((msg: string) => setToast(msg), []);

  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      // 设置不含机密，锁定时也读一次：解锁页也要按主题着色
      setSettings(await api.settings());
    } catch (e) {
      showToast(String(e));
    }
  }, [showToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const lock = useCallback(async () => {
    await api.lock().catch(() => {});
    setQuickSearch(false);
    setCandidate(null);
    await refresh();
  }, [refresh]);

  /* ---------- 浏览器扩展：保存候选 / 自动保存后刷新 ---------- */
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");

      // ask 模式：弹出保存浮窗
      const un1 = await listen<SaveCandidate>("keylite://save-candidate", async (e) => {
        if (cancelled) return;
        const s = await api.status();
        if (s.locked) {
          showToast("网页想保存一条登录，请先解锁密码库");
          return;
        }
        setCandidate(e.payload);
        api.tags().then((t) => setAllTags(t.map(([name]) => name))).catch(() => {});
      });

      // auto 模式：扩展直接存好了，桌面端只需要刷新列表
      const un2 = await listen("keylite://data-changed", () => {
        document.dispatchEvent(new CustomEvent("keylite:data-changed"));
      });

      // 浏览器侧在用密钥库 → 算作活动，重置自动锁定计时
      const un3 = await listen("keylite://activity", () => {
        lastActivity.current = Date.now();
      });

      // 菜单栏图标发来的指令
      const un4 = await listen("keylite://quick-search", () => setQuickSearch(true));
      const un5 = await listen("keylite://open-settings", () =>
        document.dispatchEvent(new CustomEvent("keylite:open-settings"))
      );
      const un6 = await listen("keylite://locked", () => {
        setQuickSearch(false);
        setCandidate(null);
        refresh();
      });

      if (cancelled) {
        un1(); un2(); un3(); un4(); un5(); un6();
        return;
      }
      unlisteners.push(un1, un2, un3, un4, un5, un6);
    })().catch(() => {});

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [showToast]);

  /* ---------- 主题 ---------- */
  useEffect(() => {
    const pref = (settings?.theme ?? "system") as ThemePref;
    applyTheme(pref);
    return watchSystemTheme(pref);
  }, [settings?.theme]);

  /* ---------- 自动锁定 ---------- */
  useEffect(() => {
    if (!status || status.locked) return;
    const bump = () => (lastActivity.current = Date.now());
    const events = ["mousemove", "mousedown", "keydown", "wheel", "focus"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    const minutes = settings?.auto_lock_minutes ?? 15;
    const id =
      minutes > 0
        ? setInterval(() => {
            if (Date.now() - lastActivity.current > minutes * 60_000) lock();
          }, 10_000)
        : null;

    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      if (id) clearInterval(id);
    };
  }, [status, settings, lock]);

  /* ---------- 全局快捷键 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.shiftKey && e.code === "Space") {
        // Tauri 下由全局快捷键唤起独立搜索窗口，这里不再处理，避免双触发
        if (isTauri()) return;
        e.preventDefault();
        setQuickSearch((v) => !v);
      } else if (meta && e.key.toLowerCase() === "l") {
        e.preventDefault();
        lock();
      } else if (meta && e.key.toLowerCase() === "n") {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent("keylite:new-item"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lock]);

  const pickFromSearch = async (item: ItemSummary) => {
    setQuickSearch(false);
    try {
      const detail = await api.get(item.id);
      await navigator.clipboard.writeText(detail.password);
      await api.touch(item.id).catch(() => {});
      showToast(`已复制「${detail.title}」的密码`);
    } catch (e) {
      showToast(String(e));
    }
  };

  if (!status) return <div className="splash">正在打开密码库…</div>;

  return (
    <>
      {status.locked || !status.initialized ? (
        <Gate
          initialized={status.initialized}
          onToast={showToast}
          onUnlocked={async () => {
            lastActivity.current = Date.now();
            await refresh();
            // 用主密码解锁成功后，若已启用触控 ID，刷新钥匙串里的 DEK 副本
            // （系统清理过钥匙串、或刚改过主密码时都能自愈）
            const cfg = await api.settings().catch(() => null);
            if (cfg?.touch_id_enabled) api.biometricEnable().catch(() => {});
          }}
        />
      ) : (
        <Vault onLock={lock} onToast={showToast} onQuickSearch={() => setQuickSearch(true)} />
      )}

      {quickSearch && (
        <QuickSearch onClose={() => setQuickSearch(false)} onPick={pickFromSearch} />
      )}

      {candidate && !status.locked && (
        <SavePrompt
          candidate={candidate}
          allTags={allTags}
          onClose={() => setCandidate(null)}
          onToast={showToast}
          onSaved={() => {
            setCandidate(null);
            document.dispatchEvent(new CustomEvent("keylite:data-changed"));
          }}
        />
      )}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </>
  );
}
