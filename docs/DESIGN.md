# Keylite · 轻钥 — 设计方案 v0.1

> 一个为 macOS 而生、零云端、零拖沓的本地密码库。双击 → 解锁 → 右键 → 填好。全程不到两秒。

---

## 1. 一句话定位

**Keylite = 一个常驻菜单栏的本地加密密码库 + 一个浏览器扩展。**
应用负责「存 · 加密 · 搜索 · 生成」，扩展负责「识别网页 · 提示保存 · 右键填充」。

- 工程名 / 品牌：**Keylite**（界面内产品名显示为「密钥库」，随时可替换成正式名）。
- **界面语言：全中文**。所有菜单、按钮、提示、系统菜单栏（文件 / 编辑 / 显示 / 窗口 / 帮助）均为中文，不保留任何英文残留。
- 视觉风格：沿用已有原型稿的设计语言（Inter、Slate 灰阶、#2563EB 蓝、#F4F7FB 底、白色 14px 圆角面板），不另起一套视觉。

---

## 2. 目标用户与真实场景

| 场景 | 现在怎么做 | Keylite 怎么做 |
|---|---|---|
| 注册新站，想存下来 | 打开另一个密码 App → 新建 → 复制粘贴域名账号密码（4 步） | 提交表单后右下角浮窗出现「保存这条登录？」→ 点「保存」（1 步，0 次切窗） |
| 再次登录 | 打开 App → 搜索 → 找条目 → 复制账号 → 复制密码 → 切回网页粘贴（6 步） | 密码框上**右键 → 填充 → 选中账号**（2 步） |
| 临时要一个强密码 | 随便想一个弱密码 | 右键「生成新密码」直接填入并提示保存 |

设计目标很具体：**把「存密码」和「取密码」都压进浏览器里的两次点击之内**，应用本身永远不需要抢焦点。

---

## 3. 三个体验原则

1. **不抢焦点**。保存提示是一个不激活 App 的浮动面板（非激活 NSWindow），用户手不用离开网页。
2. **看得见的信任**。每个界面都能看到「本地存储 / 加密方式 / 何时锁定」的说明，不用翻设置。安全感来自可见性，不来自宣传语。
3. **安静**。无徽标红点、无营销位、无引导气泡。空状态只给一句下一步。

---

## 4. 技术选型

### 4.1 桌面外壳：Tauri 2（结论）

| 方案 | 体积 | 内存 | 原生能力 | 跨平台 | 评价 |
|---|---|---|---|---|---|
| **Tauri 2（Rust + WKWebView）** | ~8 MB | ~60 MB | 强 | ✅ Win/Linux/iOS/Android | **推荐**。轻便是硬指标，Rust 侧正好放加密逻辑 |
| Electron | ~150 MB | ~200 MB | 强 | ✅ | 体积与「轻便简约」直接冲突，否 |
| SwiftUI 原生 | ~5 MB | ~40 MB | 最强 | ❌ 仅 Apple | 想只做 Mac 且要极致手感可选，但扩展/未来跨平台成本高 |

选 Tauri 的理由不只是体积：**加密与密钥永远留在 Rust 进程里**，WebView 只拿到已经解密、已经决定要展示的那一个字段，前端被 XSS 也拿不到整库。

### 4.2 关键澄清：为什么必须有浏览器扩展

> 「软件自动识别网页、右键一键登录」——桌面 App **无法**直接读取 Chrome/Safari 的网页 DOM。这是浏览器的安全沙箱，不是能力问题。

三条路只有一条能走：

| 方案 | 可行性 | 结论 |
|---|---|---|
| macOS Accessibility API（AXUIElement）读网页元素 | 需用户授予"辅助功能"权限，WebView 内元素暴露不稳定，表单结构千变万化 | ❌ 不可靠，用户会怕 |
| 让用户在本 App 内置浏览器里登录 | 只能覆盖"在 Keylite 里登录"，不是日常路径 | ❌ 场景错位 |
| **浏览器扩展 + Native Messaging** | Chrome MV3 / Safari Web Extension 均原生支持，右键菜单是扩展标准能力 | ✅ **唯一正解** |

所以最终形态是**一个产品、两个进程**：

```
┌──────────────────────────┐        ┌─────────────────────────────┐
│  Keylite.app (Tauri)     │        │  Keylite 扩展 (MV3)         │
│  ├ 菜单栏图标 / 主窗口    │◄──────►│  ├ content script: 识别表单  │
│  ├ Rust 加密内核          │ Native │  ├ background: 右键菜单      │
│  ├ SQLite (密文)          │ Messa- │  └ 保存提示 / 填充执行        │
│  └ Touch ID / Keychain   │ ging   │                             │
└──────────────────────────┘        └─────────────────────────────┘
             ▲                                     │
             └──────── 用户 ↘ 浏览器 ───────────────┘
```

