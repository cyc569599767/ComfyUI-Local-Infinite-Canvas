import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createWorkflowLabelStore } from "../src/workflow-labels.js";

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "wf-labels-"));
}

test("设置自定义显示名后能读回，并持久化到磁盘", async () => {
  const dataDir = await tempDir();
  const store = createWorkflowLabelStore({ dataDir });
  await store.load();

  assert.equal(store.get("audio-voice-design"), "");

  await store.set("audio-voice-design", "我的音色设计");
  assert.equal(store.get("audio-voice-design"), "我的音色设计");

  // 重新加载应保留，证明落盘有效。
  const reopened = createWorkflowLabelStore({ dataDir });
  await reopened.load();
  assert.equal(reopened.get("audio-voice-design"), "我的音色设计");
});

test("传空值恢复默认：删除覆盖项", async () => {
  const dataDir = await tempDir();
  const store = createWorkflowLabelStore({ dataDir });
  await store.load();

  await store.set("audio-music", "自定义音乐");
  assert.equal(store.get("audio-music"), "自定义音乐");

  await store.set("audio-music", "   ");
  assert.equal(store.get("audio-music"), "", "空值应删除覆盖，交回 registry 默认");

  const reopened = createWorkflowLabelStore({ dataDir });
  await reopened.load();
  assert.equal(reopened.get("audio-music"), "");
});

test("显示名会裁剪空白、换行并限制长度", async () => {
  const dataDir = await tempDir();
  const store = createWorkflowLabelStore({ dataDir });
  await store.load();

  await store.set("x", "  音色\n设计  ");
  assert.equal(store.get("x"), "音色 设计", "换行应压成空格并去掉首尾空白");

  await store.set("y", "长".repeat(200));
  assert.equal(store.get("y").length, store.MAX_LABEL_LENGTH);
});

test("缺少 ID 时拒绝写入", async () => {
  const dataDir = await tempDir();
  const store = createWorkflowLabelStore({ dataDir });
  await store.load();
  await assert.rejects(() => store.set("", "name"), /缺少工作流 ID/);
});

test("配置文件损坏时不崩溃，回退为空覆盖", async () => {
  const dataDir = await tempDir();
  await fs.writeFile(path.join(dataDir, "workflow-labels.json"), "{ not json", "utf8");
  const store = createWorkflowLabelStore({ dataDir });
  await store.load();
  assert.equal(store.get("anything"), "");
});

test("BOM 开头的配置文件也能读取", async () => {
  const dataDir = await tempDir();
  await fs.writeFile(path.join(dataDir, "workflow-labels.json"), `\uFEFF${JSON.stringify({ version: 1, labels: { wf1: "带BOM" } })}`, "utf8");
  const store = createWorkflowLabelStore({ dataDir });
  await store.load();
  assert.equal(store.get("wf1"), "带BOM");
});
