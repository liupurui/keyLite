# 密钥库浏览器扩展

负责三件事：**识别登录框 → 右键一键填充 → 提交后提示保存**。
扩展本身不联网、不存储任何密码，所有加解密都在桌面端。

## 安装（开发模式）

```bash
# 1. 加载扩展
#    Chrome → chrome://extensions → 开发者模式 → 加载已解压的扩展程序
#    选择本目录（extension/），复制页面上的「扩展 ID」

# 2. 注册本机通道（把 <扩展ID> 换成上一步拿到的）
bash extension/install-host.sh <扩展ID>

# 3. 先启动桌面端并解锁，然后刷新任意登录页，
#    点进密码框 → 右键 → 密钥库 → 选择账号
```

首次使用前先跑桌面端：

```bash
cd app && npm install && npm run tauri dev
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单，权限只有 contextMenus / nativeMessaging / storage / scripting / activeTab |
| `content.js` | 识别密码框、执行填充（带 React/Vue 受控输入兼容）、提交时上报保存候选 |
| `background.js` | 右键菜单、与桌面端通信、页面内提示条 |
| `install-host.sh` | 注册 Native Messaging Host（白名单只放行你的扩展 ID） |

## 通信协议（与桌面端）

| 方向 | 报文 | 说明 |
|---|---|---|
| 扩展 → App | `{type:"fill.query", payload:{origin}}` | 右键菜单要条目列表（无密码） |
| App → 扩展 | `{type:"fill.list", payload:{items:[…]}}` | 同注册域条目 |
| 扩展 → App | `{type:"fill.exec", payload:{id, origin}}` | 取明文凭据 |
| App → 扩展 | `{type:"fill.credential", payload:{username, password}}` | 未解锁返回 `code:"locked"`，跨域返回 `origin_mismatch` |
| 扩展 → App | `{type:"save.candidate", payload:{url, origin, username, password}}` | 触发桌面端保存浮窗 |
| 扩展 → App | `{type:"generate", payload:{length}}` | 生成强密码 |

> 扩展内部的 `keylite:query` / `keylite:inline-fill` 是 content script 与后台之间的消息，不跨进程。

## Safari

M3 再做：Safari 走 Safari Web Extension + `SafariWebExtensionHandler`，
扩展代码可以复用，通信层换成 XPC。
