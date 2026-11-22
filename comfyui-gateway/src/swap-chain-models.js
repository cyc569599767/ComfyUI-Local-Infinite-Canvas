// 换人长链（swap-chain）的模型预检。
//
// 这条链在代码里动态构图（不走 registry entry），所以 WorkflowAvailability 那套
// 检查覆盖不到它。模型缺失时 ComfyUI 会回：
//   Prompt outputs failed validation
//   节点 2: Value not in list
//   节点 3: Value not in list
// —— 用户只看到「节点 2/3」，不知道是哪个文件、该装什么。
//
// 这里在提交前比对所需模型与本地实际拥有的，给出能直接照做的报错。

/** swap-chain 需要的模型，按「展示名 → 目标文件名」列出。 */
export const SWAP_CHAIN_MODELS = {
    unet: { file: "qwen_image_2.1_bf16.safetensors", label: "Qwen 2.1 底模" },
    lora6: { file: "p_q_image_2.1_6_steps_v0.2_comfyui_bf16.safetensors", label: "Qwen 2.1 六步加速 LoRA" },
    oldx: { file: "oldx-qwen2.1人物替换.safetensors", label: "oldx Qwen 2.1 人物替换 LoRA" },
    clip: { file: "qwen3vl_8b_int8_convrot.safetensors", label: "Qwen3-VL 8B 文本编码器" },
    vae: { file: "qwen_image_2.1_vae_bf16.safetensors", label: "Qwen 2.1 VAE" },
    swapUnet: { file: "viggle_remake_swap_pruned_int8_convrot.safetensors", label: "Viggle Remake 换人底模" },
    h3Clip: { file: "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors", label: "H3 文本编码器（32B）" },
    h3VideoVae: { file: "minimax_h3_video_vae_fp16.safetensors", label: "H3 视频 VAE" },
    h3AudioVae: { file: "minimax_h3_audio_vae_fp32.safetensors", label: "H3 音频 VAE" },
};

/**
 * 比对所需与可用模型，返回缺失项。
 *
 * @param {(name: string) => boolean} hasLora 判断某个 LoRA 是否可用
 * @param {(name: string) => boolean} hasModel 判断非 LoRA 的模型（unet/vae/clip）是否可用
 * @param {(file: string) => boolean} [exists] 兜底：直接按文件是否存在判断
 *
 * 文件名比较交给调用方传进来的 predicate 去归一化（大小写、子目录写法），
 * 这里不做字符串相等比较 —— ComfyUI 的 loras 列表常见
 * `Qwen-功能2.1\xxx.safetensors` 这种带子目录的写法，直接比相等会误判缺失。
 */
export function findMissingSwapChainModels({ hasLora, hasModel }) {
    const check = (spec, isLora) => {
        const predicate = isLora ? hasLora : hasModel;
        return predicate(spec.file) ? null : spec;
    };
    const missing = [
        check(SWAP_CHAIN_MODELS.unet, false),
        check(SWAP_CHAIN_MODELS.lora6, true),
        check(SWAP_CHAIN_MODELS.oldx, true),
        check(SWAP_CHAIN_MODELS.clip, false),
        check(SWAP_CHAIN_MODELS.vae, false),
        check(SWAP_CHAIN_MODELS.swapUnet, false),
        check(SWAP_CHAIN_MODELS.h3Clip, false),
        check(SWAP_CHAIN_MODELS.h3VideoVae, false),
        check(SWAP_CHAIN_MODELS.h3AudioVae, false),
    ].filter(Boolean);
    return { missing };
}

/**
 * 模型清单是否可用。
 *
 * 网关刚启动、或 ComfyUI 离线时，loaderOptions() 会返回空/不全 ——
 * 这时候「一个都找不到」并不意味着用户真的没装，而是**查不到**。
 * 必须区分这两种情况，否则会给出「缺少 9 个模型」这种严重误导的报错。
 *
 * 判定方式：三个 loader 目录里至少要有一个非空列表，才算清单已就绪。
 */
export function isModelCatalogReady(catalog) {
    if (!catalog || typeof catalog !== "object") return false;
    const keys = [
        "LoraLoaderModelOnly\u0000lora_name",
        "UNETLoader\u0000unet_name",
        "CLIPLoader\u0000clip_name",
        "VAELoader\u0000vae_name",
        // 聚合键（loaderOptionsFor 支持无 input 的退化读取）
        "LoraLoaderModelOnly",
        "UNETLoader",
        "CLIPLoader",
        "VAELoader",
    ];
    return keys.some((key) => Array.isArray(catalog[key]) && catalog[key].length > 0);
}

/** 把缺失项拼成一段可操作的报错文本。 */
export function missingSwapChainMessage(missing) {
    if (!missing.length) return "";
    const lines = missing.map((item) => `${item.label}（${item.file}）`).join("、");
    // oldx 在资源中心是可选的，单独点出来，省得用户去别处找。
    const hasOldx = missing.some((item) => item.file === SWAP_CHAIN_MODELS.oldx.file);
    const hint = hasOldx ? "其中 oldx 人物替换 LoRA 可在资源中心「Viggle Remake 角色替换」包里勾选安装。" : "";
    return `换人成片缺少 ${missing.length} 个模型：${lines}。${hint}`;
}
