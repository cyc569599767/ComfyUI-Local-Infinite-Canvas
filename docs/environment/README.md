# ComfyUI 环境补丁备份

本目录保存的是**仓库外**（`D:/software/ComfyUI_windows_portable`）的环境改动，
用于换机、重装 ComfyUI 后快速恢复。这些文件**不参与任何构建**，只是参考副本与还原依据。

> 用 `docs/environment/` 而不是塞进 `custom_nodes`：`docs/` 已被构建脚本排除
> （`build-runtime.cjs` / `verify-runtime.cjs` 都不引用），而 `custom_nodes` 下的
> Python 插件不能打进桌面端 runtime，反而可能触发 `verifyRuntime` 的 allowlist 报错。

---

## 背景：为什么要打这个补丁

环境：RTX 5060 Ti（sm_120 / Blackwell）、torch 2.14.1+cu130、cuDNN 9.24.00、
驱动 621.14、ComfyUI 0.45.5、Python 用 portable 目录内的 `python_embeded`。

H3 / LLM 注意力调用偶发报错：

```
cuDNN SDPA execution failed with error code ["CUDNN_BACKEND_API_FAILED"]:
execute(handle, plan->get_raw_desc(), variant_pack_descriptor.get_ptr())
failed with message: cuKernelSetAttribute returned error invalid argument (1)
... CUDNN_STATUS_EXECUTION_FAILED_CUDA_DRIVER
```

### 三层根因（按排查顺序）

1. **`TORCH_CUDNN_SDPA_ENABLED=0` 无效**
   本机 Windows 版 torch 上这个环境变量完全不起作用。实测在 `cmd` 里
   `set TORCH_CUDNN_SDPA_ENABLED=0` 后 `cudnn_sdp_enabled()` 仍返回 `True`。
   → 已从启动器移除，别再试这条路。

2. **全局 API 也不够（最关键的一层）**
   `comfy/ops.py` 自己跑显式后端列表：

   ```python
   SDPA_BACKEND_PRIORITY = [FLASH_ATTENTION, CUDNN_ATTENTION,
                            EFFICIENT_ATTENTION, MATH]
   with sdpa_kernel(SDPA_BACKEND_PRIORITY, set_priority=True): ...
   ```

   `sdpa_kernel([...])` 是**显式后端约束，会覆盖全局开关**。实测：

   ```
   global cudnn_sdp_enabled : False     ← 全局已关
   inside sdpa_kernel cudnn  : True     ← 进入 with 块又变回 True
   ```

   所以只调 `torch.backends.cuda.enable_cudnn_sdp(False)` 对 ComfyUI 主注意力路径无效，
   **必须改写 `comfy.ops.SDPA_BACKEND_PRIORITY` 本身**。

3. **sm_120 没有 Flash kernel**
   `set_priority=True` 语义是按优先级尝试但最终按首选后端聚合，一报错就直接失败。
   Flash 在 Blackwell 上不可用，首选实际落到 cuDNN —— 这就是报错来源。

---

## 补丁做了什么

`ComfyUI-SdpaCompat/__init__.py`，custom node 启动时执行：

1. 关全局 cuDNN / Flash SDPA，开 memory-efficient / math；
2. 把 `comfy.ops.SDPA_BACKEND_PRIORITY` 改写成 `[EFFICIENT_ATTENTION, MATH]`。

不注册任何节点（`NODE_CLASS_MAPPINGS = {}`），所有异常被吞掉，**永不阻塞 ComfyUI 启动**。

### 回退开关

| 方式 | 效果 |
|---|---|
| 删掉 `custom_nodes/ComfyUI-SdpaCompat/` | 完全恢复原行为 |
| `SDPA_COMPAT_DISABLE=1` | 跳过整个补丁（临时排查用） |
| `SDPA_COMPAT_ONLY_GLOBAL=1` | 只关全局开关，不改 `comfy.ops` 优先级 |
| 源码里 `FORCE_SAFE_BACKENDS = False` | 保留 `comfy.ops` 原始优先级（换非 Blackwell 卡时用） |

### 启动日志特征

```
[SdpaCompat] global cudnn_sdp=False flash_sdp=False mem_efficient=True math=True
[SdpaCompat] comfy.ops priority -> ['EFFICIENT_ATTENTION', 'MATH']
```

搜不到这两行说明补丁没加载，别以为它生效了。

---

## 安装步骤（换机 / 重装后）

```bash
# ComfyUI 根目录 = D:/software/ComfyUI_windows_portable
mkdir -p ComfyUI/custom_nodes/ComfyUI-SdpaCompat
cp docs/environment/ComfyUI-SdpaCompat/__init__.py \
   <ComfyUI根>/ComfyUI/custom_nodes/ComfyUI-SdpaCompat/__init__.py
# 然后按下面「启动器」一节改 .bat
```

校验副本与仓库一致：

```bash
sha256sum <ComfyUI根>/ComfyUI/custom_nodes/ComfyUI-SdpaCompat/__init__.py \
          docs/environment/ComfyUI-SdpaCompat/__init__.py
# 应为 29273219ffee55bf3265f1975a71fb0124cc3b0ed90cfe59dc033c9997c43298
```

---

## 启动器改动

两个 `.bat` 都改了。ComfyUI 侧原文件已备份为 `*.bak_20261121`，
`launchers/` 下同时保存了四份参考副本：

| 文件 | 说明 |
|---|---|
| `run_nvidia_gpu.bat.original` | 改动前原始版，可直接还原 |
| `run_nvidia_gpu.bat.current` | 当前生效版 |
| `run_nvidia_gpu_fast_fp16_accumulation.bat.original` | 同上，fast 版 |
| `run_nvidia_gpu_fast_fp16_accumulation.bat.current` | 同上，fast 版 |

