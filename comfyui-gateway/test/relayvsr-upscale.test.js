import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { applyBindings, buildContext } from "../src/bindings.js";

const WORKFLOWS = path.join(import.meta.dirname, "..", "workflows");
const registry = JSON.parse(fs.readFileSync(path.join(WORKFLOWS, "registry.json"), "utf8"));
const relayEntry = registry.workflows.find((item) => item.id === "video-relayvsr-upscale");
const relayWorkflow = JSON.parse(fs.readFileSync(path.join(WORKFLOWS, "video-relayvsr-upscale.json"), "utf8"));

function apply(params) {
  return applyBindings(relayWorkflow, relayEntry, buildContext({ mode: "upscale", uploadedVideos: [{ name: "src.mp4" }], params }));
}

// RelayVSR 的倍率来自权重对本身，没有独立 widget；两种档位必须整对切换，
// 混用 x2 模型 + x4 VAE（或反过来）会直接失败，所以用同一份 map 同步两个 loader。
test("RelayVSR 2x/4x 切换的是配套权重对，不是单独写倍率", () => {
  const two = apply({ factor: 2 });
  assert.equal(two["3"].inputs.unet_name, "relayvsr_x2_lightx2v_int8_convrot.safetensors");
  assert.equal(two["4"].inputs.vae_name, "relayvsr_flash_vae_x2_fp32.safetensors");

  const four = apply({ factor: 4 });
  assert.equal(four["3"].inputs.unet_name, "relayvsr_x4_int8_convrot.safetensors");
  assert.equal(four["4"].inputs.vae_name, "relayvsr_flash_vae_x4_fp32.safetensors");
});

test("RelayVSR 缺省档位回落到 x2 权重对，未知档位不会静默串档", () => {
  const fallback = apply({});
  assert.equal(fallback["3"].inputs.unet_name, "relayvsr_x2_lightx2v_int8_convrot.safetensors");
  assert.equal(fallback["4"].inputs.vae_name, "relayvsr_flash_vae_x2_fp32.safetensors");

  // 非 4 的任何值都按 2x 处理，避免把 x4 VAE 和 x2 模型配在一起。
  const unknown = apply({ factor: 3 });
  assert.equal(unknown["3"].inputs.unet_name, "relayvsr_x2_lightx2v_int8_convrot.safetensors");
  assert.equal(unknown["4"].inputs.vae_name, "relayvsr_flash_vae_x2_fp32.safetensors");
});

test("RelayVSR 原音频、帧率和全帧还原都来自同一份源视频", () => {
  const out = apply({ factor: 2, detail: 0.5, seed: 7 });
  // 2 是唯一的视频解码节点；7 用它的 IMAGE，合成用 AUDIO 与 FPS，不能各自新建 LoadVideo。
  assert.equal(out["2"].class_type, "GetVideoComponents");
  assert.equal(out["1"].class_type, "LoadVideo");
  assert.equal(out["1"].inputs.file, "src.mp4");
  assert.deepEqual(out["5"].inputs.images, ["2", 0]);
  assert.deepEqual(out["7"].inputs.images, ["2", 0]);
  assert.deepEqual(out["8"].inputs.audio, ["2", 1]);
  assert.deepEqual(out["8"].inputs.fps, ["2", 2]);
  assert.equal(out["7"].inputs.detail, 0.5);
  assert.equal(out["6"].inputs.seed, 7);
  // 单步、cfg 1 是官方要求的采样设置；改了就出不了正确结果。
  assert.equal(out["6"].inputs.steps, 1);
  assert.equal(out["6"].inputs.cfg, 1);
  assert.equal(out["6"].inputs.sampler_name, "euler");
  assert.equal(out["6"].inputs.scheduler, "simple");
});

test("RelayVSR 不写入 SeedVR2 专属字段", () => {
  const out = apply({ factor: 2, resolution: 1234, batch_size: 5, color_correction: "wavelet" });
  const text = JSON.stringify(out);
  assert.equal(text.includes("batch_size"), false, "RelayVSR 没有批大小参数");
  assert.equal(text.includes("color_correction"), false, "RelayVSR 没有色彩校正参数");
  assert.equal(text.includes("SeedVR2"), false);
});

test("SeedVR2 条目仍保持原有绑定，没有被 RelayVSR 改动影响", () => {
  const seedEntry = registry.workflows.find((item) => item.id === "video-seedvr2-upscale");
  assert.ok(seedEntry, "SeedVR2 视频超分条目不应消失");
  assert.equal(seedEntry.category, "upscale");
  assert.equal(seedEntry.hidden, true);
  assert.equal(seedEntry.bindings.resolution.default, 1104);
  assert.equal(relayEntry.category, "upscale");
  assert.equal(relayEntry.hidden, true);
});
