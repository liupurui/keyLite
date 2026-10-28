import { useEffect, useState } from "react";
import { api, isTauri, type Settings } from "../lib/api";
import { IconChevronRight, IconShield } from "../lib/icons";
import { WipeVaultModal } from "../components/WipeVaultModal";
import { applyTheme, type ThemePref } from "../lib/theme";

type Props = {
  onBack: () => void;
  onToast: (msg: string) => void;
  onChanged: (s: Settings) => void;
  onLock: () => void;
};

const AUTO_LOCK_OPTIONS = [0, 5, 15, 30, 60];
const CLIP_OPTIONS = [0, 15, 30, 60, 120];
const LENGTH_OPTIONS = [12, 16, 20, 24, 32, 40];

function label(v: number, unit: string) {
  if (v === 0) return unit === "分钟" ? "关闭" : "不清空";
  return `${v} ${unit}`;
}

export function SettingsScreen({ onBack, onToast, onChanged, onLock }: Props) {
  const [s, setS] = useState<Settings | null>(null);
  const [bioAvailable, setBioAvailable] = useState<boolean | null>(null);
  const [showWipe, setShowWipe] = useState(false);

  useEffect(() => {
    api.settings().then(setS).catch(() => {});
    // 这台机器到底有没有可用的触控 ID —— 没有就把开关禁掉，
    // 而不是让用户打开一个永远用不上的选项
    api
      .biometricAvailable()
      .then(setBioAvailable)
      .catch(() => setBioAvailable(false));
  }, []);

  const toggleTouchId = async () => {
    if (!s) return;
    if (!s.touch_id_enabled) {
      try {
        await api.biometricEnable();
        const next = { ...s, touch_id_enabled: true };
        setS(next);
        onChanged(next);
        onToast("已开启触控 ID 解锁，下次打开应用按指纹即可");
      } catch (e) {
        onToast(typeof e === "string" ? e : "开启失败");
      }
    } else {
      await api.biometricDisable().catch(() => {});
      const next = { ...s, touch_id_enabled: false };
      setS(next);
      onChanged(next);
      onToast("已关闭触控 ID 解锁，钥匙串里的密钥副本已删除");
    }
  };

  const update = async (patch: Partial<Settings>) => {
    if (!s) return;
    const next = { ...s, ...patch };
    setS(next);
    try {
      await api.saveSettings(next);
      onChanged(next);
    } catch (e) {
      onToast(String(e));
    }
  };

  if (!s) return <div className="splash">读取设置…</div>;

  return (
    <div className="settings">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button className="btn btn-g btn-sm" onClick={onBack}>
          ← 返回密码库
        </button>
        <button className="btn btn-g btn-sm" style={{ marginLeft: "auto" }} onClick={onLock}>
          立即锁定
        </button>
      </div>

      <h2 style={{ marginTop: 18 }}>设置</h2>
      <div className="intro">管理密码库偏好与安全设置</div>

      <div className="panel">
        <div className="srow">
          <div className="info">
            <b>自动锁定</b>
            <span>
              {s.auto_lock_minutes === 0
                ? "只在手动锁定、退出应用时锁定（最省事）"
                : `空闲 ${s.auto_lock_minutes} 分钟后自动锁定；在浏览器里使用密钥库也算活动`}
            </span>
          </div>
          <div className="grow" />
          <div className="seg">
            {AUTO_LOCK_OPTIONS.map((v) => (
              <button
                key={v}
                className={s.auto_lock_minutes === v ? "on" : ""}
                onClick={() => update({ auto_lock_minutes: v })}
              >
                {label(v, "分钟")}
              </button>
            ))}
          </div>
        </div>

        <div className="srow">
          <div className="info">
            <b>默认隐藏密码</b>
            <span>打开条目时以掩码显示密码</span>
          </div>
          <div className="grow" />
          <button
            className={`toggle ${s.hide_password_by_default ? "" : "off"}`}
            onClick={() => update({ hide_password_by_default: !s.hide_password_by_default })}
            aria-label="默认隐藏密码"
          >
            <i />
          </button>
        </div>

        <div className="srow">
          <div className="info">
            <b>用触控 ID 解锁</b>
            <span>
              {bioAvailable === false
                ? "这台 Mac 没有可用的触控 ID（未检测到硬件，或尚未录入指纹）"
                : s.touch_id_enabled
                ? "指纹验证通过即解锁，不用再输主密码"
                : "开启后密钥副本存入系统钥匙串，由指纹把关"}
            </span>
          </div>
          <div className="grow" />
          <button
            className={`toggle ${s.touch_id_enabled ? "" : "off"}`}
            onClick={toggleTouchId}
            disabled={bioAvailable === false}
            style={bioAvailable === false ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
            aria-label="用触控 ID 解锁"
          >
            <i />
          </button>
        </div>

        <div className="srow">
          <div className="info">
            <b>菜单栏图标</b>
            <span>在屏幕右上角常驻一个小图标，随时唤起</span>
          </div>
          <div className="grow" />
          <button
            className={`toggle ${s.show_tray_icon ? "" : "off"}`}
            onClick={async () => {
              const next = !s.show_tray_icon;
              try {
                await api.setTrayIcon(next);
                update({ show_tray_icon: next });
                onToast(next ? "菜单栏图标已显示" : "菜单栏图标已隐藏");
              } catch (e) {
                onToast(String(e));
              }
            }}
            aria-label="菜单栏图标"
          >
            <i />
          </button>
        </div>

        <div className="srow">
          <div className="info">
            <b>关闭窗口时后台运行</b>
            <span>
              {s.show_tray_icon
                ? "点关闭按钮只隐藏窗口，浏览器扩展继续可用"
                : "菜单栏图标关闭时此项不生效，关窗口即退出"}
            </span>
          </div>
          <div className="grow" />
          <button
            className={`toggle ${s.close_to_tray && s.show_tray_icon ? "" : "off"}`}
            disabled={!s.show_tray_icon}
            onClick={async () => {
              const next = !s.close_to_tray;
              try {
                await api.setCloseToTray(next);
                update({ close_to_tray: next });
              } catch (e) {
                onToast(String(e));
              }
            }}
            aria-label="关闭窗口时后台运行"
          >
            <i />
          </button>
        </div>

        <div className="srow">
          <div className="info">
            <b>保存方式</b>
            <span>
              {s.save_mode === "auto"
                ? "提交登录后直接保存，网页上给提示并可撤销"
                : "提交后推送到桌面端，等你点确认"}
            </span>
          </div>
          <div className="grow" />
          <div className="seg">
            <button
              className={s.save_mode === "auto" ? "on" : ""}
              onClick={() => update({ save_mode: "auto" })}
            >
              自动保存
            </button>
            <button
              className={s.save_mode === "ask" ? "on" : ""}
              onClick={() => update({ save_mode: "ask" })}
            >
              先询问
            </button>
          </div>
        </div>

        <div className="srow">
          <div className="info">
            <b>复制后清空剪贴板</b>
            <span>只清空本次复制的内容，不碰你自己的剪贴板</span>
          </div>
          <div className="grow" />
          <div className="seg">
            {CLIP_OPTIONS.map((v) => (
              <button
                key={v}
                className={s.clipboard_clear_seconds === v ? "on" : ""}
                onClick={() => update({ clipboard_clear_seconds: v })}
              >
                {label(v, "秒")}
              </button>
            ))}
          </div>
        </div>

        <div className="srow">
          <div className="info">
            <b>默认密码长度</b>
            <span>生成新密码时使用</span>
          </div>
          <div className="grow" />
          <div className="seg">
            {LENGTH_OPTIONS.map((v) => (
              <button
                key={v}
                className={s.default_password_length === v ? "on" : ""}
                onClick={() => update({ default_password_length: v })}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="srow">
          <div className="info">
            <b>多设备同步</b>
            <span>{s.sync_enabled ? "端到端加密，密钥不上传（M5 上线）" : "关闭时数据只在本机"}</span>
          </div>
          <div className="grow" />
          <button
            className={`toggle ${s.sync_enabled ? "" : "off"}`}
            onClick={() => {
              update({ sync_enabled: !s.sync_enabled });
              onToast(s.sync_enabled ? "已关闭多设备同步" : "同步将在 M5 上线，当前仅记录偏好");
            }}
            aria-label="多设备同步"
          >
            <i />
          </button>
        </div>

        <div className="srow">
          <div className="info">
            <b>主题</b>
            <span>外观模式</span>
          </div>
          <div className="grow" />
          <div className="seg">
            {[
              ["system", "跟随系统"],
              ["light", "浅色"],
              ["dark", "深色"],
            ].map(([v, t]) => (
              <button
                key={v}
                className={s.theme === v ? "on" : ""}
                onClick={() => {
                  update({ theme: v });
                  applyTheme(v as ThemePref);
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="srow" style={{ minHeight: 44 }}>
          <div className="info">
            <b>加密</b>
            <span>全部在本机运算，无云端参与</span>
          </div>
        </div>
        <div className="kv">
          <span>内容加密</span>
          <b>AES-256-GCM</b>
        </div>
        <div className="kv">
          <span>密钥派生</span>
          <b>Argon2id · m=64MiB t=3 p=4</b>
        </div>
        <div className="kv">
          <span>运行形态</span>
          <b>{isTauri() ? "Tauri 桌面版（Rust 内核）" : "浏览器预览（内存 mock）"}</b>
        </div>
      </div>

      <div className="panel">
        <div className="srow" style={{ minHeight: 44 }}>
          <div className="info">
            <b>浏览器扩展</b>
            <span>负责识别登录框、右键填充与保存提示</span>
          </div>
        </div>
        <div className="srow">
          <div className="info">
            <b>Chrome / Edge</b>
            <span>安装 extension/ 目录后自动连接本机</span>
          </div>
          <div className="grow" />
          <span style={{ fontSize: 11, color: "var(--muted)" }}>M2</span>
        </div>
        <div className="srow">
          <div className="info">
            <b>Safari</b>
            <span>需要 Xcode 工程签名后安装</span>
          </div>
          <div className="grow" />
          <span style={{ fontSize: 11, color: "var(--muted)" }}>M3</span>
        </div>
      </div>

      <div className="danger-zone">
        <IconShield size={12} />
        <b>删除密码库数据</b>
        <div className="grow" />
        <button onClick={() => setShowWipe(true)}>管理 ›</button>
        <IconChevronRight size={10} />
      </div>

      <div style={{ fontSize: 10.5, color: "#94A3B8", marginTop: 18, lineHeight: 1.7 }}>
        密钥库 v0.1.0 · 本地加密 · 不收集任何使用数据
      </div>

      {showWipe && (
        <WipeVaultModal
          onClose={() => setShowWipe(false)}
          onToast={onToast}
          onDone={() => {
            setShowWipe(false);
            onLock();
          }}
        />
      )}
    </div>
  );
}
