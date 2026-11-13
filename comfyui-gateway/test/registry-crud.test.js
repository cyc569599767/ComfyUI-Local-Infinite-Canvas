import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createRegistry } from "../src/registry.js";

function workflow(text) {
  return {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "mock.safetensors" } },
    2: { class_type: "CLIPTextEncode", inputs: { text, clip: ["1", 1] } },
    3: { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "crud" } },
  };
}

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "registry-crud-"));
  const registry = createRegistry({ dir, logger: null });
  await registry.importWorkflow({ json: workflow("hello"), name: "image-crud", type: "image" });
  return { dir, registry };
}

test("更新描述与参数后立即生效，id 与文件名保持不变", async () => {
  const { registry } = await setup();
  const before = registry.list()[0];
  assert.equal(before.id, "image-crud");

  await registry.updateWorkflow("image-crud", {
    description: "新的描述",
    parameters: [{ key: "seed", label: "种子", type: "number" }],
  });

  const after = registry.list()[0];
  assert.equal(after.id, "image-crud");
  assert.equal(after.file, before.file, "文件名不应变化");
  assert.equal(after.description, "新的描述");
  assert.equal(after.parameters.length, 1);
});

test("更新工作流 JSON 内容后落盘，重新加载仍是新内容", async () => {
  const { dir, registry } = await setup();
  const target = registry.list()[0];

  await registry.updateWorkflow("image-crud", { json: workflow("updated text") });
  const filePath = path.join(dir, target.file);
  const saved = JSON.parse(await fsp.readFile(filePath, "utf8"));
  assert.equal(saved["2"].inputs.text, "updated text");
});

test("拒绝把 UI 格式当作工作流内容保存", async () => {
  const { registry } = await setup();
  await assert.rejects(
    () => registry.updateWorkflow("image-crud", { json: { nodes: [], links: [] } }),
    /UI 格式/,
  );
});

test("拒绝无效的 API 工作流内容", async () => {
  const { registry } = await setup();
  await assert.rejects(() => registry.updateWorkflow("image-crud", { json: { foo: "bar" } }), /API 格式/);
});

test("改名时保持类型前缀，并拒绝与其它工作流重名", async () => {
  const { registry } = await setup();
  await registry.importWorkflow({ json: workflow("other"), name: "image-other", type: "image" });

  await registry.updateWorkflow("image-crud", { name: "改名后的" });
  const renamed = registry.resolve("image-crud");
  assert.equal(renamed.name, "image-改名后的", "应自动补上 image- 前缀");

  await assert.rejects(() => registry.updateWorkflow("image-crud", { name: "image-other" }), /已被占用/);
});

test("更新不存在的工作流返回 404", async () => {
  const { registry } = await setup();
  await assert.rejects(() => registry.updateWorkflow("nope", { description: "x" }), (error) => {
    assert.equal(error.status, 404);
    return true;
  });
});

test("删除后从注册表消失", async () => {
  const { registry } = await setup();
  assert.equal(await registry.remove("image-crud"), true);
  assert.equal(registry.list().length, 0);
  // 再删一次返回 false，便于路由区分 404
  assert.equal(await registry.remove("image-crud"), false);
});
