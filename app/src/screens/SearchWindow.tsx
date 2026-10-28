import { useEffect } from "react";
import { api, isTauri, type ItemSummary } from "../lib/api";
import { QuickSearch } from "../components/QuickSearch";
import { applyTheme, type ThemePref } from "../lib/theme";

const hideWindow = () => {
  if (!isTauri()) return;
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().hide())
    .catch(() => {});
};

/**
 * 全局搜索窗口（⌘⇧Space 唤起的独立窗口）。
 * 无边框、置顶、失焦自动收起；选中账号即复制密码并收起。
 */
export function SearchWindow() {
  // 独立窗口也要按设置着色（它不经过 App.tsx）
  useEffect(() => {
    api
      .settings()
      .then((cfg) => applyTheme((cfg.theme ?? "system") as ThemePref))
      .catch(() => applyTheme("system"));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        hideWindow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pick = async (item: ItemSummary) => {
    try {
      const detail = await api.get(item.id);
      await navigator.clipboard.writeText(detail.password);
      await api.touch(item.id).catch(() => {});
    } catch {
      /* 复制失败也收起，避免卡住 */
    }
    hideWindow();
  };

  return <QuickSearch windowMode onClose={hideWindow} onPick={pick} />;
}
