# Comfy Canvas · 正式桌面工程

**Electron 41.0.3 + 内嵌 Node.js 24.14.0 + 现有 React/TypeScript 画布源码**。

本工程统一构建画布、封装网关生产依赖与本地资源，并生成 Windows x64 安装包。用户安装后**不需要源码仓库、全局 Node.js/npm 或另开画布 Web 服务**。ComfyUI、Python 和大模型由用户单独安装；桌面程序可连接已运行的本机 ComfyUI，或按用户明确选择的目录启动它。

> Electron 界面本身使用 Web 技术，但这里的画布是从源码构建并随程序交付的应用资源，不依赖远端网站部署。

## 开发与构建

需要 Node.js **22.12+**（推荐 24 LTS）、npm、Windows x64。首次准备共享前端依赖：

```powershell
# 仓库根目录
cd infinite-canvas/web
npm ci --legacy-peer-deps
cd ../../desktop
npm ci
npm run build
npm run dev
```

共享画布仍以 [源码目录](<../infinite-canvas/web/src/>) 为唯一来源，不复制两套业务代码。`build` 直接调用 Vite，输出到桌面独占构建目录，**不会覆盖仓库原有画布 dist**；静态资源、生产网关依赖、工作流、节点源码、许可声明均自动纳入。构建期间不运行第三方 npm 安装脚本。构建禁止画布目录存在 `.env*`，避免本机地址、开发插件或凭据进入发行资源。

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 从画布源码构建，安装锁定网关生产依赖，整理 runtime 和 SHA-256 清单 |
| `npm run dev` | 启动已构建资源；顶部提供开发工具 |
| `npm start` | 正常启动已构建资源 |
| `npm run verify:runtime` | 校验资源清单、路径白名单、版本及依赖闭包 |
| `npm run pack` | 构建并生成 Windows 解包应用目录 |
| `npm run dist:win` | 构建 Windows x64 NSIS 安装包 |
| `npm run test:packaged` | 将打包应用复制到含空格的临时目录，从非仓库 cwd 启动并测试 |

安装包输出到 `release`，文件名为 `ComfyCanvas-<桌面版本>-x64-setup.exe`；解包应用为 `release/win-unpacked/ComfyCanvas.exe`。不要单独复制 EXE，解包分发必须携带整个目录。

开发模式不提供自动热更新。修改共享画布后重新 `npm run build` 并刷新；修改主进程后重启；发布时使用 `dist:win` 从最新源码完整重建。

## 安装与首次使用

1. 运行 NSIS 安装器，选择当前用户安装目录。支持桌面快捷方式和 Windows 卸载入口。
2. 首次默认本机地址：画布 `23110`、网关 `23111`、ComfyUI `8188`。桌面专用端口避免与旧浏览器版的 `3000/8190` 混用。
3. 在「服务面板 → 桌面设置」填写 ComfyUI 地址；需要自动启动时，用原生目录选择器指定 ComfyUI 安装目录。
4. 保存设置后，等待正在进行的任务结束，再点击「重启应用」。未配置目录时只连接 ComfyUI，不扫描硬盘并擅自启动其他安装。
5. 即使 ComfyUI 尚未运行，内置画布和网关仍可打开；生成会如实显示后端不可用。

正式桌面模式只接受明确配置的本机 HTTP 根地址。网关不再自动扫描其他 ComfyUI 端口并切换实例。非桌面版网关占用桌面端口时拒绝接管，避免把安装版策略误套到旧网关；请在桌面设置调整端口，或由服务所有者停止旧服务。

## 程序资源与用户数据

```text
安装目录/
├─ ComfyCanvas.exe           # Electron 与内嵌 Node，无需外部 Node
└─ resources/
   ├─ app.asar              # 桌面主进程、preload、服务面板
   └─ runtime/              # 只读发布资源
      ├─ runtime-manifest.json
      ├─ DEPENDENCY-LICENSES.txt
      ├─ launcher/
      ├─ infinite-canvas/web/dist/
      └─ comfyui-gateway/
         ├─ src/ + node_modules/
         ├─ workflows/ + prompts/ + scripts/
         ├─ comfyui-bridge/
         └─ resources/      # 资源索引、节点源码、小型预览资产
```

用户数据由 Electron 的 `app.getPath('userData')` 管理，Windows 通常位于 `%APPDATA%` 下应用专属目录；具体路径在设置面板展示，提供「打开数据目录」按钮：

```text
用户数据/
├─ config.json             # 桌面连接设置，不包含源码目录路径
├─ logs/desktop.log
├─ workflows/              # 可修改的工作流副本
├─ workflow-baseline.json  # 默认文件升级判定
├─ gateway/
│  ├─ outputs/             # 生成文件，兼容 /files 下载
│  └─ …                    # 任务、资源缓存、目录配置等
└─ Partitions/…            # Electron 画布项目、媒体及本地存储
```

