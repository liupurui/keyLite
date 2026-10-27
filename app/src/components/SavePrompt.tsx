import { useState } from "react";
import { api } from "../lib/api";
import { initials, maskPassword } from "../lib/format";
import { IconCheck, IconEye, IconEyeOff, IconShield, IconX } from "../lib/icons";

/** 扩展上报的登录候选 */
export type SaveCandidate = {
  url: string;
  origin: string;
  username: string;
  password: string;
};

type Props = {
  candidate: SaveCandidate;
  allTags: string[];
  onClose: () => void;
  onSaved: () => void;
  onToast: (msg: string) => void;
};

/**
 * 保存浮窗（设计稿 06）。
 * 由浏览器扩展在表单提交后触发，右下角出现，不抢焦点。
 * 名称和用户名可编辑 —— 页面上抓到的字段不一定对（比如抓到按钮文案），
 * 存之前让用户改掉，比存一堆垃圾数据再删强。
 */
export function SavePrompt({ candidate, allTags, onClose, onSaved, onToast }: Props) {
  const [name, setName] = useState(candidate.origin || "未命名站点");
  const [username, setUsername] = useState(candidate.username);
  const [tags, setTags] = useState<string[]>(["工作"]);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  const tagOptions = Array.from(new Set([...allTags, "工作", "个人", "金融", "开发"]));

  const toggle = (t: string) =>
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const save = async () => {
    if (!name.trim()) {
      onToast("名称不能为空");
      return;
    }
    setBusy(true);
    try {
      await api.save({
        id: null,
        title: name.trim(),
        url: candidate.url,
        username: username.trim(),
        password: candidate.password,
        totp: "",
        notes: "",
        tags,
        favorite: false,
      });
      onToast("已保存到密钥库");
      onSaved();
    } catch (e) {
      onToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="save-prompt" role="dialog" aria-label="保存这条登录">
      <div className="sp-h">
        <span className="avatar">{initials(name, candidate.origin)}</span>
        <div style={{ minWidth: 0 }}>
          <div className="tt">保存这条登录？</div>
          <div className="sd">{candidate.origin}</div>
        </div>
        <button className="icon-btn x" onClick={onClose} aria-label="关闭">
          <IconX size={13} />
        </button>
      </div>

      <div className="sp-r">
        <div className="lb">名称</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 QQ 邮箱" />
      </div>
      <div className="sp-r">
        <div className="lb">账号</div>
        <input
          className="mono-in"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="页面没抓到就手填"
        />
      </div>
      <div className="sp-r">
        <div className="lb">密码</div>
        <div className="dots2">{show ? candidate.password : maskPassword(candidate.password)}</div>
        <button className="icon-btn eye" onClick={() => setShow((v) => !v)} aria-label="显示密码">
          {show ? <IconEyeOff size={13} /> : <IconEye size={13} />}
        </button>
      </div>

      <div className="sp-tags">
        {tagOptions.slice(0, 3).map((t) => (
          <button key={t} className={`chip ${tags.includes(t) ? "on" : ""}`} onClick={() => toggle(t)}>
            {tags.includes(t) && <IconCheck size={10} />} {t}
          </button>
        ))}
      </div>

      <div className="sp-f">
        <button className="btn btn-p" onClick={save} disabled={busy}>
          {busy ? "保存中…" : "保存"}
        </button>
        <button className="btn btn-g" onClick={onClose}>
          不保存
        </button>
      </div>

      <div className="sp-n">
        <IconShield size={11} /> 使用主密码加密，只存本机
      </div>
    </div>
  );
}
