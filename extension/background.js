/**
 * 密钥库 · 扩展后台（service worker）
 *
 * 三条路都能填充，谁先到谁生效：
 *   1. 右键子菜单（聚焦密码框后按站点生成）
 *   2. 点「密钥库」根节点 —— 有 1 个账号直接填，多个弹页面内选择器
 *   3. ⌘⇧Space 快速搜索里按 Tab
 *
 * 与桌面端的通信走 Native Messaging（dev.keylite.host）。
 */

const HOST_NAME = "dev.keylite.host";
const ROOT_MENU = "keylite-root";

/* ---------------- Native Messaging ---------------- */

async function askApp(type, payload) {
  try {
    const res = await chrome.runtime.sendNativeMessage(HOST_NAME, { type, payload });
    return res || { type: "error", code: "empty", message: "桌面端没有返回内容" };
  } catch (e) {
    return { type: "error", code: "native_error", message: `连不上密钥库：${e?.message || e}` };
  }
}

/* ---------------- 右键菜单 ---------------- */

// 所有菜单操作排队执行。removeAll 和 create 交叉进行会产生
// "Cannot create item with duplicate id" 竞态，这里串行化根治
let menuChain = Promise.resolve();
const menuTask = (fn) => {
  menuChain = menuChain.then(fn).catch((e) => console.warn("[密钥库] 菜单更新失败", e));
  return menuChain;
};

// 每个 create 都带回调并消费 lastError，避免 "Unchecked runtime.lastError" 告警
const createItem = (props) =>
  chrome.contextMenus.create(props, () => void chrome.runtime.lastError);

async function doRebuild(items) {
  await chrome.contextMenus.removeAll();

  createItem({
    id: ROOT_MENU,
    title: items.length ? `密钥库（${items.length}）` : "密钥库",
    contexts: ["editable"],
  });

  items.forEach((item) => {
    // 名称优先，账号作补充；用户在桌面端写的名字才是主标识
    const name = item.title || item.label || "(未填用户名)";
    const suffix = item.label && item.label !== item.title ? `（${item.label}）` : "";
    createItem({
      id: `fill:${item.id}`,
      parentId: ROOT_MENU,
      title: name + suffix,
      contexts: ["editable"],
    });
  });

  createItem({ id: "sep", parentId: ROOT_MENU, type: "separator", contexts: ["editable"] });
  createItem({ id: "gen", parentId: ROOT_MENU, title: "生成新密码并填入", contexts: ["editable"] });
}

function rebuildMenus(items) {
  menuTask(() => doRebuild(items));
}

function ensureBaseMenu() {
  menuTask(async () => {
    await chrome.contextMenus.removeAll();
    createItem({ id: ROOT_MENU, title: "密钥库", contexts: ["editable"] });
  });
}

chrome.runtime.onInstalled.addListener(ensureBaseMenu);
chrome.runtime.onStartup.addListener(ensureBaseMenu);

// 切换标签页 / 页面跳转时把菜单重置成干净状态，
// 避免上一个站点的条目残留在子菜单里（点下去会被防钓鱼拦掉，很困惑）
const resetMenu = () => ensureBaseMenu();
chrome.tabs.onActivated.addListener(resetMenu);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "loading") resetMenu();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === "gen") {
    const res = await askApp("generate", { length: 24 });
    const pw = res?.type === "generated" ? res.payload.password : null;
    if (pw) {
      const r = await sendToTab(tab.id, { type: "keylite:fill", payload: { username: "", password: pw } });
      notify(r?.ok ? "已生成并填入" : r?.reason || "填充失败", tab.id);
    } else {
      notify(res?.message || "生成失败", tab.id);
    }
    return;
  }

  if (info.menuItemId.startsWith("fill:")) {
    const id = info.menuItemId.slice(5);
    // 用「当前页面真实域名」校验，而不是刷新菜单时记下的旧域名：
    // 菜单是全局的，切标签页后会残留上一个站点的条目。
    const origin = (await pageOrigin(tab.id)) || tabUrlOrigin(tab.url) || menuOrigin || "";
    const res = await fillWith(tab.id, id, origin);
    // 被拒的话，顺手把菜单刷成当前站点的条目，下次右键就对了
    if (res?.code === "origin_mismatch") {
      const q = await askApp("fill.query", { origin });
      if (q?.type === "fill.list") rebuildMenus(q.payload.items);
    }
    return;
  }

  if (info.menuItemId === ROOT_MENU) {
    // 根节点被点：按当前站点现场查询，能填就填。
    // 域名要取「密码框所在的那个 frame」——登录框经常是 iframe（如 ptlogin2.qq.com），
    // 顶层页面的域名和表单不是一回事，取错了会误伤。
    const origin = (await pageOrigin(tab.id)) || tabUrlOrigin(tab.url) || menuOrigin || "";
    const res = await askApp("fill.query", { origin });

    if (res?.code === "locked") return notify("先在密钥库里解锁，再点我", tab.id);
    if (res?.type !== "fill.list") return notify(res?.message || "查询失败", tab.id);

    const items = res.payload.items;
    rebuildMenus(items); // 下次右键子菜单就有了

    if (items.length === 0) return notify(`这个网站还没有保存的条目（${origin || "未知站点"}）`, tab.id);
    if (items.length === 1) return fillWith(tab.id, items[0].id, origin);
    return openPicker(tab.id, items, origin);
  }
});

