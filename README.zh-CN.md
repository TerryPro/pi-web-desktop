# Pi Web Desktop

[English](./README.md) | 中文

[Pi Web](https://github.com/agegr/pi-web) 的桌面壳。Pi Web 是
[pi 编码代理](https://github.com/earendil-works/pi) 的本地 Web 界面。

这个仓库只有壳。网页应用本身是上游 `pi-web`，升级时直接换上游版本，不需要改它的源码：壳把那份工程构建出来的产物作为资源打包，然后从本机端口提供服务。

## 运行方式

1. Tauri 应用启动。
2. 找到打包进来的 Node 运行时和 `resources/` 下的 Pi Web 目录树。
3. 取一个空闲的回环端口，在目标目录里执行 `node start.js`。
4. 等服务器响应，然后把窗口导航到 `http://127.0.0.1:<端口>`。
5. 退出时杀掉整个服务进程树。壳自身被强杀、退出钩子没机会执行时，靠 Windows job object 由内核回收。

服务器只绑定 `127.0.0.1`，不对网络暴露。

## 和 pi-web 的关系

`pi-web` 由上游维护，这里只改一行。所有让它变成一个桌面应用的东西都在这个仓库里。

唯一一处本地改动，在 `pi-web/next.config.ts`：

```ts
output: process.env.PI_WEB_DESKTOP_BUILD ? "standalone" : undefined,
```

打包脚本在构建时设置 `PI_WEB_DESKTOP_BUILD=1`，`next build` 才产出 `.next/standalone`。在 pi-web 里直接 `npm run build` 仍然和上游行为一致。不要改成无条件启用：`bin/pi-web.js` 用 `next start` 起服务，Next 对 standalone 构建会提示这条路不能用。

`scripts/package.mjs` 在构建前检查这行还在。上游某次发布如果把这段配置重写了，检查会失败并打印期望的那一行，而不是产出一份壳服务不起来的目录树。

## 环境要求

| 项目 | 版本 | 原因 |
| --- | --- | --- |
| Windows | 10 或 11 | 安装包是 NSIS，进程回收用 Win32 job object |
| Node.js | 22.19.0 或更新 | pi-web 自己的下限，`packaging/start.js` 运行时会再检查一次 |
| Rust | 1.77.2 或更新 | `Cargo.toml` 里的 `rust-version` |
| Pi Web 工程 | 能通过检查的任意版本 | 默认放在 `../pi-web` |

macOS 和 Linux 没有验证过。Rust 侧两条路径都有兜底，但安装包目标和 job object 只有 Windows。

## 构建

### 1. 两个仓库放在同一层

```
某个目录/
├── pi-web/            git clone https://github.com/agegr/pi-web.git
└── pi-web-desktop/    本仓库
```

### 2. 准备 pi-web

```powershell
cd ..\pi-web
npm install
```

然后在 `next.config.ts` 里加上 standalone 开关：

```ts
output: process.env.PI_WEB_DESKTOP_BUILD ? "standalone" : undefined,
```

### 3. 打包

```powershell
cd ..\pi-web-desktop
powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
```

这一步会在 `../pi-web` 里带上开关跑 `next build`，然后把结果复制到 `resources/pi-web`。耗时几分钟，每次都整棵重写。

打包前先关掉正在运行的 Pi Web。脚本要替换整个目录，被占用时会明确报错退出。

### 4. 构建壳

```powershell
cargo build --release
```

或者直接出安装包：

```powershell
npx --yes @tauri-apps/cli@2 build
```

只跑 `cargo build --release` 得到的是 `target/release/pi-web-desktop.exe`，以及它旁边需要的 `resources/`。后者产出 NSIS 安装包。

## 脚本

`scripts/build-desktop.ps1` 是 `scripts/package.mjs` 的封装。参数看 PowerShell 这份，想从别的 shell 调用就直接用 `.mjs`。

| 参数 | 作用 |
| --- | --- |
| 不加 | 检查、构建、打包、瘦身 |
| `-SkipBuild`（`--skip-build`） | 复用现有 `.next`，不重新构建 |
| `-Check`（`--check`） | 只做检查，不构建不复制 |
| `-Fix`（`--fix`） | 把 pi-web 的版本号写进 `Cargo.toml` 和 `tauri.conf.json` |

第一步是升级检查，跑在任何构建动作之前：

| 检查 | 不通过时 |
| --- | --- |
| `next.config.ts` 仍用 `PI_WEB_DESKTOP_BUILD` 控制 `output` | 停止，打印期望的那一行 |
| pi-web 除 `next.config.ts` 外没有别的本地改动 | 只警告，列出多出来的文件 |
| `Cargo.toml`、`tauri.conf.json` 的版本等于 pi-web 版本 | 停止；加 `-Fix` 自动写入 |
| `@earendil-works/*` 是精确版本且已安装 | 停止，列出不一致的包 |

最后一步删掉运行时不读的东西：源码目录、构建缓存、文档、构建期配置和 `package-lock.json`。

## 运行时文件

| 路径 | 内容 |
| --- | --- |
| `%TEMP%\pi-web-desktop.log` | 启动日志。每次启动时检查，超过 1 MB 就清空重建 |
| `~/.pi/agent/` | 会话和配置，和 pi CLI、Pi Web 共用 |
| `resources/pi-web` | 打包生成的，不进版本库 |

## 测试

```powershell
node --test "scripts/*.test.mjs"
```

覆盖打包脚本里的纯逻辑：读写 `Cargo.toml`、`tauri.conf.json` 的版本号，解析 `git status --porcelain`。Node 24 下给 `node --test` 传目录会报错，用 glob。

这个仓库目前没有 CI。

## 目录结构

```
src/main.rs                窗口、sidecar 生命周期、就绪探测、日志
packaging/start.js         打包树里的桌面入口
scripts/package.mjs        打包流程
scripts/package-lib.mjs    其中的纯函数
scripts/build-desktop.ps1  参数封装
loading/index.html         服务器响应前窗口显示的内容
resources/                 打包脚本生成，不进 git
```

## 常见问题

**构建或安装后第一次启动要 30 到 60 秒。**

这是正常的。打包会写出上万个文件，其中 pi SDK 占约 2000 个，服务器启动时会一次性导入这个 SDK。Windows 上还要和实时文件扫描抢时间。之后的启动大约一秒。想消掉这段等待只能把安装目录排除出 Defender 的实时扫描，代码层面做不到。

**`ERROR: cannot clear ...\resources\pi-web (EPERM)`**

有 Pi Web 进程正跑在那棵目录上。关掉再执行。

**`EBUSY: resource busy or locked, rmdir '...\.next\standalone'`**

pi-web 工程里还有服务在跑，通常是测试留下的 `next start`。停掉再构建。

**`ERROR: .next\node_modules points at a checkout that no longer exists`**

pi-web 目录下的 `.next` 是在别的路径构建的，里面的 junction 悬空了。不带 `-SkipBuild` 重新跑一遍。

**`ERROR: version mismatch - rerun with --fix`**

pi-web 和壳的版本号不一致。`-Fix` 会把 pi-web 的版本写进 `Cargo.toml` 和 `tauri.conf.json`。

**窗口显示 "Pi Web could not be started" 并带一个退出码**

服务器在响应之前就退出了。错误信息里有退出码和日志路径，服务器自己的输出在 `%TEMP%\pi-web-desktop.log`。

## 还没做

以下是已知缺口，不是待报告的 bug：

- 没有自动更新。换版本等于换安装包。
- 没有单实例锁。开两个窗口会起两个服务，两个服务写同一个会话文件的情况没有测过。
- 没有托盘图标、开机自启、窗口位置记忆。
- 内置的 pi-web 仍会去 npm 检查 `@agegr/pi-web` 新版本并提示有更新。壳装不了那个更新，它对应的是一个新的安装包。