Native Messaging 落地细节：
- Chrome 侧：扩展 manifest 声明 `"nativeMessaging"`；本 App 安装时写入
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.keylite.host.json`，
  内含 `"allowed_origins": ["chrome-extension://<扩展ID>/"]`（只认自己的扩展，其它扩展无法调起）。
- Safari 侧：Safari 用 `SafariWebExtensionHandler`，扩展与宿主 App 同进程组通信，比 Chrome 更简单，但需要 Xcode 工程 + 开发者签名。**v1 只做 Chromium 系（Chrome/Edge/Brave/Arc），Safari 放 M3。**

### 4.3 其它选型

| 层 | 选择 | 理由 |
|---|---|---|
| 前端 | React 19 + Vite + TypeScript，Tailwind | 快；UI 状态轻 |
| 存储 | SQLite（rusqlite）+ 字段级 AES-256-GCM | 标题/域名明文 → 搜索秒开；密钥字段单独加密 |
| KDF | Argon2id（m=64 MiB, t=3, p=4） | OWASP 2024 推荐档位，M 系列芯片约 150 ms |
| 系统集成 | `security-framework`（Keychain）+ `objc2`（NSPanel / LocalAuthentication） | Touch ID 与浮窗都要原生 |
| 全局快捷键 | `tauri-plugin-global-shortcut` | ⌘⇧Space 唤起搜索浮窗 |
| 内存安全 | `secrecy` + `zeroize` | 明文用完即擦 |

---

## 5. 数据与加密设计

### 5.1 密钥层级（为了能改主密码而不重加密全库）

```
主密码 ──Argon2id(salt)──► KEK ──AES-GCM 解包──► DEK (32B 数据密钥)
                                                 │
                       每条记录 ──AES-256-GCM(DEK, 随机 nonce)──► ciphertext
Touch ID 通路：DEK 的另一份封装副本存 Keychain，访问控制 = 生物识别，30s 后失效
```

改主密码 = 用新 KEK 重新封装同一个 DEK（毫秒级），而不是解密重写全部数据。
Touch ID 解锁 = 从 Keychain 取封装副本，无需输入主密码。

### 5.2 表结构

```sql
-- vault.db
meta(key TEXT PK, value BLOB)          -- kdf_salt, wrapped_dek, kdf_params, schema_version
items(
  id TEXT PK, title TEXT, url TEXT,     -- url 为 eTLD+1 归一化，明文便于搜索
  username TEXT,                        -- 明文（用户常凭它搜索）
  password_enc BLOB, totp_enc BLOB,     -- 密文
  notes_enc BLOB,                       -- 密文
  tags TEXT, favorite INT, created_at, updated_at, last_used_at,
  pw_strength INT, pw_reused INT
);
-- 无外键、无网络层；单文件，路径 ~/Library/Application Support/Keylite/vault.db
```

### 5.3 安全清单（v1 必做）

- [x] 主密码永不落盘，仅存 Argon2 参数与 salt
- [x] 每次加密使用独立 12 字节随机 nonce；AAD 绑定 `item_id`
- [x] 空闲 5 分钟自动锁定（可配 1/5/15/永不）；合盖、锁屏、切换用户立即锁定
- [x] 密码复制到剪贴板后 30 s 自动清空（校验 `changeCount` 未被覆盖）
- [x] 全局禁用 DevTools 与远程调试端口；前端 CSP 禁止远程脚本
- [x] 扩展只保留 `contextMenus / activeTab / storage / scripting / nativeMessaging`，**不申请全站网络权限**
- [x] 域名匹配用 public-suffix 列表做 eTLD+1（`a.bank.com` ≠ `bank.com.evil.com`），跨域一律不给
- [x] 每条目显示「上次使用」与「已使用 N 次」，异常可用时可察觉
- [x] 导出 = 加密 JSON（同格式可回滚），不提供明文 CSV 导出（明示代价）

---

## 6. 关键交互协议（Native Messaging）

扩展 → App（保存）：

```json
{ "id": 1, "type": "save.candidate",
  "payload": { "url": "https://github.com/login", "origin": "github.com",
               "username": "demo@example.com", "password": "…", "fromSubmit": true } }
