import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ItemDetail, type ItemSummary, type Settings } from "../lib/api";
import { dateOnly, initials, maskPassword, relativeTime, strengthLabel } from "../lib/format";
import {
  IconChevronDown,
  IconClock,
  IconCopy,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconGear,
  IconKey,
  IconLink,
  IconLock,
  IconPlus,
  IconSearch,
  IconShield,
  IconStar,
  IconTrash,
} from "../lib/icons";
import { ItemModal } from "../components/ItemModal";
import { Confirm } from "../components/Confirm";
import { SettingsScreen } from "./SettingsScreen";

type Props = {
  onLock: () => void;
  /** 设置变更后回传给 App，保证主题/自动锁定用的是同一份数据 */
  onSettingsChanged?: (s: Settings) => void;
  onToast: (msg: string) => void;
  onQuickSearch: () => void;
};

type Cat = "all" | "fav" | "recent" | "weak";

export function Vault({ onLock, onToast, onQuickSearch, onSettingsChanged }: Props) {
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [tags, setTags] = useState<[string, number][]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Cat>("all");
  const [tag, setTag] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [reveal, setReveal] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  const [modal, setModal] = useState<{ item: ItemDetail | null } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [view, setView] = useState<"vault" | "settings">("vault");
  const [totp, setTotp] = useState<{ code: string; remaining: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /* ---------- 数据加载 ---------- */
  const reload = useCallback(async () => {
    const [list, t] = await Promise.all([api.list(q, tag ?? undefined), api.tags()]);
    setItems(list);
    setTags(t);
  }, [q, tag]);

  useEffect(() => {
    reload().catch((e) => onToast(String(e)));
  }, [reload, onToast]);

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
  }, []);

  // 选中项失效时自动选第一条
  useEffect(() => {
    if (items.length === 0) {
      setSelId(null);
      return;
    }
    if (!selId || !items.some((i) => i.id === selId)) setSelId(items[0].id);
  }, [items, selId]);

  useEffect(() => {
    if (!selId) {
      setDetail(null);
      return;
    }
    let alive = true;
    api
      .get(selId)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetail(null));
    return () => {
      alive = false;
    };
  }, [selId]);

  // 两步验证码每秒刷新
  useEffect(() => {
    setReveal(settings ? !settings.hide_password_by_default : false);
  }, [selId, settings]);

  useEffect(() => {
    setTotp(null);
    if (!detail?.totp) return;
    let alive = true;
    const tick = () => api.totp(detail.totp).then((r) => alive && setTotp(r)).catch(() => {});
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [detail?.totp]);

  // 按住 ⌥ 显示密码
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    // ⌘N 新增条目（App.tsx 转发）+ 外部数据变化（保存浮窗写入后）
    const onNew = () => setModal({ item: null });
    const onChanged = () => reload().catch(() => {});
    const onOpenSettings = () => setView("settings");
    document.addEventListener("keylite:new-item", onNew);
    document.addEventListener("keylite:data-changed", onChanged);
    document.addEventListener("keylite:open-settings", onOpenSettings);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      document.removeEventListener("keylite:new-item", onNew);
      document.removeEventListener("keylite:data-changed", onChanged);
      document.removeEventListener("keylite:open-settings", onOpenSettings);
    };
  }, [reload]);

  /* ---------- 过滤 ---------- */
  const visible = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    switch (cat) {
      case "fav":
        return items.filter((i) => i.favorite);
      case "recent":
        return items.filter((i) => i.last_used_at && now - i.last_used_at < 86400 * 7);
      case "weak":
        return items.filter((i) => i.strength <= 1);
      default:
        return items;
    }
  }, [items, cat]);

  /* ---------- 动作 ---------- */
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`已复制${label}`);
      const secs = settings?.clipboard_clear_seconds ?? 30;
      if (secs > 0) {
        setTimeout(async () => {
          try {
            const cur = await navigator.clipboard.readText();
            if (cur === text) await navigator.clipboard.writeText("");
          } catch {
            /* 读不到就不动剪贴板，宁可留内容也不误删 */
          }
        }, secs * 1000);
      }
    } catch {
      onToast("复制失败，请检查系统剪贴板权限");
    }
  };

  const copyPassword = async () => {
    if (!detail) return;
    await copy(detail.password, "密码");
    await api.touch(detail.id).catch(() => {});
  };

  const openAndLogin = async () => {
    if (!detail) return;
    const url = detail.url || `https://${detail.origin}`;
    try {
      await api.openUrl(url);
      await api.touch(detail.id).catch(() => {});
      await copy(detail.password, "密码");
    } catch (e) {
      onToast(String(e));
    }
  };

  const removeItem = async () => {
    if (!detail) return;
    setConfirmDel(true);
  };

  const doDelete = async () => {
    if (!detail) return;
    await api.remove(detail.id);
    onToast("已删除");
    setConfirmDel(false);
    setSelId(null);
    setDetail(null);
    reload();
  };

  const toggleFav = async () => {
    if (!detail) return;
    await api.favorite(detail.id, !detail.favorite);
    setDetail({ ...detail, favorite: !detail.favorite });
    reload();
  };

  const counts = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    return {
      all: items.length,
      fav: items.filter((i) => i.favorite).length,
      recent: items.filter((i) => i.last_used_at && now - i.last_used_at < 86400 * 7).length,
      weak: items.filter((i) => i.strength <= 1).length,
    };
  }, [items]);

  const tagColors = ["#2563EB", "#059669", "#B45309", "#7C3AED", "#0891B2", "#BE123C"];

  if (view === "settings") {
    return (
      <SettingsScreen
        onBack={() => setView("vault")}
        onToast={onToast}
        onChanged={(s) => {
          setSettings(s);
          onSettingsChanged?.(s);
        }}
        onLock={onLock}
      />
    );
  }

  return (
    <div className="app">
      {/* ---------------- 侧栏 ---------------- */}
      <aside className="sidebar">
        <div className="sb-brand">
          <div className="mark">
            <IconKey size={12} />
          </div>
          <b>密钥库</b>
          <button
            className="add"
            title="新增条目"
            onClick={() => setModal({ item: null })}
            aria-label="新增条目"
          >
            <IconPlus size={12} />
          </button>
        </div>

        <div className="srch">
          <IconSearch size={12} />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索"
          />
          <span className="kbd">⌘K</span>
        </div>

        <div className="sb-lab">分类</div>
        <button className={`ni ${cat === "all" && !tag ? "on" : ""}`} onClick={() => { setCat("all"); setTag(null); }}>
          <IconLock size={13} /> 全部条目 <span className="n">{counts.all}</span>
        </button>
        <button className={`ni ${cat === "fav" ? "on" : ""}`} onClick={() => { setCat("fav"); setTag(null); }}>
          <IconStar size={13} /> 收藏 <span className="n">{counts.fav}</span>
        </button>
        <button className={`ni ${cat === "recent" ? "on" : ""}`} onClick={() => { setCat("recent"); setTag(null); }}>
          <IconClock size={13} /> 最近使用 <span className="n">{counts.recent}</span>
        </button>
        <button className={`ni ${cat === "weak" ? "on" : ""}`} onClick={() => { setCat("weak"); setTag(null); }}>
          <IconShield size={13} /> 弱密码 {counts.weak > 0 && <span className="dot" />}
        </button>

        <div className="sb-lab">标签</div>
        {tags.map(([t, n], i) => (
          <button
            key={t}
            className={`ni ${tag === t ? "on" : ""}`}
            onClick={() => { setTag(tag === t ? null : t); setCat("all"); }}
          >
            <span className="tg" style={{ background: tagColors[i % tagColors.length] }} />
            {t} <span className="n">{n}</span>
          </button>
        ))}
        {tags.length === 0 && (
          <div style={{ fontSize: 11, color: "#94A3B8", padding: "2px 8px" }}>还没有标签</div>
        )}

        <div className="sb-foot">
          <div className="sb-stat">
            <IconShield size={11} /> 本地加密 · 已解锁
          </div>
          <button className="ni" onClick={() => setView("settings")}>
            <IconGear size={13} /> 设置
          </button>
          <button className="ni" onClick={onLock}>
            <IconLock size={13} /> 立即锁定 <span className="n">⌘L</span>
          </button>
        </div>
      </aside>

      {/* ---------------- 列表 ---------------- */}
      <section className="list">
        <div className="lh">
          <div>
            <div className="t">
              {tag ? `标签 · ${tag}` : cat === "fav" ? "收藏" : cat === "recent" ? "最近使用" : cat === "weak" ? "弱密码" : "全部条目"}
            </div>
            <div className="s">共 {visible.length} 条</div>
          </div>
          <div className="sort">
            最近使用 <IconChevronDown size={11} />
          </div>
        </div>

        <div className="rows">
          {visible.map((item) => (
            <button
              key={item.id}
              className={`row ${selId === item.id ? "sel" : ""}`}
              onClick={() => setSelId(item.id)}
            >
              <span className={`avatar ${item.origin ? "" : "g"}`}>
                {initials(item.title, item.origin)}
              </span>
              <span style={{ minWidth: 0 }}>
                <div className="nm">
                  {item.title}
                  {item.favorite && (
                    <span style={{ color: "#F59E0B", display: "flex" }}>
                      <IconStar size={11} />
                    </span>
                  )}
                </div>
                <div className="dm">{item.origin || item.url || "未填网址"}</div>
              </span>
              <span className="tm">{relativeTime(item.last_used_at ?? item.updated_at)}</span>
            </button>
          ))}

          {visible.length === 0 && (
            <div style={{ padding: 24, fontSize: 12.5, color: "var(--muted)", textAlign: "center" }}>
              {q ? "没有匹配的条目" : "这里还是空的，点右上角 + 新增一条"}
            </div>
          )}
        </div>
      </section>

      {/* ---------------- 详情 ---------------- */}
      <section className="detail">
        {!detail ? (
          <div className="empty">
            <div className="big">
              <IconKey size={20} />
            </div>
            <div>选择左侧条目查看详情</div>
            <button className="btn btn-p btn-sm" onClick={() => setModal({ item: null })}>
              <IconPlus size={13} /> 新增条目
            </button>
          </div>
        ) : (
          <>
            <div className="dt-h">
              <div className="avatar">{initials(detail.title, detail.origin)}</div>
              <div style={{ minWidth: 0 }}>
                <h3>
                  {detail.title}
                  {detail.favorite && (
                    <span style={{ color: "#F59E0B", display: "flex" }}>
                      <IconStar size={13} />
                    </span>
                  )}
                </h3>
                <div className="url">
                  <IconLink size={11} /> {detail.origin || detail.url || "未填网址"}
                </div>
              </div>
              <div className="acts">
                <button className="icon-btn boxed" title="收藏" onClick={toggleFav}>
                  <IconStar size={13} />
                </button>
                <button
                  className="icon-btn boxed"
                  title="编辑"
                  onClick={() => setModal({ item: detail })}
                >
                  <IconEdit size={13} />
                </button>
                <button className="icon-btn boxed" title="删除" onClick={removeItem}>
                  <IconTrash size={13} />
                </button>
              </div>
            </div>

            <div className="dt-b">
              <div className="fld">
                <div className="lb">用户名</div>
                <div className="val">
                  <span className="mono">{detail.username || "—"}</span>
                  {detail.username && (
                    <button
                      className="icon-btn boxed"
                      style={{ marginLeft: "auto" }}
                      onClick={() => copy(detail.username, "用户名")}
                      title="复制用户名"
                    >
                      <IconCopy size={12} />
                    </button>
                  )}
                </div>
              </div>

              <div className="fld">
                <div className="lb">
                  密码
                  <span className={strengthLabel(detail.strength).cls}>
                    强度：{strengthLabel(detail.strength).text}
                  </span>
                </div>
                <div className="val">
                  {reveal || altHeld ? (
                    <span className="mono">{detail.password}</span>
                  ) : (
                    <span className="dots">{maskPassword(detail.password)}</span>
                  )}
                  <span className="hint">按住 ⌥ 显示</span>
                  <button
                    className="icon-btn"
                    onClick={() => setReveal((v) => !v)}
                    title={reveal ? "隐藏" : "显示"}
                  >
                    {reveal ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                  </button>
                  <button className="icon-btn boxed" onClick={copyPassword} title="复制密码">
                    <IconCopy size={12} />
                  </button>
                </div>
              </div>

              {detail.totp && (
                <div className="fld">
                  <div className="lb">两步验证码</div>
                  <div className="val">
                    <span className="code">
                      {totp ? `${totp.code.slice(0, 3)} ${totp.code.slice(3)}` : "······"}
                    </span>
                    <span
                      className="ring"
                      style={{ ["--p" as string]: `${totp ? ((30 - totp.remaining) / 30) * 100 : 0}%` }}
                    />
                    <span className="hint">{totp ? `${totp.remaining} 秒后刷新` : ""}</span>
                    <button
                      className="icon-btn boxed"
                      style={{ marginLeft: "auto" }}
                      onClick={() => totp && copy(totp.code, "验证码")}
                      title="复制验证码"
                    >
                      <IconCopy size={12} />
                    </button>
                  </div>
                </div>
              )}

              <div className="fld">
                <div className="lb">网址</div>
                <div className="val">
                  <span className="mono" style={{ color: "var(--blue)" }}>
                    {detail.url || "—"}
                  </span>
                </div>
              </div>

              {detail.tags.length > 0 && (
                <div className="fld">
                  <div className="lb">标签</div>
                  <div className="chips">
                    {detail.tags.map((t) => (
                      <span key={t} className="chip on">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="fld" style={{ borderBottom: "none" }}>
                <div className="lb">备注</div>
                <div className="val" style={{ color: "var(--muted)", fontSize: 12.5, lineHeight: 1.6 }}>
                  {detail.notes || "—"}
                </div>
              </div>

              <div className="meta">
                <div>
                  上次使用<b>{relativeTime(detail.last_used_at)}</b>
                </div>
                <div>
                  使用次数<b>{detail.use_count} 次</b>
                </div>
                <div>
                  创建于<b>{dateOnly(detail.created_at)}</b>
                </div>
              </div>
            </div>

            <div className="dt-f">
              <button className="btn btn-p" onClick={openAndLogin}>
                <IconLink size={13} /> 在浏览器中打开并登录
              </button>
              <button className="btn btn-g" onClick={copyPassword}>
                复制密码
              </button>
              <button
                className="btn btn-g"
                style={{ marginLeft: "auto" }}
                onClick={onQuickSearch}
                title="⌘⇧Space"
              >
                <IconSearch size={13} /> 快速搜索
              </button>
            </div>
          </>
        )}
      </section>

      {modal && (
        <ItemModal
          initial={modal.item}
          allTags={tags.map(([t]) => t)}
          defaultLength={settings?.default_password_length ?? 24}
          onClose={() => setModal(null)}
          onError={onToast}
          onSaved={(s) => {
            setModal(null);
            setSelId(s.id);
            onToast(modal.item ? "已保存修改" : "已新增条目");
            reload();
          }}
        />
      )}

      {confirmDel && detail && (
        <Confirm
          title="删除条目"
          message={`「${detail.title}」将被永久删除，且无法恢复。确定继续？`}
          confirmText="删除"
          danger
          onConfirm={doDelete}
          onCancel={() => setConfirmDel(false)}
        />
      )}
    </div>
  );
}
