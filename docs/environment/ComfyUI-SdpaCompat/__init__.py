"""
SDPA 兼容补丁（RTX 5060 Ti / sm_120 / Blackwell）。

问题现象
--------
某个 H3 / LLM 注意力调用报：

    cuDNN SDPA execution failed with error code ["CUDNN_BACKEND_API_FAILED"]:
    execute(handle, plan->get_raw_desc(), variant_pack_descriptor.get_ptr())
    failed with message: cuKernelSetAttribute returned error invalid argument (1)
    ... CUDNN_STATUS_EXECUTION_FAILED_CUDA_DRIVER

根因（重要，别只关全局开关）
--------------------------
`comfy/ops.py` 自己用显式后端列表跑 SDPA：

    SDPA_BACKEND_PRIORITY = [FLASH_ATTENTION, CUDNN_ATTENTION,
                             EFFICIENT_ATTENTION, MATH]
    with sdpa_kernel(SDPA_BACKEND_PRIORITY, set_priority=True): ...

`sdpa_kernel([...])` 是**显式后端约束**，会覆盖 `torch.backends.cuda.enable_cudnn_sdp(False)`
设的全局开关（实测：进入该 with 块后 `cudnn_sdp_enabled()` 又变回 True）。
所以只调 `enable_cudnn_sdp(False)` 对 ComfyUI 主注意力路径无效。

`set_priority=True` 的语义又是"按优先级依次尝试，但**最终按首选后端
聚合**"，一旦首选 cuDNN 内核在某个形状上抛错就直接失败，不会干净地
落到下一个后端。flash 在 sm_120 上没有 kernel，因此这里的首选实际
就是 cuDNN —— 这就是报错来源。

处理
----
1. 把 `comfy.ops.SDPA_BACKEND_PRIORITY` 改写成
   `[EFFICIENT_ATTENTION, MATH]`，从源头去掉 cuDNN 与 flash。
   （`comfy.ops.scaled_dot_product_attention` 的闭包读的就是这个模块全局，
   改写实时生效，已用 spy 确认进入上下文后 cudnn=False / flash=False。）
2. 同时把全局开关也关掉，避免别的分支（例如
   `torch.nn.functional.scaled_dot_product_attention` 的默认链路、
   `comfy/model_management.py` 的 flash 探测）再走 cuDNN。
3. 保留 memory-efficient 与 math 两条可用后端；math 作为最终兜底，
   保证任何形状都能算出来（只是慢）。

兼容性与可回退
--------------
* 不注册任何节点。
* 若目标属性不存在（ComfyUI 改版），只记录 WARNING，绝不阻断启动。
* 想恢复原行为：删掉本目录，或在 `ComfyUI/user/comfyui.env` 里去掉
  相关开关后重启。
* 若某天换了非 Blackwell 卡、想用回 cuDNN/Flash：把下面
  `FORCE_SAFE_BACKENDS` 改成 False 即可。

诊断
----
启动日志里搜 `[SdpaCompat]`：

    [SdpaCompat] comfy.ops priority -> [EFFICIENT_ATTENTION, MATH]
    [SdpaCompat] global cudnn_sdp=False flash_sdp=False mem_efficient=True math=True

环境变量（可选）
----------------
* `SDPA_COMPAT_DISABLE=1` —— 完全跳过本补丁（等价于删目录，方便临时排查）。
* `SDPA_COMPAT_ONLY_GLOBAL=1` —— 只关全局开关，不改 `comfy.ops` 优先级。
"""

import logging
import os

logger = logging.getLogger("SdpaCompat")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# 是否强制去掉 cuDNN / Flash 后端。非 Blackwell 卡可设为 False。
FORCE_SAFE_BACKENDS = True


def _log(message, *args):
    logger.info("[SdpaCompat] " + message, *args)


def _apply_global_switch(torch) -> None:
    """关掉全局 cuDNN / Flash SDPA，打开 memory-efficient / math。"""
    cuda_backend = getattr(torch.backends, "cuda", None)
    if cuda_backend is None:
        return

    for name, value in (
        ("enable_cudnn_sdp", False),
        ("enable_flash_sdp", False),
        ("enable_mem_efficient_sdp", True),
        ("enable_math_sdp", True),
    ):
        setter = getattr(cuda_backend, name, None)
        if setter is not None:
            setter(value)

    def state(name):
        try:
            return getattr(cuda_backend, name)()
        except Exception:
            return "unknown"

    _log(
        "global cudnn_sdp=%s flash_sdp=%s mem_efficient=%s math=%s",
        state("cudnn_sdp_enabled"),
        state("flash_sdp_enabled"),
        state("mem_efficient_sdp_enabled"),
        state("math_sdp_enabled"),
    )


def _patch_comfy_ops() -> None:
    """把 comfy.ops 的显式后端优先级列表里的 cuDNN / Flash 去掉。

    这是本补丁真正起作用的地方：sdpa_kernel([...]) 会覆盖全局开关，
    所以必须改这个列表本身。
    """
    try:
        import comfy.ops as comfy_ops
    except Exception as error:
        logger.warning("[SdpaCompat] 无法导入 comfy.ops，跳过优先级改写：%s", error)
        return

    priority = getattr(comfy_ops, "SDPA_BACKEND_PRIORITY", None)
    if priority is None:
        logger.warning(
            "[SdpaCompat] comfy.ops.SDPA_BACKEND_PRIORITY 不存在（ComfyUI 可能已改版），"
            "仅保留全局开关；若仍报 cuDNN 错误请检查 comfy/ops.py。"
        )
        return

    try:
        from torch.nn.attention import SDPBackend
    except Exception as error:
        logger.warning("[SdpaCompat] 无法导入 SDPBackend，跳过优先级改写：%s", error)
        return

    dropped = {SDPBackend.CUDNN_ATTENTION, SDPBackend.FLASH_ATTENTION}
    kept = [backend for backend in priority if backend not in dropped]
    # math 必须在列，否则没有任何兜底后端。
    if SDPBackend.MATH not in kept:
        kept.append(SDPBackend.MATH)
    if not kept:
        logger.warning("[SdpaCompat] 改写后优先级为空，保持原值。")
        return

    comfy_ops.SDPA_BACKEND_PRIORITY = kept
    _log("comfy.ops priority -> %s", [backend.name for backend in kept])


def _apply() -> None:
    if os.environ.get("SDPA_COMPAT_DISABLE", "").strip() not in ("", "0"):
        logger.info("[SdpaCompat] SDPA_COMPAT_DISABLE 已设置，跳过补丁。")
        return

    try:
        import torch
    except Exception as error:  # torch 都导入不了就不用管了
        logger.warning("[SdpaCompat] 无法导入 torch，跳过：%s", error)
        return

    _apply_global_switch(torch)

    if not FORCE_SAFE_BACKENDS:
        _log("FORCE_SAFE_BACKENDS=False，保留 comfy.ops 原始优先级。")
        return

    if os.environ.get("SDPA_COMPAT_ONLY_GLOBAL", "").strip() not in ("", "0"):
        _log("SDPA_COMPAT_ONLY_GLOBAL 已设置，不改 comfy.ops 优先级。")
        return

    _patch_comfy_ops()


try:  # 任何异常都不能拦住 ComfyUI 启动
    _apply()
except Exception as error:
    logging.getLogger("SdpaCompat").warning("[SdpaCompat] 补丁跳过：%s", error)
