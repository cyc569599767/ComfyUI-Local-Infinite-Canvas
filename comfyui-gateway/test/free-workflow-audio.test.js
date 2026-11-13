import assert from "node:assert/strict";
import test from "node:test";

import { detectFreeBindings } from "../src/ui-workflow.js";

// 自由卡片以前只认图片/视频输出，音频工作流被归为「其他工作流」并在 UI 里禁用生成。
// 这组测试锁定「音频输出能被识别成 audio」这一前提。

const ENCODE = { class_type: "CLIPTextEncode", inputs: { text: "hi", clip: ["9", 0] } };

test("SaveAudio 输出被识别为 audio 类型的自由卡片", () => {
  const workflow = {
    1: ENCODE,
    2: { class_type: "SaveAudio", inputs: { audio: ["3", 0], filename_prefix: "audio/out" } },
    3: { class_type: "VAEDecodeAudio", inputs: { samples: ["4", 0], vae: ["9", 1] } },
  };
  const bindings = detectFreeBindings(workflow);
  assert.equal(bindings.outputType, "audio");
});

test("SaveAudioAdvanced 与 PreviewAudio 同样算音频输出", () => {
  for (const classType of ["SaveAudioAdvanced", "PreviewAudio"]) {
    const workflow = {
      1: ENCODE,
      2: { class_type: classType, inputs: { audio: ["3", 0] } },
      3: { class_type: "VAEDecodeAudio", inputs: { samples: ["4", 0] } },
    };
    assert.equal(detectFreeBindings(workflow).outputType, "audio", `${classType} 应识别为 audio`);
  }
});

test("视频输出优先于音频，避免带音轨的视频被判成音频", () => {
  const workflow = {
    1: ENCODE,
    2: { class_type: "SaveAudio", inputs: { audio: ["3", 0] } },
    3: { class_type: "VAEDecodeAudio", inputs: { samples: ["4", 0] } },
    4: { class_type: "SaveVideo", inputs: { video: ["5", 0] } },
    5: { class_type: "VAEDecode", inputs: { samples: ["6", 0] } },
  };
  assert.equal(detectFreeBindings(workflow).outputType, "video");
});

test("既无图片也无视频也无音频输出时仍回落为 null 并给警告", () => {
  const workflow = {
    1: ENCODE,
    2: { class_type: "SomeUnknownSink", inputs: { value: ["1", 0] } },
  };
  const bindings = detectFreeBindings(workflow);
  assert.equal(bindings.outputType, null);
  assert.ok(bindings.warnings.some((warning) => warning.includes("SaveAudio")), "警告应提示支持音频输出");
});

test("音频工作流不会把 LoadAudio 误判成图片输入", () => {
  const workflow = {
    1: ENCODE,
    2: { class_type: "LoadAudio", inputs: { audio: "ref.wav" } },
    3: { class_type: "SaveAudio", inputs: { audio: ["4", 0] } },
    4: { class_type: "VAEDecodeAudio", inputs: { samples: ["5", 0] } },
  };
  const bindings = detectFreeBindings(workflow);
  assert.equal(bindings.outputType, "audio");
  assert.equal(bindings.images.length, 0, "参考音频不应出现在图片输入里");
});
