# Keylite · 密钥库

macOS 账号密码管理工具。**应用负责加密与存储，浏览器扩展负责识别网页、右键一键填充、提交后提示保存。**
一个产品，两个进程，零云端，界面全中文。

## 目录结构

```
Keylite/
├── Cargo.toml              # Rust 工作区
├── core/                   # 纯 Rust 内核：加密 / 存储 / 生成器 / TOTP（31 个单测）
│   └── src/{crypto,store,generator,totp,origin}.rs
├── app/                    # Tauri 2 + React 19 界面
│   ├── src/                # 解锁 / 密码库 / 新增条目 / 快速搜索 / 设置
│   └── src-tauri/          # 命令层 + 扩展 IPC 通道 + keylite-host 桥
├── extension/              # Chrome/Edge/Brave 扩展（MV3）
├── docs/
│   ├── DESIGN.md           # 设计方案（选型 / 加密 / 协议 / 里程碑）
│   ├── mockups.html        # 7 屏 1:1 设计稿（浏览器直接打开）
│   └── screens/            # 运行 scripts/shoot.sh 导出的 PNG
└── scripts/                # 工具脚本（图标生成、设计稿截图）
```

## 快速开始

### 1. 只想看看界面（浏览器，不用编译 Rust）

```bash
cd app && npm install && npm run dev
# 打开 http://localhost:1420
# 创建密码库 / 解锁时，mock 模式的主密码是：keylite
```

没有跑在 Tauri 里时自动使用内存 mock，界面完整可点，数据不落盘。

### 2. 跑真桌面应用

```bash
cd app
npm install
npm run tauri dev     # 首次编译 Rust 约 3-8 分钟
```

真机上数据落在 `~/Library/Application Support/dev.keylite.app/vault.db`，
标题/网址/用户名明文便于搜索，密码、验证码、备注全部 AES-256-GCM 密文。

### 3. 打包

```bash
cd app && npm run bundle      # 产出 .app 和 .dmg
```

## 浏览器扩展（右键一键填充）

```bash
# 1) Chrome → chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 extension/
#    复制「扩展 ID」
# 2) 注册本机通道
bash extension/install-host.sh <扩展ID>
# 3) 启动桌面端并解锁 → 打开任意登录页 → 点进密码框 → 右键 → 密钥库
```

详见 `extension/README.md`。

## 安全设计（v1 已实现）

- 主密码 → Argon2id（m=64MiB, t=3, p=4）→ KEK → 解包 DEK → 每条记录 AES-256-GCM，AAD 绑定条目 id
- 改主密码只重新封装 DEK，不需要重写全库；锁定即把内存中的 DEK 清零
- 域名匹配用注册域（eTLD+1），`github.com.evil.cn` 匹配不到 `github.com` 的条目
- 扩展取明文必须：已解锁 + 域名一致；未解锁只返回 `locked`
- 复制密码后按设置延迟清空剪贴板（只清自己复制的那次）
- 空闲自动锁定（默认关闭，可配 5/15/30/60 分钟；在浏览器里使用密钥库也算活动）
- 触控 ID 解锁：DEK 副本存登录钥匙串，读取前必须通过 `LAContext` 指纹验证
- 后台运行：关窗口只隐藏到菜单栏（进程继续跑，浏览器扩展照常工作）；
  菜单栏图标可开关，图标关掉时关窗口即退出，避免应用找不回来
- 单测覆盖：密文篡改检测、AAD 跨条目防搬运、落盘无明文、钓鱼域匹配

## 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 设计方案 + 7 屏设计稿 | ✅ |
| M1 | 加密内核、解锁、增删改查、生成器、TOTP、设置、快速搜索 | ✅ 本仓库 |
| M2 | 浏览器扩展（识别 / 自动保存 / 右键与内联按钮填充 / 防钓鱼）、触控 ID 解锁 | ✅ |
| M3 | Safari 扩展、深色主题、菜单栏常驻、导出备份 UI | ⏳ |
| M4 | Windows / Linux（Tauri 同套代码） | ⏳ |
| M5 | 多设备端到端加密同步 | ⏳ |

## 常用命令

```bash
cargo test -p keylite-core      # 内核单测
cd app && npm run build         # 前端类型检查 + 打包
node scripts/make-icons.mjs     # 重新生成应用图标
bash scripts/shoot.sh           # 导出设计稿 PNG
```