- 程序安装目录不写配置、工作流或生成结果。卸载默认保留用户数据；升级安装包继续使用同一用户目录。
- 更新内置工作流时，只自动替换未被用户修改的旧默认文件。修改过的文件及自建文件保留；冲突显示在设置面板和日志，**不宣称注册表已完成逐项智能合并**。
- 画布项目存储在 Electron 的固定分区，和系统浏览器隔离；已有浏览器项目通过 ZIP 导出/导入迁移。
- 存储也绑定画布 origin/端口。更换端口可能看到新的存储空间，并非原数据被删除；建议固定端口、迁移前导出。

## 生命周期和权限

- 每个业务页使用无 preload 的隔离 `WebContentsView`；切换画布、网关和 ComfyUI 不会重载当前画布。
- 仅服务面板主 frame 能调用受限桌面 IPC；业务页面没有 Node.js、文件系统或任意命令执行能力。
- 启用 sandbox、contextIsolation、webSecurity，关闭 nodeIntegration/webview；HTTP 保持 CORS。外链确认后交系统浏览器，本机白名单弹窗使用隔离窗口。
- 保留原生文件选择、Blob 下载与受限剪贴板能力。图像/视频生成和节点安装仍由现有后端负责。
- 桌面自己启动的 launcher、网关和 ComfyUI 才登记为自有进程；退出只清理这些进程。Windows 当前使用自有进程树停止，可能中断其工作，退出前会提示确认并检查已知任务状态。
- 桌面隔离旧浏览器的 open/heartbeat/close 会话流量，避免关闭窗口触发旧 watchdog。外部服务仍可被其原所有者关闭，桌面不保证它们永久运行。
- 设置 ComfyUI 目录后，原网关可能写入工作流桥接扩展；资源中心安装也会写用户选择的 ComfyUI 节点、模型和 Python 环境。这是明确管理操作范围，**不是安装目录之外绝不写盘的沙箱承诺**。

## 发布范围与限制

已包含：画布、网关生产依赖、工作流、提示词模板、必要脚本、内置节点源码及许可、TAEH3 预览 VAE 和节点所需小型 embedding。

不包含：ComfyUI/Python 主程序、数 GB 的生成模型、LoRA/H3 ONNX 大文件。资源中心按需下载，因此不宣称离线全功能。

**禁用源码修复助手与旧补丁更新。** 安装版不再允许网页更新器修改源码/安装目录，助手插件不注册；升级通过新桌面安装包完成。自动更新服务器尚未配置。

**代码签名是发布前独立步骤。** 未提供签名证书时产物为未签名安装包，Windows SmartScreen 可能提示未知发布者。可以在受保护的发布环境提供 `CSC_LINK` / `WIN_CSC_LINK` 及密码给 electron-builder；不要把证书或密码提交到仓库。本工程不绕过 SmartScreen，不伪造签名。

## 测试与发布检查

```powershell
npm run check
npm test
npm run test:smoke
npm run test:integration
npm run pack
npm run test:packaged
npm run dist:win
```

- `test:integration`：真实 Electron + 现有画布 + 真实网关，ComfyUI 使用测试接口；验证复用与自有启动、视图保留、下载、POST 转发及重定向边界。
- `test:packaged`：复制打包应用到临时路径、清空 PATH 中的 Node/npm，从非仓库目录启动；验证读取随包资源、用户目录写入、原安装资源哈希不变、服务退出及外部 ComfyUI 保留。测试产生的画布和配置在临时目录，结果截图保留在被 Git 忽略的测试产物目录。
- `test:live`：只连接已运行的旧开发环境，不启动真实后端，是兼容性检查而非安装版发布验收。
- 共享画布类型检查：在其目录执行 `node node_modules/typescript/bin/tsc --noEmit --incremental false`。
- 后端发行策略与启动器回归：仓库根目录执行 `node --test comfyui-gateway/test/desktop-distribution.test.js launcher/test/desktop-mode.test.js`。

测试不提交真实 GPU 生成任务。真实模型生成、所有插件/剪贴板组合、签名证书和跨机器安装升级仍应在正式公开发行前验收。只有 Windows x64 为本轮打包目标，未验证 macOS/Linux 安装产物。

## 代码入口

- [桌面应用入口](<src/main/index.cjs>)、[用户配置与数据迁移](<src/main/application.cjs>)、[服务生命周期](<src/main/services.cjs>)
- [构建脚本](<scripts/build-runtime.cjs>)、[资源校验](<scripts/verify-runtime.cjs>)、[安装包配置](<electron-builder.cjs>)
- [打包后验证](<scripts/test-packaged.cjs>)、[运行时测试](<test/application.test.cjs>)
- [共享画布源码](<../infinite-canvas/web/src/>)、[网关源码](<../comfyui-gateway/src/>)、[桌面启动器](<../launcher/start.mjs>)
