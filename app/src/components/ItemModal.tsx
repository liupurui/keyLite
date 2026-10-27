import { useState } from "react";
import { api, type ItemDetail, type ItemSummary } from "../lib/api";
import { IconEye, IconEyeOff, IconRefresh, IconX } from "../lib/icons";

type Props = {
  initial: ItemDetail | null;
  allTags: string[];
  defaultLength: number;
  onClose: () => void;
  onSaved: (s: ItemSummary) => void;
  onError: (msg: string) => void;
};

export function ItemModal({ initial, allTags, defaultLength, onClose, onSaved, onError }: Props) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState(initial?.password ?? "");
  const [totp, setTotp] = useState(initial?.totp ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [showPw, setShowPw] = useState(true);
  const [busy, setBusy] = useState(false);

  const tagOptions = Array.from(new Set([...allTags, "工作", "个人", "金融", "开发"]));

  const toggleTag = (t: string) =>
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const gen = async () => {
    try {
      const pw = await api.generate({
        length: defaultLength || 24,
        lower: true,
        upper: true,
        digits: true,
        symbols: true,
      });
      setPassword(pw);
      setShowPw(true);
    } catch (e) {
      onError(String(e));
    }
  };

  const save = async () => {
    if (!title.trim()) {
      onError("名称不能为空");
      return;
    }
    setBusy(true);
    try {
      const saved = await api.save({
        id: initial?.id ?? null,
        title,
        url,
        username,
        password,
        totp,
        notes,
        tags,
        favorite: initial?.favorite ?? false,
      });
      onSaved(saved);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-h">
          <b>{initial ? "编辑条目" : "新增条目"}</b>
          <button className="icon-btn x" onClick={onClose} aria-label="关闭">
            <IconX size={13} />
          </button>
        </div>

        <div className="modal-b">
          <div className="mf">
            <div className="lb">名称</div>
            <div className="inp">
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如 GitHub"
              />
            </div>
          </div>

          <div className="mf">
            <div className="lb">网址</div>
            <div className="inp">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/login"
              />
            </div>
          </div>

          <div className="mf">
            <div className="lb">用户名</div>
            <div className="inp">
              <input value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
          </div>

          <div className="mf">
            <div className="lb">
              密码
              <button className="btn-ghost" style={{ marginLeft: "auto" }} onClick={gen}>
                <IconRefresh size={11} /> 生成强密码
              </button>
            </div>
            <div className="inp">
              <input
                className="mono"
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                className="icon-btn"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? "隐藏" : "显示"}
              >
                {showPw ? <IconEyeOff size={13} /> : <IconEye size={13} />}
              </button>
            </div>
          </div>

          <div className="mf">
            <div className="lb">两步验证密钥（可选）</div>
            <div className="inp">
              <input
                className="mono"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                placeholder="Base32，例如 GEZDGNBVGY3TQOJQ"
              />
            </div>
          </div>

          <div className="mf">
            <div className="lb">标签</div>
            <div className="chips">
              {tagOptions.map((t) => (
                <button
                  key={t}
                  className={`chip ${tags.includes(t) ? "on" : ""}`}
                  onClick={() => toggleTag(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="mf">
            <div className="lb">备注</div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="可选，例如：团队管理员账号"
            />
          </div>
        </div>

        <div className="modal-f">
          <button className="btn btn-g btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-p btn-sm" onClick={save} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