> 扩展名用 `.original` / `.current` 而不是 `.bat`：避免被误当成真启动器执行，
> 也避免某些工具按 `*.bat` 做通配处理。还原时手动改回 `.bat`。

改动只有两处：去掉无效的环境变量、追加 `--reserve-vram 1.5`。

### `run_nvidia_gpu.bat`

原始：

```bat
.\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build
echo If you see this and ComfyUI did not start try updating your Nvidia Drivers to the latest. ...
pause
```

当前：

```bat
@echo off
REM 2026-11-21: RTX 5060 Ti (sm_120) 上 cuDNN/Flash SDPA 不可用。
REM 由 custom_nodes/ComfyUI-SdpaCompat 在启动时切换到 memory-efficient 后端；
REM --reserve-vram 1.5 用于降低显存碎片导致的执行失败概率。
.\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --reserve-vram 1.5
echo If you see this and ComfyUI did not start try updating your Nvidia Drivers to the latest. ...
pause
```

### `run_nvidia_gpu_fast_fp16_accumulation.bat`

同上，保留原有 `--fast fp16_accumulation`，只追加 `--reserve-vram 1.5`：

```bat
.\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --reserve-vram 1.5 --fast fp16_accumulation
```

### 改写 .bat 的注意事项

桌面端**不是**直接执行 `.bat`，而是用 `launcher/desktop-protocol.mjs` 的
`resolveDesktopComfyPlan()` 解析 bat 文本、提取 python 参数后自己 `spawn`。
解析器要求：

- 第一条非注释、非 `@echo off`、非 `REM` 的行必须是唯一命令；
- 其后只能有 `echo` / `pause` / `exit /b`；
- 命令里不能出现 `& | < > ^`，引号必须成对；
- 参数里不能有未展开的 `%VAR%`。

所以改 bat 时保持结构，别加分号串联命令。改完必须验证：

```bash
node --input-type=module -e "
import { resolveDesktopComfyPlan } from './launcher/desktop-protocol.mjs';
const install = {
  dir: 'D:/software/ComfyUI_windows_portable',
  pythonExe: 'D:/software/ComfyUI_windows_portable/python_embeded/python.exe',
  mainPy: 'D:/software/ComfyUI_windows_portable/ComfyUI/main.py',
  scripts: ['D:/software/ComfyUI_windows_portable/run_nvidia_gpu.bat'],
};
console.log(JSON.stringify(resolveDesktopComfyPlan(install,
  { kind: 'script', file: install.scripts[0], cwd: install.dir }), null, 2));
"
```

期望输出（当前版本）：

```json
{ "kind": "python", "pythonArgs": ["-s"],
  "args": ["--windows-standalone-build", "--reserve-vram", "1.5"] }
```

### 完整还原为原始状态

```bash
C=<ComfyUI根>
# 1. 还原启动器
cp docs/environment/launchers/run_nvidia_gpu.bat.original $C/run_nvidia_gpu.bat
cp docs/environment/launchers/run_nvidia_gpu_fast_fp16_accumulation.bat.original \
   $C/run_nvidia_gpu_fast_fp16_accumulation.bat
# 2. 移除补丁
rm -rf $C/ComfyUI/custom_nodes/ComfyUI-SdpaCompat
# 3. 重启 ComfyUI
```

还原后 `CUDNN_STATUS_EXECUTION_FAILED_CUDA_DRIVER` 会重新出现 ——
这是预期行为，说明补丁确实在起作用。

---

## 已归档的失效文件

`custom_nodes/.disabled/zz_h3_vae_sdpa_fix.py.obsolete_20261121`

2026-10-25 的老方案，靠 monkey-patch `comfy.ldm.minimax.vae.Attention.forward`
只在 VAE 解码处绕开 cuDNN。ComfyUI 改版后已失效，启动日志报：

```
[H3 VAE SDPA fix] active=False: comfy.ldm.minimax.vae.Attention.forward looks
different from the version this patch targets (ComfyUI updated?)
```

且每次启动 `IMPORT FAILED`（缺 `NODE_CLASS_MAPPINGS`）。功能已被 SdpaCompat 完全覆盖，
保留它只会污染日志。**不要恢复它**，两个补丁同时改 SDPA 行为会互相干扰。

---

## 验证记录

2026-11-21 实测通过：

| 项目 | 结果 |
|---|---|
| 进程内 spy 拦截 `comfy.ops` 调用 | 3/3 全部 `cudnn=False flash=False` |
| H3 VAE 形状 (1/2, 64heads, 3300/4125/8250 seq, 32dim) fp16 | 4/4 通过 |
| 与默认 SDPA 输出数值对比 | `max\|diff\| = 0.00e+00`（纯后端切换，零精度变化） |
| 真实启动 `--port 8199 --reserve-vram 1.5` | `/system_stats` 返回 200，全程无 cuDNN 报错 |

---

## 副作用与调优

- **速度**：memory-efficient 比 cuDNN 慢一些，但远快于 math 兜底，且是当前唯一稳定可用的路径。
- **显存**：`--reserve-vram 1.5` 会从 16.2GB 里预留 1.5GB 给系统。这**不是**修复的主因，
  只是降低碎片化概率的辅助手段。显存吃紧时可降到 `1.0` 或整个去掉，补丁依然有效。
- **判定是否真修好了**：重跑之前失败的任务，看是否还出现 `CUDNN_STATUS_EXECUTION_FAILED_CUDA_DRIVER`。