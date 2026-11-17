import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { applyBindings, buildContext } from "../src/bindings.js";

const WORKFLOWS = path.join(import.meta.dirname, "..", "workflows");
const registry = JSON.parse(fs.readFileSync(path.join(WORKFLOWS, "registry.json"), "utf8"));
const entry = registry.workflows.find((item) => item.id === "video-dlss5-upscale");
const workflow = JSON.parse(fs.readFileSync(path.join(WORKFLOWS, "video-dlss5-upscale.json"), "utf8"));

function apply(params) {
  return applyBindings(workflow, entry, buildContext({ mode: "upscale", uploadedVideos: [{ name: "src.mp4" }], params }));
}

test("DLSS5 条目挂在超分分类下并保持隐藏，不与生成工作流混淆", () => {
  assert.ok(entry, "缺少 video-dlss5-upscale 注册项");
  assert.equal(entry.category, "upscale");
  assert.equal(entry.type, "video");
  assert.equal(entry.hidden, true);
  assert.equal(entry.file, "video-dlss5-upscale.json");
});

// DLSS5 的倍率没有独立 widget，只能通过 upscaling_mode 这个枚举表达。
// 取值必须逐字等于 ComfyUI 里 RH_DLSS5Enhance 的合法选项，否则提交会被拒。
test("DLSS5 倍率映射到真实的 upscaling_mode 枚举值", () => {
  const cases = [
    [1.5, "1.5x (Quality)"],
    [1.724, "1.724x (Balanced)"],
    [2, "2x (Performance)"],
    [3, "3x (Ultra Performance)"],
  ];
  for (const [factor, expected] of cases) {
    assert.equal(apply({ factor })["2"].inputs.upscaling_mode, expected, `factor=${factor}`);
  }
});

test("DLSS5 未知倍率回落到 1.5x，不会把档位当成枚举值提交", () => {
  assert.equal(apply({ factor: 5 })["2"].inputs.upscaling_mode, "1.5x (Quality)");
  assert.equal(apply({})["2"].inputs.upscaling_mode, "1.5x (Quality)");
});

test("DLSS5 细节与色彩走 float，不能写成字符串", () => {
  const out = apply({ factor: 2, detail: 0.5, color: 0.25 });
  assert.equal(out["2"].inputs.detail, 0.5);
  assert.equal(out["2"].inputs.color, 0.25);
  assert.equal(typeof out["2"].inputs.detail, "number");
});

test("DLSS5 保留音频直通与源视频连线，未注入 SeedVR2/RelayVSR 专属字段", () => {
  const out = apply({ factor: 2 });
  assert.equal(out["1"].class_type, "LoadVideo");
  assert.equal(out["1"].inputs.file, "src.mp4");
  assert.deepEqual(out["2"].inputs.video, ["1", 0]);
  // 输出取 VIDEO 口（索引 1），不是 images 口。
  assert.deepEqual(out["3"].inputs.video, ["2", 1]);
  assert.equal(out["2"].inputs.keep_audio, "on");
  const text = JSON.stringify(out);
  for (const bogus of ["batch_size", "color_correction", "resolution", "SeedVR2", "relayvsr"]) {
    assert.equal(text.includes(bogus), false, `DLSS5 不应出现 ${bogus}`);
  }
});

test("三种超分条目各自独立，互不覆盖", () => {
  const ids = registry.workflows.filter((item) => item.category === "upscale").map((item) => item.id);
  for (const id of ["video-seedvr2-upscale", "video-relayvsr-upscale", "video-dlss5-upscale"]) {
    assert.ok(ids.includes(id), `缺少 ${id}`);
    assert.equal(registry.workflows.filter((item) => item.id === id).length, 1, `${id} 重复`);
  }
});
