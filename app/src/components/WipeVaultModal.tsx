import { useState } from "react";
import { api } from "../lib/api";
import { IconShield, IconX } from "../lib/icons";

type Props = {
  onClose: () => void;
  onDone: () => void;
  onToast: (msg: string) => void;
};

/**
 * 清空密码库。
 * 两道门：必须输入主密码 + 必须勾选确认。
 * 清空后会用同一主密码重建空库（新 salt / 新 DEK），旧密文即使残留在磁盘上也解不开。
 */
export function WipeVaultModal({ onClose, onDone, onToast }: Props) {
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const canSubmit = password.length > 0 && confirmed && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setErr("");
    setBusy(true);
    try {
      await api.wipeVault(password);
      onToast("密码库已清空，可以用同一主密码重新开始");
      onDone();
    } catch (e) {
      setErr(typeof e === "string" ? e : "清空失败");
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 400 }} role="alertdialog" aria-modal="true">
        <div className="modal-h">
          <b style={{ color: "var(--red)" }}>清空密码库</b>
          <button className="icon-btn x" onClick={onClose} aria-label="关闭">
            <IconX size={13} />
          </button>
        </div>

        <div className="modal-b">
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              background: "var(--red-bg)",
              borderRadius: 9,
              padding: "11px 12px",
              margin: "14px 0 4px",
            }}
          >
            <IconShield size={13} />
            <div style={{ fontSize: 11.5, color: "var(--red)", lineHeight: 1.65 }}>
              所有条目、两步验证密钥、备注都会被永久删除，**无法恢复**，主密码也救不回来。
            </div>
          </div>

          <div className="mf">
            <div className="lb">输入主密码以确认身份</div>
            <div className="inp">
              <input
                autoFocus
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="主密码"
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </div>
          </div>

          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              fontSize: 12,
              color: "var(--ink-2)",
              padding: "4px 0 10px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ width: 14, height: 14 }}
            />
            我确认要清空全部数据
          </label>

          {err && (
            <div style={{ fontSize: 11.5, color: "var(--red)", paddingBottom: 10 }}>{err}</div>
          )}
        </div>

        <div className="modal-f">
          <button className="btn btn-g btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-danger btn-sm" onClick={submit} disabled={!canSubmit}>
            {busy ? "清空中…" : "永久清空"}
          </button>
        </div>
      </div>
    </div>
  );
}
