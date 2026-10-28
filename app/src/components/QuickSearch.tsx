import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ItemSummary } from "../lib/api";
import { initials, relativeTime } from "../lib/format";
import { IconSearch } from "../lib/icons";

type Props = {
  onClose: () => void;
  onPick: (item: ItemSummary) => void;
  /** true = 作为独立窗口渲染（无遮罩、铺满窗口） */
  windowMode?: boolean;
};

export function QuickSearch({ onClose, onPick, windowMode }: Props) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    api.list().then(setItems).catch(() => setItems([]));
  }, []);

  // 独立窗口被 ⌘⇧Space 反复唤起时，重新聚焦并清空输入
  useEffect(() => {
    if (!windowMode) return;
    let un: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("keylite://search-focus", () => {
          setQ("");
          inputRef.current?.focus();
          inputRef.current?.select();
        })
      )
      .then((f) => (un = f))
      .catch(() => {});
    return () => un?.();
  }, [windowMode]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items.slice(0, 8);
    return items
      .filter(
        (i) =>
          i.title.toLowerCase().includes(s) ||
          i.url.toLowerCase().includes(s) ||
          i.username.toLowerCase().includes(s) ||
          i.tags.some((t) => t.toLowerCase().includes(s))
      )
      .slice(0, 8);
  }, [q, items]);

  useEffect(() => setIdx(0), [q]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[idx];
      if (item) onPick(item);
    }
  };

  const card = (
    <div className="qs" onKeyDown={onKeyDown}>
        <div className="qs-i">
          <IconSearch size={15} className="muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索名称、网址、账号或标签"
          />
          <span className="kbd">esc</span>
        </div>

        <div className="qs-l">
          {filtered.length === 0 && (
            <div style={{ padding: "18px 12px", fontSize: 12.5, color: "var(--muted)" }}>
              没有匹配的条目
            </div>
          )}
          {filtered.map((item, i) => (
            <button
              key={item.id}
              className={`qr ${i === idx ? "on" : ""}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => onPick(item)}
            >
              <span className="avatar">{initials(item.title, item.origin)}</span>
              <span style={{ minWidth: 0 }}>
                <div className="nm">{item.title}</div>
                <div className="dm">
                  {item.username || "未填用户名"} · {item.origin || item.url}
                </div>
              </span>
              <span className="ac">{relativeTime(item.last_used_at)}</span>
            </button>
          ))}
        </div>

        <div className="qs-f">
          <span>
            <b>↑↓</b> 选择
          </span>
          <span>
            <b>↵</b> 复制密码
          </span>
          <span>
            <b>esc</b> 关闭
          </span>
          <span className="grow">共 {items.length} 条</span>
        </div>
    </div>
  );

  if (windowMode) {
    return <div className="qs-window">{card}</div>;
  }

  return (
    <div className="qs-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {card}
    </div>
  );
}
