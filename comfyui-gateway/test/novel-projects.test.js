import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNovelStore } from "../src/novel-projects.js";

async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "novel-store-"));
  t.after(async () => fsp.rm(dir, { recursive: true, force: true }));
  const store = createNovelStore({ dataDir: dir });
  await store.load();
  return { store, dir };
}

test("小说项目落盘后重启仍能读回", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "novel-persist-"));
  t.after(async () => fsp.rm(dir, { recursive: true, force: true }));
  const first = createNovelStore({ dataDir: dir });
  await first.load();
  const created = await first.create({ name: "测试书", idea: "一个测试用的中心思想" });
  assert.equal(created.name, "测试书");

  const second = createNovelStore({ dataDir: dir });
  await second.load();
  const loaded = second.get(created.id);
  assert.equal(loaded?.name, "测试书");
  assert.equal(loaded?.idea, "一个测试用的中心思想");
});

test("局部更新不会抹掉其他字段", async (t) => {
  const { store } = await fixture(t);
  const created = await store.create({ name: "书", idea: "想法" });
  await store.update(created.id, { chapters: [{ seq: 1, title: "第一章", volume: 1, outline: "纲", novel: "正文" }] });
  // 只改 characters，正文必须还在：改角色不该顺手清空正在写的书。
  const after = await store.update(created.id, { characters: [{ name: "张三", role: "主角" }] });
  assert.equal(after.chapters.length, 1);
  assert.equal(after.chapters[0].novel, "正文");
  assert.equal(after.characters.length, 1);
});

test("structure 是浅合并，改一层不影响另外两层", async (t) => {
  const { store } = await fixture(t);
  const created = await store.create({ name: "书", idea: "想法" });
  await store.update(created.id, { structure: { outline: "总纲", volumes: "卷纲", chapters: "章纲" } });
  const after = await store.update(created.id, { structure: { outline: "新总纲" } });
  assert.equal(after.structure.outline, "新总纲");
  assert.equal(after.structure.volumes, "卷纲", "只改总纲不该把卷纲清掉");
  assert.equal(after.structure.chapters, "章纲");
});

test("列表只给摘要，不带正文", async (t) => {
  const { store } = await fixture(t);
  const created = await store.create({ name: "长书", idea: "想法" });
  const longText = "正文".repeat(5000);
  await store.update(created.id, { chapters: [{ seq: 1, title: "一", volume: 1, outline: "纲", novel: longText }] });
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].chapterCount, 1);
  assert.equal(list[0].wordCount, longText.length);
  // 摘要里不该出现小说正文，否则列表接口会变成几 MB。
  assert.equal("chapters" in list[0], false);
});

test("章节状态由正文/章纲自动推断", async (t) => {
  const { store } = await fixture(t);
  const created = await store.create({ name: "书", idea: "想法" });
  const after = await store.update(created.id, {
    chapters: [
      { seq: 1, title: "只有标题", volume: 1 },
      { seq: 2, title: "有章纲", volume: 1, outline: "纲" },
      { seq: 3, title: "有正文", volume: 1, outline: "纲", novel: "正文" },
    ],
  });
  assert.equal(after.chapters[0].status, "pending");
  assert.equal(after.chapters[1].status, "outlined");
  assert.equal(after.chapters[2].status, "done");
});

test("空项目和非法条目被跳过，不拖垮整个列表", async (t) => {
  const { store, dir } = await fixture(t);
  await store.create({ name: "好书", idea: "想法" });
  // 手工写入一条垃圾数据，模拟文件被外部改坏。
  const file = path.join(dir, "novel-projects.json");
  const raw = JSON.parse(await fsp.readFile(file, "utf8"));
  raw.projects.push({ foo: "bar" }, null, { name: "" });
  await fsp.writeFile(file, JSON.stringify(raw), "utf8");

  const reloaded = createNovelStore({ dataDir: dir });
  await reloaded.load();
  assert.equal(reloaded.list().length, 1, "只有合法条目该留下");
});

test("contextBlock 带上前文，供续写保持连贯", async (t) => {
  const { store } = await fixture(t);
  const created = await store.create({ name: "书", idea: "核心想法" });
  await store.update(created.id, {
    structure: { outline: "总纲内容" },
    characters: [{ name: "李四", role: "配角", description: "沉默寡言" }],
    memory: [{ content: "主角已失去记忆" }],
    chapters: [{ seq: 1, title: "一", volume: 1, outline: "纲", novel: "第一段正文" }],
  });
  const block = store.contextBlock(created.id);
  for (const expected of ["核心想法", "总纲内容", "李四", "主角已失去记忆", "第一段正文"]) {
    assert.ok(block.includes(expected), `上下文应包含：${expected}`);
  }
});

test("删除不存在的项目返回 false 而不是抛错", async (t) => {
  const { store } = await fixture(t);
  assert.equal(await store.remove("not-exist"), false);
});

test("创建时名字和想法都为空要报错", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(() => store.create({ name: "", idea: "" }), /至少填一个/);
});