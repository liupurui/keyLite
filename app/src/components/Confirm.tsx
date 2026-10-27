import { IconX } from "../lib/icons";

type Props = {
  title: string;
  message?: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * 应用内确认弹窗。
 *
 * 不要用 window.confirm —— Tauri 的 WKWebView 不实现 JS 对话框，
 * confirm() 会静默返回 false，看起来就像"点了没反应"。
 */
export function Confirm({ title, message, confirmText = "确定", danger, onConfirm, onCancel }: Props) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ width: 360 }} role="alertdialog" aria-modal="true">
        <div className="modal-h">
          <b>{title}</b>
          <button className="icon-btn x" onClick={onCancel} aria-label="关闭">
            <IconX size={13} />
          </button>
        </div>
        <div className="modal-b">
          <p style={{ padding: "16px 0", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.7 }}>
            {message}
          </p>
        </div>
        <div className="modal-f">
          <button className="btn btn-g btn-sm" onClick={onCancel}>
            取消
          </button>
          <button className={`btn btn-sm ${danger ? "btn-danger" : "btn-p"}`} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