/* ---------------- 页面内选择器（多个账号时） ---------------- */

async function openPicker(tabId, items, origin) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [items, origin],
      func: (entries, site) => {
        document.getElementById("keylite-picker")?.remove();
        const box = document.createElement("div");
        box.id = "keylite-picker";
        box.style.cssText =
          "position:fixed;z-index:2147483647;right:16px;top:16px;width:300px;background:#fff;border-radius:14px;" +
          "box-shadow:0 24px 60px -16px rgba(15,23,42,.4),0 2px 6px rgba(15,23,42,.1);color:#0F172A;overflow:hidden;" +
          "font:500 13px/1.4 -apple-system,'PingFang SC',sans-serif";
        const head = document.createElement("div");
        head.textContent = `密钥库 · ${site}`;
        head.style.cssText = "padding:12px 14px;border-bottom:1px solid #EEF2F7;font-weight:700;font-size:12.5px";
        box.appendChild(head);
        entries.forEach((it) => {
          const row = document.createElement("button");
          row.textContent = it.label || it.title || "(未填用户名)";
          row.style.cssText =
            "display:block;width:100%;text-align:left;padding:11px 14px;border:none;background:none;font:inherit;cursor:pointer";
          row.onmouseenter = () => (row.style.background = "#EFF6FF");
          row.onmouseleave = () => (row.style.background = "none");
          row.onclick = () => {
            chrome.runtime.sendMessage({ type: "keylite:pick", id: it.id, origin: site });
            box.remove();
          };
          box.appendChild(row);
        });
        const foot = document.createElement("button");
        foot.textContent = "取消";
        foot.style.cssText =
          "display:block;width:100%;padding:9px;border:none;border-top:1px solid #EEF2F7;background:#FBFCFE;color:#64748B;font:inherit;cursor:pointer";
        foot.onclick = () => box.remove();
        box.appendChild(foot);
        document.documentElement.appendChild(box);
        document.addEventListener(
          "click",
          (e) => {
            if (!box.contains(e.target)) box.remove();
          },
          { once: true }
        );
      },
    });
  } catch {
    notify("这个页面注入不了选择器", tabId);
  }
}

/* ---------------- 填充 ---------------- */

let menuOrigin = ""; // 最近一次刷新菜单时用的站点

async function fillWith(tabId, id, origin) {
  const res = await askApp("fill.exec", { id, origin });
  if (res?.type === "fill.credential") {
    const r = await sendToTab(tabId, { type: "keylite:fill", payload: res.payload });
    notify(r?.ok ? "已填入" : r?.reason || "填充失败", tabId);
  } else if (res?.code === "locked") {
    notify("先在密钥库里解锁，再试一次", tabId);
  } else if (res?.code === "origin_mismatch") {
    const d = res.payload || {};
    notify(
      `这条属于 ${d.itemOrigin || "其他站点"}，当前页面是 ${d.requestOrigin || "?"}。` +
        `同一个账号在不同网站要分别保存。`,
      tabId
    );
  } else {
    notify(res?.message || "桌面端返回错误", tabId);
  }
  return res;
}

