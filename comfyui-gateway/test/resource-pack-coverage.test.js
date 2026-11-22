// 资源清单的一致性：每个模型资源都必须能被用户在界面上看到。
//
// 背景：资源中心的渲染只按「资源包」遍历 —— pack.requiredItems / pack.optionalItems。
// 一条资源如果只是存在于顶层 resources 数组、却没被任何包的 resources /
// optionalResources / workflowDependencies 引用，它在界面上完全不可见：
// 用户装不了，但后端功能又依赖它，一用就报「缺少模型」。
//
// oldx Qwen 2.1 人物替换 LoRA 就踩过这个坑：卡定义与后端用法都在，
// 唯独没挂进任何包，等于半成品。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(fs.readFileSync(path.join(root, "resources", "index.json"), "utf8"));

// 已退役的资源不再作为安装入口，允许它不出现在任何包里。
// 必须与 src/resources.js 的 RETIRED_RESOURCE_IDS 保持一致。
const RETIRED = new Set(["h3_character_swap_lora", "h3_vdn_node", "qwen21_outpaint_lora"]);

// 已知的、有意不挂包的资源：它们服务的是本 fork 自带的创作工作流
// （creation-video-h3-* / video-minimax_h3_easy_* / image-moss-sft-12step），
// 这些工作流不在资源包体系内，走自己的逐节点模型配置。
// 如果哪天把它们接进资源包，请把 id 从这里删掉 —— 测试会强制要求挂包。
const KNOWN_UNPACKED = new Set(["h3_video_vae_int8", "moss_12steps_lora"]);

/** 收集所有被包引用的资源 id（三种引用方式都算）。 */
function referencedIds() {
    const ids = new Set();
    for (const pack of index.packs || []) {
        for (const id of pack.resources || []) ids.add(id);
        for (const id of pack.optionalResources || []) ids.add(id);
        for (const list of Object.values(pack.workflowDependencies || {})) {
            for (const id of list || []) ids.add(id);
        }
        for (const variant of pack.variants || []) {
            for (const id of variant.requiredResources || []) ids.add(id);
        }
    }
    return ids;
}

test("没有意外孤儿资源：未挂包的 model 资源只能是已登记的那些", () => {
    const referenced = referencedIds();
    const orphans = (index.resources || [])
        .filter((item) => item.type === "model" && !referenced.has(item.id) && !RETIRED.has(item.id))
        .map((item) => item.id)
        .sort();
    // 多出来的就是新出现的「卡定义有、界面看不到」半成品，必须挂包或显式登记。
    assert.deepEqual(orphans, [...KNOWN_UNPACKED].sort(), `未挂包的资源与登记清单不一致（多出来的在界面上不可见，用户装不了）：${orphans.join(", ")}`);
});

test("oldx Qwen 2.1 人物替换 LoRA 挂在 viggle 角色替换包的可选资源里", () => {
    const pack = (index.packs || []).find((item) => item.id === "viggle");
    assert.ok(pack, "找不到 viggle 包");
    assert.ok(
        (pack.optionalResources || []).includes("qwen21_oldx_character_swap_lora"),
        "oldx 换人 LoRA 必须在 viggle 包的可选资源里，否则资源中心看不到",
    );
    // 它不是换人链路的必需项（主链路用 viggle_swap_int8），所以只放可选。
    assert.ok(!(pack.resources || []).includes("qwen21_oldx_character_swap_lora"), "oldx 不应作为 viggle 包的必装项");
});

test("oldx 资源条目字段完整，且确实指向后端使用的文件", () => {
    const item = (index.resources || []).find((entry) => entry.id === "qwen21_oldx_character_swap_lora");
    assert.ok(item, "资源条目不存在");
    assert.equal(item.type, "model");
    // 文件名必须与后端 swap-chain.js / server.js 里写死的一致，否则装上也用不上。
    assert.equal(item.target, "loras/oldx-qwen2.1人物替换.safetensors");
    assert.ok(item.size > 0, "缺少体积，界面无法估算下载大小");
    assert.match(String(item.sha256 || ""), /^[0-9a-f]{64}$/, "缺少校验和，下载无法验证");
    assert.ok(Array.isArray(item.sources) && item.sources.length > 0, "缺少下载源");
    // 社区件的许可状态必须如实标注，不能悄悄当成可自由分发的资源。
    assert.match(String(item.license || "") + String(item.note || ""), /许可不明/, "必须保留「许可不明」的标注");
});

test("每个被引用的资源 id 都能在 resources 数组里找到实体", () => {
    const known = new Set((index.resources || []).map((item) => item.id));
    const dangling = [...referencedIds()].filter((id) => !known.has(id));
    assert.deepEqual(dangling, [], `以下 id 被包引用但资源清单里没有对应条目：${dangling.join(", ")}`);
});
