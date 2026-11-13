import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createRegistry, defaultLabel } from "../src/registry.js";

function workflow(text) {
  return {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "mock.safetensors" } },
    2: { class_type: "CLIPTextEncode", inputs: { text, clip: ["1", 1] } },
    3: { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "label" } },
  };
}

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "registry-label-"));
}

test("defaultLabel 去掉扩展名", () => {
  assert.equal(defaultLabel("image-foo.json"), "image-foo");
  assert.equal(defaultLabel("/abs/dir/video-bar.JSON"), "video-bar");
  assert.equal(defaultLabel(""), "");
});

test("导入不传 label 时默认取 JSON 文件名", async () => {
  const dir = await tempDir();
  const registry = createRegistry({ dir, logger: null });
  const { workflow: saved } = await registry.importWorkflow({ json: workflow("hi"), name: "image-label-default", type: "image" });

  assert.equal(saved.file, "image-label-default.json");
  assert.equal(saved.label, "image-label-default");

  const raw = JSON.parse(await fsp.readFile(path.join(dir, "registry.json"), "utf8"));
  assert.equal(raw.workflows[0].label, "image-label-default", "label 必须落盘，不能留空");
});

test("导入时显式传 label 优先于文件名", async () => {
  const dir = await tempDir();
  const registry = createRegistry({ dir, logger: null });
  const { workflow: saved } = await registry.importWorkflow({
    json: workflow("hi"),
    name: "image-label-custom",
    label: "  自定义显示名  ",
    type: "image",
  });

  assert.equal(saved.label, "自定义显示名");
});

test("label 只有空白字符时回落到文件名", async () => {
  const dir = await tempDir();
  const registry = createRegistry({ dir, logger: null });
  const { workflow: saved } = await registry.importWorkflow({ json: workflow("hi"), name: "image-label-blank", label: "   ", type: "image" });

  assert.equal(saved.label, "image-label-blank");
});

test("registry.json 里 label 缺失或为空时加载回落到 JSON 文件名", async () => {
  const dir = await tempDir();
  await fsp.writeFile(path.join(dir, "bare-workflow.json"), JSON.stringify(workflow("x")), "utf8");
  await fsp.writeFile(
    path.join(dir, "registry.json"),
    JSON.stringify({
      version: 1,
      workflows: [
        { id: "image-bare", name: "image-bare", type: "image", file: "bare-workflow.json" },
        { id: "image-empty", name: "image-empty", type: "image", file: "bare-workflow.json", label: "" },
      ],
    }),
    "utf8",
  );

  const registry = createRegistry({ dir, logger: null });
  await registry.load();

  assert.equal(registry.resolve("image-bare").label, "bare-workflow");
  assert.equal(registry.resolve("image-empty").label, "bare-workflow");
  for (const entry of registry.list()) assert.ok(entry.label, `${entry.id} 的 label 不能为空`);
});

test("清空 label 等价于回落到文件名，不写入空字符串", async () => {
  const dir = await tempDir();
  const registry = createRegistry({ dir, logger: null });
  await registry.importWorkflow({ json: workflow("hi"), name: "image-label-reset", label: "原名", type: "image" });

  await registry.updateWorkflow("image-label-reset", { label: "" });
  assert.equal(registry.resolve("image-label-reset").label, "image-label-reset");

  const raw = JSON.parse(await fsp.readFile(path.join(dir, "registry.json"), "utf8"));
  assert.equal(raw.workflows[0].label, "image-label-reset");
});

test("label 超长时截断到 64 字符", async () => {
  const dir = await tempDir();
  const registry = createRegistry({ dir, logger: null });
  const { workflow: saved } = await registry.importWorkflow({
    json: workflow("hi"),
    name: "image-label-long",
    label: "长".repeat(100),
    type: "image",
  });

  assert.equal(saved.label.length, 64);
});

test("仓库内置 registry.json 的每条工作流都有非空 label", async () => {
  const registryPath = path.resolve(import.meta.dirname, "..", "workflows", "registry.json");
  const data = JSON.parse(await fsp.readFile(registryPath, "utf8"));
  for (const entry of data.workflows) {
    assert.ok(String(entry.label || "").trim(), `${entry.id || entry.file} 缺少 label`);
  }
});