/** 找出真正带着登录框的那个 frame 的域名 */
async function pageOrigin(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        origin: location.hostname,
        hasPw: !!document.querySelector('input[type="password"]'),
      }),
    });
    const frames = (res || []).map((r) => r.result).filter(Boolean);
    return (frames.find((f) => f.hasPw) || frames[0])?.origin || "";
  } catch {
    return "";
  }
}

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return { ok: false, reason: "页面还没注入密钥库，请刷新一次" };
  }
}

function tabUrlOrigin(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/* ---------------- 消息入口 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 选择器里点了某个账号
  if (msg?.type === "keylite:pick") {
    const tabId = sender.tab?.id;
    if (tabId) fillWith(tabId, msg.id, msg.origin);
    return;
  }

  // 把桌面端叫到前台，方便用户去解锁
  if (msg?.type === "keylite:focus-app") {
    askApp("app.show").then((res) => sendResponse(res));
    return true;
  }

  // 内联钥匙按钮：查当前站点有哪些账号（只返回摘要，不含密码）
  if (msg?.type === "keylite:query") {
    askApp("fill.query", { origin: msg.origin }).then((res) =>
      sendResponse({
        items: res?.type === "fill.list" ? res.payload.items : [],
        locked: res?.code === "locked",
      })
    );
    return true;
  }

  // 内联下拉里选定了某个账号
  if (msg?.type === "keylite:inline-fill") {
    const tabId = sender.tab?.id;
    if (tabId) fillWith(tabId, msg.id, msg.origin);
    sendResponse({ ok: true });
    return true;
  }

  // content script：聚焦密码框 / 右键 / 页面加载时，刷新当前站点的子菜单
  if (msg?.type === "keylite:refresh-menu") {
    const origin = msg.origin || "";
    menuOrigin = origin;
    askApp("fill.query", { origin }).then(async (res) => {
      const items = res?.type === "fill.list" ? res.payload.items : [];
      rebuildMenus(items);
      sendResponse({ ok: true, count: items.length, locked: res?.code === "locked" });
    });
    return true; // 异步应答
  }

  if (msg?.type === "keylite:save-candidate") {
    // 提示由 content script 直接画在页面里（见 content.js 的 showSaveFeedback），
    // 后台只负责转发，避免依赖 service worker 存活时机
    askApp("save.candidate", msg.payload).then((res) => sendResponse(res));
    return true;
  }

  // 页面提示条上的「撤销」
  if (msg?.type === "keylite:undo") {
    askApp("item.delete", { id: msg.id }).then((res) => sendResponse(res));
    return true;
  }

  // 冲突提示里的「更新密码」
  if (msg?.type === "keylite:update-password") {
    askApp("item.update_password", {
      id: msg.id,
      password: msg.password,
      origin: msg.origin,
    }).then((res) => sendResponse(res));
    return true;
  }
});

/* ---------------- 页面提示条 ---------------- */

async function pageToast(tabId, text, action) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [text, action || null],
      func: (t, act) => {
        document.getElementById("keylite-toast")?.remove();
        const el = document.createElement("div");
        el.id = "keylite-toast";
        el.style.cssText =
          "position:fixed;z-index:2147483647;right:20px;bottom:20px;display:flex;align-items:center;gap:10px;" +
          "max-width:380px;background:#0F172A;color:#fff;font:500 13px/1.5 -apple-system,'PingFang SC',sans-serif;" +
          "padding:10px 12px 10px 14px;border-radius:10px;box-shadow:0 12px 30px -10px rgba(15,23,42,.5);" +
          "opacity:0;transition:opacity .15s";
        const span = document.createElement("span");
        span.textContent = t;
        el.appendChild(span);
        if (act) {
          const btn = document.createElement("button");
          btn.textContent = act.label;
          btn.style.cssText =
            "border:none;background:rgba(255,255,255,.16);color:#fff;font:600 12px/1 -apple-system,'PingFang SC',sans-serif;" +
            "padding:6px 10px;border-radius:7px;cursor:pointer;flex:none";
          btn.onclick = () => {
            chrome.runtime.sendMessage(act.message);
            el.remove();
          };
          el.appendChild(btn);
        }
        document.body.appendChild(el);
        requestAnimationFrame(() => (el.style.opacity = "1"));
        setTimeout(() => {
          el.style.opacity = "0";
          setTimeout(() => el.remove(), 250);
        }, act ? 6000 : 2800);
      },
    });
  } catch {
    /* chrome:// 等页面注入不了，忽略 */
  }
}

async function notify(text, tabId) {
  await pageToast(tabId, text);
}
