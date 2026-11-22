// 换人长链的模型预检。
//
// 现场报错（模型缺失时 ComfyUI 的原始回执，用户看不懂）：
//   Prompt outputs failed validation
//   节点 2: Value not in list
//   节点 3: Value not in list
// 节点 2/3 是两个 LoRA loader，缺的是 p_q_image_2.1_6_steps 与
// oldx-qwen2.1人物替换。要在提交前就拦下并说清缺什么。
import assert from "node:assert/strict";
import test from "node:test";

import { findMissingSwapChainModels, isModelCatalogReady, missingSwapChainMessage, SWAP_CHAIN_MODELS } from "../src/swap-chain-models.js";

const allPresent = () => true;
const nonePresent = () => false;

test("全部齐备时不报缺失", () => {
    const { missing } = findMissingSwapChainModels({ hasLora: allPresent, hasModel: allPresent });
    assert.deepEqual(missing, []);
    assert.equal(missingSwapChainMessage(missing), "");
});

test("全部缺失时列出 9 项", () => {
    const { missing } = findMissingSwapChainModels({ hasLora: nonePresent, hasModel: nonePresent });
    assert.equal(missing.length, 9);
});

test("复现现场：只缺两个 LoRA 时精准指出节点 2/3 对应的文件", () => {
    // 其他都在，只缺六步 LoRA 和 oldx —— 正是 Value not in list 的现场
    const missingLoras = new Set([SWAP_CHAIN_MODELS.lora6.file, SWAP_CHAIN_MODELS.oldx.file]);
    const { missing } = findMissingSwapChainModels({
        hasLora: (name) => !missingLoras.has(name),
        hasModel: allPresent,
    });
    assert.equal(missing.length, 2);
    const files = missing.map((item) => item.file).sort();
    assert.deepEqual(files, [SWAP_CHAIN_MODELS.lora6.file, SWAP_CHAIN_MODELS.oldx.file].sort());
});

test("报错文案给出可操作信息：中文名 + 文件名 + oldx 去哪装", () => {
    const missing = [SWAP_CHAIN_MODELS.lora6, SWAP_CHAIN_MODELS.oldx];
    const message = missingSwapChainMessage(missing);
    assert.match(message, /缺少 2 个模型/);
    assert.match(message, /Qwen 2\.1 六步加速 LoRA/);
    assert.match(message, /oldx-qwen2\.1人物替换\.safetensors/);
    assert.match(message, /资源中心/);
    assert.match(message, /Viggle Remake/);
});

test("不含 oldx 时不提资源中心，避免误导", () => {
    const message = missingSwapChainMessage([SWAP_CHAIN_MODELS.unet]);
    assert.match(message, /Qwen 2\.1 底模/);
    assert.doesNotMatch(message, /资源中心/);
});

test("归一化交给调用方：大小写/子目录差异不应误判缺失", () => {
    // ComfyUI 的 loras 列表常返回 "Qwen-功能2.1\\xxx.safetensors" 这种带子目录的写法，
    // 调用方需按 basename + 小写做包含匹配。这里模拟网关的归一化实现。
    const normalize = (value) => String(value || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
    const availableLoras = ["Qwen-功能2.1/p_q_image_2.1_6_steps_v0.2_comfyui_bf16.safetensors".toUpperCase()];
    const { missing } = findMissingSwapChainModels({
        hasLora: (name) => availableLoras.some((item) => normalize(item) === normalize(name)),
        hasModel: allPresent,
    });
    const missingLoras = missing.filter((item) => item.file.endsWith(".safetensors"));
    assert.ok(!missingLoras.some((item) => item.file === SWAP_CHAIN_MODELS.lora6.file), "大小写不同应视为已存在");
});

test("清单未就绪时必须能识别出来（否则会误报全缺）", () => {
  // 网关刚启动 / ComfyUI 离线：loaderOptions 返回空对象
  assert.equal(isModelCatalogReady({}), false);
  assert.equal(isModelCatalogReady(null), false);
  assert.equal(isModelCatalogReady(undefined), false);
  // 目录存在但列表都是空的，同样算未就绪
  assert.equal(isModelCatalogReady({ "LoraLoaderModelOnly\u0000lora_name": [], "UNETLoader\u0000unet_name": [] }), false);
});

test("清单就绪时返回 true", () => {
  assert.equal(isModelCatalogReady({ "LoraLoaderModelOnly\u0000lora_name": ["a.safetensors"] }), true);
  // 聚合键也算
  assert.equal(isModelCatalogReady({ VAELoader: ["b.safetensors"] }), true);
});

test("离线场景：清单为空时不应该断言「缺 9 个模型」", () => {
  // 模拟现场：catalog = {} 导致所有 predicate 返回 false
  const empty = new Set();
  const { missing } = findMissingSwapChainModels({
    hasLora: (f) => empty.has(f),
    hasModel: (f) => empty.has(f),
  });
  // 这就是病态结果：9 个全缺。调用方必须先判 isModelCatalogReady 再下结论。
  assert.equal(missing.length, 9);
  assert.equal(isModelCatalogReady({}), false, "调用方据此改成「读不到清单」");
});
