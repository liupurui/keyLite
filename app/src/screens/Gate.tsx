import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { estimateStrength } from "../lib/format";
import { IconClock, IconEye, IconEyeOff, IconFingerprint, IconLock, IconShield } from "../lib/icons";

type Props = {
  initialized: boolean;
  onUnlocked: () => void;
  onToast: (msg: string) => void;
};

export function Gate({ initialized, onUnlocked, onToast }: Props) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);

  // 有触控 ID 硬件 + 录了指纹时才显示指纹入口
  useEffect(() => {
    if (!initialized) return;
    api
      .biometricAvailable()
      .then(setBioAvailable)
      .catch(() => setBioAvailable(false));
  }, [initialized]);

  const unlockWithTouchId = async () => {
    setErr("");
    setBioBusy(true);
    try {
      await api.biometricUnlock();
      onUnlocked();
    } catch (e) {
      setErr(typeof e === "string" ? e : "触控 ID 解锁失败");
    } finally {
      setBioBusy(false);
    }
  };

  const score = estimateStrength(pw);
  const strengthText = ["太短", "很弱", "偏弱", "一般", "不错", "强", "很强"][score];

  const submit = async () => {
    setErr("");
    if (!initialized) {
      if (pw.length < 8) return setErr("主密码至少 8 位");
      if (pw !== pw2) return setErr("两次输入不一致");
    } else if (!pw) {
      return setErr("请输入主密码");
    }

    setBusy(true);
    try {
      if (initialized) await api.unlock(pw);
      else await api.create(pw);
      onUnlocked();
    } catch (e) {
      setErr(typeof e === "string" ? e : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <div className="mark">
        <IconLock size={22} />
      </div>
      <h1>{initialized ? "解锁密码库" : "给你的密码库上一把锁"}</h1>
      <div className="sub">
        {initialized ? (
          "输入主密码继续"
        ) : (
          <>
            主密码只存在于你的记忆里，不上传、不存档。
            <br />
            它同时是所有记录的加密钥匙。
          </>
        )}
      </div>

      <div className="form">
        <div className="inp focus">
          <input
            autoFocus
            type={show ? "text" : "password"}
            value={pw}
            placeholder={initialized ? "主密码" : "设置主密码（至少 8 位）"}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !initialized && pw2 && submit()}
          />
          <button className="icon-btn" onClick={() => setShow((v) => !v)} aria-label="显示密码">
            {show ? <IconEyeOff size={14} /> : <IconEye size={14} />}
          </button>
        </div>

        {!initialized && (
          <>
            <div className="tick-row">
              <div className="ticks" style={{ flex: 1 }}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <i key={i} className={i < score ? `on ${score <= 2 ? "bad" : score <= 4 ? "weak" : ""}` : ""} />
                ))}
              </div>
              <span>{strengthText}</span>
            </div>
            <div className="inp">
              <input
                type={show ? "text" : "password"}
                value={pw2}
                placeholder="再输入一次"
                onChange={(e) => setPw2(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </div>
          </>
        )}

        <div className="err">{err}</div>

        <button className="btn btn-p" onClick={submit} disabled={busy}>
          {busy ? "请稍候…" : initialized ? "解锁" : "创建密码库"}
        </button>

        {initialized && bioAvailable && (
          <>
            <div className="or">或</div>
            <button className="btn btn-g" onClick={unlockWithTouchId} disabled={bioBusy}>
              <IconFingerprint size={14} />
              {bioBusy ? "等待指纹验证…" : "使用触控 ID 解锁"}
            </button>
          </>
        )}
      </div>

      <div className="foot">
        <IconClock size={11} />
        {initialized ? "空闲 15 分钟后自动锁定" : "AES-256-GCM · Argon2id · 全程离线"}
        {!initialized && (
          <>
            <span style={{ opacity: 0.5 }}>·</span>
            <IconShield size={11} />
          </>
        )}
      </div>
    </div>
  );
}