```

App 弹出浮窗；用户点「保存」后 App 回写：

```json
{ "id": 1, "type": "save.result", "payload": { "action": "saved", "itemId": "it_8f21" } }
```

扩展 → App（右键菜单条目列表）：

```json
{ "type": "fill.query", "payload": { "origin": "github.com" } }
→ { "type": "fill.list", "payload": { "items": [
      { "id": "it_8f21", "label": "demo@example.com", "lastUsed": "2026-10-25T09:12:00Z" } ] } }
```

点右键菜单项 → `fill.exec { itemId, origin }` → App 校验 origin 一致后返回明文 → content script 填充。
**注意**：App 未解锁时返回 `locked`，扩展界面提示「先在 Keylite 解锁」，绝不缓存明文。

---

## 7. 页面清单

| # | 页面 | 尺寸 | 任务 | 设计要点 |
|---|---|---|---|---|
| 01 | 解锁 | 520×580 | 打开应用第一屏 | 主密码 + 触控 ID 双入口；底部写明自动锁定规则 |
| 02 | 密码库主界面 | 1060×700 | 浏览与查看 | 200 侧栏 / 320 列表 / 自适应详情；选中态 = 浅蓝底 + 左侧 3px 蓝条 |
| 03 | 新增条目 | 620×600（弹窗 440×552） | 录入 | 字段按「先认出是谁、再登进去」排序；密码框右侧直给生成入口 |
| 04 | 快速搜索 | 560×302 | 键盘流主力 | ⌘⇧Space 唤起；↵ 复制、Tab 填入当前网页、⌘↵ 打开并登录 |
| 05 | 浏览器右键菜单 | 1160×640 | 取密码核心路径 | 「密钥库」子菜单按域名过滤、按最近使用排序 |
| 06 | 保存提示 | 840×520（浮窗 344） | 存密码核心路径 | 右下角浮出，不抢输入焦点；已存过同类账号时标题变「更新密码？」 |
| 07 | 设置 | 670×640 | 安全与偏好 | 严格沿用原型稿几何：614×430 面板、62px 行高、38×22 开关 |

设计语言（与原型稿一致）：`docs/mockups.html`（可直接双击打开，含全部 7 屏 1:1 原型）。

### 视觉规范

```
画布    #F4F7FB     bg
面板    #FFFFFF     圆角 14px，无描边（靠底色区分层级）
主文字  #0F172A     标题 13px/700、大标题 22px/700
次文字  #64748B     说明 11px/400
分隔线  #E2E8F0     行内分隔 #EEF2F7
强调色  #2563EB     主按钮、选中、链接、开关
选中底  #EFF6FF
危险    #BE123C / #FFF1F2
成功    #059669

字体：Inter → 中文回落 PingFang SC；密码 / 验证码用 SF Mono，字距 1.5px
控件：输入框 h40 r10；按钮 h38 r10；开关 38×22（钮 16）；行高 62（设置）/ 56（列表）
图标：线性 1.7px 描边，16px 网格，currentColor
动效：仅两处 —— 浮窗 120ms 上滑淡入、复制成功 600ms 回弹
```

---

## 8. 里程碑

| 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
| **M0 设计** | 方案 + 7 屏高保真稿 | 确认视觉方向 | ✅ |
| **M1 内核** | Tauri 骨架、Argon2id/AES-GCM、SQLite、解锁、CRUD、生成器、TOTP、设置、快速搜索 | 能存能取，重启后数据完好 | ✅ 代码已就位 |
| **M2 浏览器打通** | 扩展代码已写完（extension/），待真机联调 Native Messaging、保存浮窗 | 在 GitHub 上完成一次「保存 → 关闭 → 右键填充」闭环 | 🔨 扩展侧待联调 |
| **M3 手感** | 触控 ID、Safari 扩展、深色主题、菜单栏常驻、导出 UI | 全程不用鼠标也能登录 | ⏳ |
| **M4 扩展** | Windows/Linux（Tauri 同套代码）、iOS 自动填充 | — | ⏳ |
| **M5 可选** | E2E 加密同步（DEK 不上传）、共享 | — | ⏳ |

---

## 9. 已知取舍

1. **必须装扩展**，这不是偷懒，是浏览器沙箱的硬边界。安装引导要做得足够顺（一键跳转商店）。
2. **Safari 单独打包**，签名和开发证书成本更高，放 M3。
3. **不做明文 CSV 导出**，会挡住部分迁移用户，但换来"线上库永远是密文"的一致承诺。
4. **v1 不做云同步**：本地单库 + 手动加密备份，符合"轻便"定位，也把最危险的面收窄。
5. 复杂登录（iframe 内表单、跨域 SSO、Canvas 渲染的密码框）扩展可能识别不到，右键菜单仍可手动填充兜底。
