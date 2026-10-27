/**
 * 密钥库 · 浏览器扩展 content script
 *
 * 职责：
 * 1. 记录最近聚焦的 用户名/密码 输入框，右键菜单点击后把凭据填进去；
 * 2. 监听登录提交，把候选交给桌面端自动保存，并在页面上就地反馈
 *    （自动保存 / 已存在 / 需要你决定是否覆盖 / 未解锁）。
 *
 * 反馈直接画在页面里，不经过后台注入 —— 更稳，也不依赖 service worker 活着。
 * 本脚本不联网、不存储任何东西。
 */

(() => {
  "use strict";

  let lastUsernameField = null;
  let lastPasswordField = null;
  let lastMenuRefresh = 0;

  /* ---------------- 工具 ---------------- */

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  /** 调试日志：在页面控制台执行 localStorage.keyliteDebug='1' 后刷新即开启 */  const log = (...args) => {
    try {
      if (localStorage.getItem("keyliteDebug") === "1") console.info("[密钥库]", ...args);
    } catch {
      /* ignore */
    }
  };

  /**
   * 安全的消息发送。
   * 扩展被「刷新 / 停用」后，页面上残留的旧脚本再调 chrome.runtime 会抛
   * "Extension context invalidated"。这里统一兜住：检测到失效就静默退场，
   * 不再往控制台刷错误（刷新页面后由新脚本接管）。
   */
  let contextDead = false;
  const safeSend = (msg, cb) => {
    if (contextDead) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err && /invalidated/i.test(err.message || "")) {
            contextDead = true;
            log("扩展已被重载，旧脚本停止工作（刷新页面后由新脚本接管）");
            resolve(null);
            return;
          }
          resolve(res ?? null);
        });
      } catch (e) {
        if (/invalidated/i.test(String((e && e.message) || ""))) contextDead = true;
        resolve(null);
      }
    }).then((res) => {
      if (cb && !contextDead) cb(res);
      return res;
    });
  };

  const isUsernameLike = (el) => {
    if (el.type === "email") return true;
    const hints = `${el.name} ${el.id} ${el.autocomplete || ""} ${el.placeholder || ""}`.toLowerCase();
    return /user|email|account|login|phone|mobile|acct|账号|邮箱|手机/.test(hints);
  };

  const isPasswordField = (el) =>
    el instanceof HTMLInputElement && el.type === "password" && !el.disabled && !el.readOnly;

  /** 长得像按钮文案的值不是账号（QQ 的「登录」就是这么混进来的） */
  const looksLikeButtonLabel = (el) =>
    /^(登录|登陆|登\s*录|注册|确定|提交|下一步|sign\s?in|log\s?in|login|submit|next|continue)[!！]?\s*$/i.test(
      (el.value || "").trim()
    );

  /** React/Vue 的受控输入需要走原生 setter 再派发事件，否则框架不认 */
  const setValue = (input, value) => {
    if (!input) return;
    const proto =
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    input.focus();
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  /* ---------------- 记录聚焦的输入框 ---------------- */

  const refreshMenu = () => {
    if (contextDead) return;
    const now = Date.now();
    if (now - lastMenuRefresh < 1500) return;
    lastMenuRefresh = now;
    safeSend({ type: "keylite:refresh-menu", origin: location.hostname });
  };

  document.addEventListener(
    "focusin",
    (e) => {
      if (contextDead) return;
      const el = e.target;
      if (isPasswordField(el)) {
        lastPasswordField = el;
        refreshMenu();
      } else if (el instanceof HTMLInputElement && visible(el) && isUsernameLike(el)) {
        lastUsernameField = el;
        refreshMenu();
      }
    },
    true
  );

  document.addEventListener("contextmenu", () => refreshMenu(), true);
  refreshMenu();

  // 右键时现找一次最稳
  const findPasswordFields = () =>
    [...document.querySelectorAll('input[type="password"]')].filter(visible);

  /**
   * 找账号输入框，规则从严：
   * 1. 优先记住的那个；
   * 2. 否则在密码框「之前」的同表单输入框里找（登录表单惯例：账号在上）；
   * 3. 类型必须是 text / email / tel；
   * 4. 值长得像按钮文案的一律不要。
   */
  const findUsernameField = () => {
    if (lastUsernameField && visible(lastUsernameField) && !looksLikeButtonLabel(lastUsernameField)) {
      return lastUsernameField;
    }
    const pw = lastPasswordField || findPasswordFields()[0];
    if (!pw) return null;

    const root = pw.closest("form") || document;
    const all = [...root.querySelectorAll("input")];
    const pwIndex = all.indexOf(pw);
    const before = all.filter(
      (i, k) =>
        i !== pw &&
        k < pwIndex &&
        ["text", "email", "tel", ""].includes(i.type) &&
        !i.disabled &&
        !i.readOnly &&
        visible(i)
    );
    const preferred = before.filter((i) => i.type === "email" || isUsernameLike(i));
    const pick = (preferred.length ? preferred : before).pop();
    if (pick && !looksLikeButtonLabel(pick)) return pick;
    return null;
  };

  /* ---------------- 填充 ---------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "keylite:fill") {
      const { username, password } = msg.payload || {};
      const pw =
        lastPasswordField && visible(lastPasswordField) ? lastPasswordField : findPasswordFields()[0];
      if (!pw) {
        sendResponse({ ok: false, reason: "页面上没有找到密码框" });
        return;
      }
      setValue(findUsernameField(), username || "");
      setValue(pw, password || "");
      lastPasswordField = pw;
      sendResponse({ ok: true });
    }

    if (msg?.type === "keylite:probe") {
      const pw = findPasswordFields()[0];
      sendResponse({ ok: true, hasPasswordField: !!pw });
    }
  });

  /* ---------------- 页面内反馈（不经过后台注入） ---------------- */

  const showToast = (text, action) => {
    document.getElementById("keylite-toast")?.remove();
    const el = document.createElement("div");
    el.id = "keylite-toast";
    el.style.cssText =
      "position:fixed;z-index:2147483647;right:20px;bottom:20px;display:flex;align-items:center;gap:10px;" +
      "max-width:380px;background:#0F172A;color:#fff;font:500 13px/1.5 -apple-system,'PingFang SC',sans-serif;" +
      "padding:10px 12px 10px 14px;border-radius:10px;box-shadow:0 12px 30px -10px rgba(15,23,42,.5);" +
      "opacity:0;transition:opacity .15s";
    const span = document.createElement("span");
    span.textContent = text;
    el.appendChild(span);
    if (action) {
      const btn = document.createElement("button");
      btn.textContent = action.label;
      btn.style.cssText =
        "border:none;background:rgba(255,255,255,.16);color:#fff;font:600 12px/1 -apple-system,'PingFang SC',sans-serif;" +
        "padding:6px 10px;border-radius:7px;cursor:pointer;flex:none";
      btn.onclick = () => {
        action.onClick();
        el.remove();
      };
      el.appendChild(btn);
    }
    document.body.appendChild(el);
    requestAnimationFrame(() => (el.style.opacity = "1"));
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 250);
    }, action ? 6000 : 2800);
  };

  /** 同站点同账号但密码不同 —— 唯一需要用户拍板的情况 */
  const showConflict = (info, password, origin) => {
    document.getElementById("keylite-conflict")?.remove();
    const box = document.createElement("div");
    box.id = "keylite-conflict";
    box.style.cssText =
      "position:fixed;z-index:2147483647;right:20px;bottom:20px;width:320px;background:#fff;border-radius:14px;" +
      "box-shadow:0 24px 60px -16px rgba(15,23,42,.4);font:500 13px/1.5 -apple-system,'PingFang SC',sans-serif;color:#0F172A;padding:14px";
    const title = document.createElement("div");
    title.textContent = "更新密码？";
    title.style.cssText = "font-weight:700;font-size:13.5px";
    const sub = document.createElement("div");
    sub.textContent = `${info.title} · ${info.username}`;
    sub.style.cssText = "color:#64748B;font-size:11px;margin-top:4px";
    const note = document.createElement("div");
    note.textContent = "库里已有一条，但密码不一样。可能是你刚改的，也可能是输错了。";
    note.style.cssText = "color:#64748B;font-size:11.5px;margin-top:10px;line-height:1.6";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;margin-top:12px";
    const mk = (label, primary, onclick) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        `flex:1;height:32px;border-radius:9px;font:600 12.5px -apple-system,'PingFang SC',sans-serif;cursor:pointer;` +
        (primary
          ? "background:#2563EB;color:#fff;border:none"
          : "background:#fff;color:#0F172A;border:1px solid #E2E8F0");
      b.onclick = onclick;
      return b;
    };
    row.appendChild(
      mk("更新密码", true, () => {
        safeSend({ type: "keylite:update-password", id: info.itemId, password, origin });
        box.remove();
        showToast("密码已更新");
      })
    );
    row.appendChild(mk("保持原样", false, () => box.remove()));
    box.append(title, sub, note, row);
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 20000);
  };

  const showSaveFeedback = (res, payload) => {
    if (!res) {
      showToast("密钥库没有响应，这次登录没有保存");
      return;
    }
    if (res.type === "save.done") {
      const a = res.payload?.action;
      if (a === "created") {
        showToast(`已自动保存：${res.payload.title}`, {
          label: "撤销",
          onClick: () =>
            safeSend({ type: "keylite:undo", id: res.payload.itemId }, (r) =>
              showToast(r?.type === "deleted" ? "已撤销，这条没有保存" : r?.message || "撤销失败")
            ),
        });
      } else if (a === "exists") {
        showToast("这条登录已在密钥库中");
      } else if (a === "updated") {
        showToast("密码已更新");
      }
      return;
    }
    if (res.type === "save.conflict") {
      showConflict(res.payload, payload.password, payload.origin);
      return;
    }
    if (res.code === "locked") {
      return showToast("密钥库已锁定，这次登录没有保存", {
        label: "去解锁",
        onClick: () => safeSend({ type: "keylite:focus-app" }),
      });
    }
    if (res.code === "empty_password") return showToast("没抓到密码，这次登录没有保存");
    if (res.type === "save.queued") return showToast("已推送到密钥库，请在桌面端确认");
    if (res.message) showToast(res.message);
  };

  /* ---------------- 保存检测 ---------------- */

  /**
   * 滚动快照。
   * 大量 SPA / OA 系统在登录成功后**立刻清空输入框**，等 700ms 后回查就什么都拿不到了。
   * 所以边输入边存一份最近的凭据，提交时即使字段已被清空也能用。
   */
  let lastTyped = null;
  document.addEventListener(
    "input",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement)) return;
      const pw = isPasswordField(el) ? el : lastPasswordField || findPasswordFields()[0];
      if (!pw || !pw.value) return;
      if (!isPasswordField(el) && el !== findUsernameField()) return;
      lastTyped = {
        url: location.href,
        origin: location.hostname,
        username: (findUsernameField()?.value || "").trim(),
        password: pw.value,
        at: Date.now(),
      };
    },
    true
  );

  const STAGE_KEY = "keylite:staged";

  const collectCandidate = () => {
    const pw = lastPasswordField || findPasswordFields()[0];
    if (pw && pw.value && pw.isConnected && visible(pw)) {
      return {
        url: location.href,
        origin: location.hostname,
        username: findUsernameField()?.value?.trim() || "",
        password: pw.value,
      };
    }
    // 输入框已被页面清空 / 摘掉：用 60 秒内的输入快照
    if (lastTyped && Date.now() - lastTyped.at < 60000) {
      return {
        url: lastTyped.url,
        origin: lastTyped.origin,
        username: lastTyped.username,
        password: lastTyped.password,
      };
    }
    return null;
  };

  /**
   * 提交瞬间把候选写进 sessionStorage。
   * 登录成功往往伴随整页跳转，content script 会被销毁，
   * sendMessage 有可能还没送到就断了——下一页面加载时再把它补发出去。
   * sessionStorage 在同源页面间是保留的，正好适合这个场景。
   */
  const stageCandidate = (payload) => {
    try {
      sessionStorage.setItem(STAGE_KEY, JSON.stringify({ ...payload, at: Date.now() }));
    } catch {
      /* 隐私模式下可能写不了，忽略 */
    }
  };

  const clearStaged = () => {
    try {
      sessionStorage.removeItem(STAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const flushStaged = () => {
    if (contextDead) return;
    let staged = null;
    try {
      const raw = sessionStorage.getItem(STAGE_KEY);
      if (raw) staged = JSON.parse(raw);
    } catch {
      return;
    }
    if (!staged) return;
    clearStaged();
    if (Date.now() - (staged.at || 0) > 30000) return; // 太久以前的不算
    const { at, ...payload } = staged;
    void at;
    if (!payload.password) return;
    safeSend({ type: "keylite:save-candidate", payload }, (res) => {
      void chrome.runtime.lastError;
      showSaveFeedback(res, payload);
    });
  };

  let lastSaveAt = 0;
  let lastSent = ""; // 防止 4 秒内同一候选重复提交
  const submitCandidate = (preset) => {
    if (contextDead) return;
    // 保存后的短冷却：成功登录后的页面常有其他带「登录」字样的点击，别连环触发
    if (Date.now() - lastSaveAt < 5000) return;
    const payload = preset || collectCandidate();
    if (!payload) return;
    const key = `${payload.origin}|${payload.username}|${payload.password}`;
    if (key === lastSent) return; // 防止重复弹
    lastSent = key;
    setTimeout(() => {
      lastSent = "";
    }, 4000);

    stageCandidate(payload);
    log("提交捕获", { origin: payload.origin, username: payload.username, pwLen: payload.password.length });
    safeSend({ type: "keylite:save-candidate", payload }, (res) => {
      void chrome.runtime.lastError;
      if (res?.type === "save.done" || res?.type === "save.conflict") clearStaged();
      showSaveFeedback(res, payload);
      if (res?.type === "save.done" && res.payload?.action !== "exists") lastSaveAt = Date.now();
    });
  };

  // 页面加载时：如果上一个页面留下过没送出的候选，补发一次
  flushStaged();

  document.addEventListener(
    "submit",
    (e) => {
      if (contextDead) return;
      log("submit 事件", e.target?.tagName);
      if (e.target?.querySelector?.('input[type="password"]')) submitCandidate();
    },
    true
  );

  // 没有<form>的 SPA 登录（QQ / 微信 / 支付宝这类）：登录按钮常常是 <a>
  document.addEventListener(
    "click",
    (e) => {
      if (contextDead) return;
      const btn = e.target.closest?.('button, a, input[type="submit"], [role="button"]');
      if (!btn) return;
      // input[type=submit] 的文字在 value 里，没有 textContent
      // 中文站点常把按钮写成「登 录」「登 陆」，先把空白去掉再匹配
      const rawLabel = (btn.textContent || btn.value || "").trim();
      if (!rawLabel || rawLabel.length > 20) return;
      if (btn.querySelector?.("input")) return; // 包着表单的大容器不算按钮
      const label = rawLabel.replace(/\s+/g, "");
      const text = `${label} ${btn.name || ""} ${btn.id || ""} ${btn.className || ""}`
        .toLowerCase()
        .replace(/\s+/g, "");
      // 「退出登录 / 注销 / log out」不是登录提交
      if (/退出|注销|logout|signout/.test(text)) return;
      if (!/登录|登陆|登入|signin|login|submit|continue|下一步|确定|提交|继续/.test(text)) return;
      if (!findPasswordFields().length) return;
      // 点击瞬间先抓一份快照——页面可能在这之后就清空输入框
      const snapshot = collectCandidate();
      setTimeout(() => submitCandidate(snapshot), 700);
    },
    true
  );

  // 密码框里敲回车提交
  document.addEventListener(
    "keydown",
    (e) => {
      if (contextDead) return;
      if (e.key !== "Enter") return;
      const el = e.target;
      if (isPasswordField(el) && el.value) setTimeout(() => submitCandidate(), 900);
    },
    true
  );

  // 兜底：登录成功后页面要跳转，离开前再试一次
  window.addEventListener("pagehide", () => {
    if (lastPasswordField?.value) submitCandidate();
  });

  /* ---------------- 输入框内联钥匙按钮 + 账号下拉 ---------------- */

  let shadow = null;
  let currentItems = [];
  let currentOrigin = "";
  let hideTimer = null;
  let anchored = null;   // 按钮当前锚定的输入框
  let currentWrap = null; // 按钮的外层容器（用于跟随定位）
  let rafPending = false;

  const uiRoot = () => {
    if (shadow && shadow.host?.isConnected) return shadow;
    let host = document.getElementById("keylite-inline");
    if (!host) {
      host = document.createElement("div");
      host.id = "keylite-inline";
      host.style.cssText = "all:initial";
      document.documentElement.appendChild(host);
    }
    shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    return shadow;
  };

  const hideInline = () => {
    clearTimeout(hideTimer);
    anchored = null;
    currentWrap = null;
    uiRoot().innerHTML = "";
  };

  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      // 焦点还在凭据输入框上（账号框 → 密码框来回切）就不收
      const active = document.activeElement;
      if (active && (isPasswordField(active) || active === anchored)) return;
      hideInline();
    }, 180);
  };

  /** 页面滚动/缩放时让按钮跟着输入框走，而不是直接消失 */
  const reposition = () => {
    if (!anchored || !currentWrap) return;
    if (!anchored.isConnected || !visible(anchored)) return hideInline();
    const r = anchored.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return hideInline();
    currentWrap.style.left = `${Math.round(r.right - 28)}px`;
    currentWrap.style.top = `${Math.round(r.top + r.height / 2 - 11)}px`;
    // 滚动时收起展开的下拉，但保留按钮
    uiRoot().querySelector(".kv-panel")?.remove();
  };

  /** 只在这两类字段上出现：密码框、或识别出的账号框 */
  const isCredField = (el) =>
    el instanceof HTMLInputElement && (isPasswordField(el) || el === findUsernameField());

  const KEY_ICON =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="10.5" r="3"/><path d="m7.8 8.2 5-5M10.6 3.4l2.2 2.2"/></svg>';

  const renderButton = (field) => {
    clearTimeout(hideTimer); // 取消待执行的收起（焦点切换时会先 focusout 再 focusin）
    anchored = field;
    const s = uiRoot();
    s.innerHTML = "";
    const r = field.getBoundingClientRect();
    const wrap = document.createElement("div");
    wrap.style.cssText = `position:fixed;left:${Math.round(r.right - 28)}px;top:${Math.round(
      r.top + r.height / 2 - 11
    )}px;`;
    const btn = document.createElement("button");
    btn.title = `密钥库 · ${currentItems.length} 个账号`;
    btn.style.cssText =
      "width:22px;height:22px;border:none;border-radius:6px;background:#EFF6FF;color:#2563EB;cursor:pointer;" +
      "display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 1px 3px rgba(15,23,42,.18);" +
      "font:inherit";
    btn.innerHTML = KEY_ICON;
    btn.onmousedown = (e) => e.preventDefault(); // 不让输入框失焦
    btn.onclick = (e) => {
      e.preventDefault();
      openPanel(field);
    };
    wrap.appendChild(btn);
    s.appendChild(wrap);
    currentWrap = wrap;
  };

  const openPanel = (field) => {
    const s = uiRoot();
    const existing = s.querySelector(".kv-panel");
    if (existing) {
      existing.remove();
      return;
    }

    const r = field.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 260), 340);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const top = Math.min(r.bottom + 6, window.innerHeight - 40);

    const panel = document.createElement("div");
    panel.className = "kv-panel";
    panel.style.cssText =
      `position:fixed;left:${left}px;top:${top}px;width:${width}px;background:#fff;border-radius:12px;` +
      "box-shadow:0 24px 60px -16px rgba(15,23,42,.4),0 2px 6px rgba(15,23,42,.1);overflow:hidden;" +
      "border:1px solid rgba(15,23,42,.06);font:500 13px/1.4 -apple-system,'PingFang SC',sans-serif;color:#0F172A";

    const head = document.createElement("div");
    head.textContent = `密钥库 · ${currentOrigin}`;
    head.style.cssText =
      "padding:9px 12px;border-bottom:1px solid #EEF2F7;font-size:10.5px;font-weight:600;letter-spacing:.04em;color:#94A3B8";
    panel.appendChild(head);

    currentItems.forEach((item) => {
      const row = document.createElement("button");
      row.style.cssText =
        "display:flex;align-items:center;gap:9px;width:100%;padding:9px 12px;border:none;background:none;" +
        "cursor:pointer;text-align:left;font:inherit;color:inherit";
      const av = document.createElement("span");
      av.textContent = (item.title || item.label || "?").slice(0, 2).toUpperCase();
      av.style.cssText =
        "width:24px;height:24px;border-radius:7px;background:#EFF6FF;color:#2563EB;display:flex;align-items:center;" +
        "justify-content:center;font-size:9.5px;font-weight:600;flex:none";
      const col = document.createElement("span");
      col.style.cssText = "min-width:0";
      const l1 = document.createElement("div");
      l1.textContent = item.label || item.title || "(未填用户名)";
      l1.style.cssText = "font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      const l2 = document.createElement("div");
      l2.textContent = item.title || "";
      l2.style.cssText = "font-size:10.5px;color:#94A3B8;margin-top:1px";
      col.append(l1, l2);
      row.append(av, col);
      row.onmouseenter = () => (row.style.background = "#EFF6FF");
      row.onmouseleave = () => (row.style.background = "none");
      row.onmousedown = (e) => e.preventDefault();
      row.onclick = (e) => {
        e.preventDefault();
        safeSend(
          { type: "keylite:inline-fill", id: item.id, origin: currentOrigin },
          () => {
            void chrome.runtime.lastError;
            hideInline();
          }
        );
      };
      panel.appendChild(row);
    });

    s.appendChild(panel);
  };

  const refreshInline = (field) => {
    if (contextDead) return;
    if (!isCredField(field)) return;
    clearTimeout(hideTimer);
    const origin = location.hostname;
    safeSend({ type: "keylite:query", origin }, (res) => {
      void chrome.runtime.lastError;
      currentItems = res?.items || [];
      currentOrigin = origin;
      if (!currentItems.length) return hideInline();
      if (!field.isConnected || !visible(field)) return hideInline();
      renderButton(field);
    });
  };

  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (isCredField(el)) refreshInline(el);
    },
    true
  );

  document.addEventListener(
    "focusout",
    (e) => {
      if (isCredField(e.target)) scheduleHide();
    },
    true
  );

  const onViewportChange = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      reposition();
    });
  };
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideInline();
  });

  /* ---------------- 自检入口 ----------------
     控制台（主世界）与 content script（隔离世界）互相看不见，
     但 DOM 事件两边都收得到 —— 所以诊断走事件而不是直接调函数。

     在页面控制台运行：
       localStorage.keyliteDebug = '1'                    // 开日志
       dispatchEvent(new CustomEvent("keylite:selftest")) // 自检
  */
  window.__keyliteVersion = "0.1.2";

  const selftestHandler = () => {
    if (contextDead) return;
    const info = {
      version: window.__keyliteVersion || "0.1.0+inline",
      origin: location.hostname,
      url: location.href,
      passwordFields: findPasswordFields().map((p) => ({ id: p.id, name: p.name, type: p.type })),
      usernameFieldId: findUsernameField()?.id ?? null,
      usernameValue: findUsernameField()?.value ?? null,
    };
    safeSend({ type: "keylite:query", origin: location.hostname }, (res) => {
      const err = chrome.runtime.lastError?.message;
      console.info(
        "[密钥库] 自检 →",
        {
          脚本已注入: true,
          ...info,
          后台可达: !err,
          后台错误: err || null,
          条目数: res?.items?.length ?? null,
          已锁定: res?.locked ?? null,
        }
      );
      if (!info.passwordFields.length) {
        console.info("[密钥库] 当前页面没有 type=password 的输入框 —— 登录框可能在 iframe 里或用了别的实现");
      }
    });
  };
  // 控制台里的 dispatchEvent(...) 是往 window 上派发，addEventListener 在 document 上收不到
  // —— 所以两个目标都注册，无论从哪里派发都能收到
  document.addEventListener("keylite:selftest", selftestHandler);
  window.addEventListener("keylite:selftest", selftestHandler);

  window.__keyliteDebug = () => ({
    version: window.__keyliteVersion,
    origin: location.hostname,
    passwordFields: findPasswordFields().map((p) => ({ id: p.id, name: p.name })),
    username: findUsernameField()?.value ?? null,
    usernameField: findUsernameField()
      ? { id: findUsernameField().id, name: findUsernameField().name, type: findUsernameField().type }
      : null,
    staged: (() => {
      try {
        return sessionStorage.getItem("keylite:staged");
      } catch {
        return null;
      }
    })(),
  });

  window.__keyliteSelfTest = () =>
    new Promise((resolve) => {
      const result = {
        version: window.__keyliteVersion,
        origin: location.hostname,
        injected: true,
      };
      safeSend({ type: "keylite:query", origin: location.hostname }, (res) => {
        const err = chrome.runtime.lastError?.message;
        result.backgroundReached = !err;
        result.backgroundError = err || null;
        result.items = res?.items?.length ?? null;
        result.locked = res?.locked ?? null;
        console.info("[密钥库] 自检结果", result);
        resolve(result);
      });
    });
})();
