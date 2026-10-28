import { isTauri } from "./api";

export type ThemePref = "system" | "light" | "dark";

const mq = () => window.matchMedia("(prefers-color-scheme: dark)");

export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  return mq().matches ? "dark" : "light";
}

// 记录最近一次「主动设置主题」的时间：
// setTheme 会扰动 WKWebView 的 prefers-color-scheme，若此时恰好注册着
// 「跟随系统」的监听器，会立刻把刚设好的主题覆盖回去（表现为闪一下又变白）
let lastAppliedAt = 0;

/** 把主题写到 <html data-theme>，并让 macOS 原生标题栏跟随 */
export function applyTheme(pref: ThemePref): "light" | "dark" {
  lastAppliedAt = Date.now();
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;

  if (isTauri()) {
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().setTheme(pref === "system" ? null : resolved)
      )
      .catch(() => {
        /* 权限没开或不支持时忽略，只是标题栏不跟随 */
      });
  }
  return resolved;
}

/** 跟随系统时，监听系统外观变化 */
export function watchSystemTheme(pref: ThemePref): () => void {
  const handler = () => {
    if (pref !== "system") return;
    // 忽略刚刚由我们自己的 setTheme 引发的抖动
    if (Date.now() - lastAppliedAt < 600) return;
    applyTheme("system");
  };
  mq().addEventListener("change", handler);
  return () => mq().removeEventListener("change", handler);
}
