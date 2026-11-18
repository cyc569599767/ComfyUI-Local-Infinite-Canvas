import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createStoryboardStore } from "../src/storyboard-projects.js";

async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "storyboard-store-"));
  t.after(async () => fsp.rm(dir, { recursive: true, force: true }));
  const store = createStoryboardStore({ dataDir: dir });
  await store.load();
  return store;
}

test("分镜项目落盘后重启仍能读回", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "storyboard-persist-"));
  t.after(async () => fsp.rm(dir, { recursive: true, force: true }));
  const first = createStoryboardStore({ dataDir: dir });
  await first.load();
  const saved = await first.save({
    project: { name: "落盘验证", story: "海边日出" },
    shots: [{ id: "shot-1", positive: "海面第一缕光", duration: 6 }],
  });

  // 新实例模拟下次启动：数据必须从磁盘恢复，而不是靠内存。
  const second = createStoryboardStore({ dataDir: dir });
  await second.load();
  const loaded = second.get(saved.id);
  assert.equal(loaded?.project?.name, "落盘验证");
  assert.equal(loaded?.shots?.length, 1);
  assert.equal(loaded?.shots?.[0]?.positive, "海面第一缕光");
});

test("保存时补齐缺失字段并保留创建时间", async (t) => {
  const store = await fixture(t);
  const created = await store.save({ project: { name: "字段补齐" } });
  assert.equal(created.project.story, "");
  assert.equal(created.project.aspect_ratio, "16:9");
  assert.deepEqual(created.shots, []);
  assert.deepEqual(created.characters, []);
  assert.deepEqual(created.story_beats, []);

  const updated = await store.save({ id: created.id, project: { name: "改名" } });
  assert.equal(updated.createdAt, created.createdAt, "createdAt 不能在更新时被覆盖");
  assert.notEqual(updated.updatedAt, "", "updatedAt 必须刷新");
});

test("重复的分镜 id 会被改名而不是丢镜头", async (t) => {
  const store = await fixture(t);
  const saved = await store.save({
    project: { name: "去重" },
    shots: [
      { id: "dup", positive: "第一镜", duration: 3 },
      { id: "dup", positive: "重复 id 的镜头", duration: 4 },
      { id: "unique", positive: "第三镜", duration: 5 },
    ],
  });
  // 镜头不能丢：重复 id 只改名。丢镜头等于吞掉用户的工作，
  // 但 id 重复又会让逐镜编辑同时改到两行，所以必须保证唯一。
  assert.equal(saved.shots.length, 3, "重复 id 不应导致镜头丢失");
  assert.equal(new Set(saved.shots.map((shot) => shot.id)).size, 3, "id 必须唯一");
  assert.equal(saved.shots[1].id, "dup-2", "第二个重复 id 应被改名");
  assert.equal(saved.shots[1].positive, "重复 id 的镜头", "改名不能串内容");
});

test("超出范围的数值被夹到合法区间", async (t) => {
  const store = await fixture(t);
  const saved = await store.save({
    project: { name: "夹值", max_shot_seconds: 999, target_shot_count: -5 },
    shots: [{ id: "s1", positive: "画面", duration: 0 }],
  });
  assert.ok(saved.project.max_shot_seconds <= 60, `max_shot_seconds 应被限制，实际 ${saved.project.max_shot_seconds}`);
  assert.equal(saved.project.target_shot_count, 0);
  assert.ok(saved.shots[0].duration >= 1, "时长至少 1 秒");
});

test("导出 ComfyUI 结构时带上 shot_id 与视频模式", async (t) => {
  const store = await fixture(t);
  const saved = await store.save({
    project: { name: "导出", style: "赛博" },
    characters: [{ id: "char-1", name: "林默" }],
    shots: [{ id: "shot-x", positive: "雨夜", duration: 5, video_mode: "首尾帧" }],
  });
  const board = store.toComfyStoryboard(saved.id);
  assert.ok(board, "导出不应为空");
  assert.equal(board.shots[0].shot_id, "shot-x");
  assert.equal(board.shots[0].video_mode, "首尾帧");
  assert.equal(board.characters.length, 1);
});

test("删除后列表里不再出现", async (t) => {
  const store = await fixture(t);
  const saved = await store.save({ project: { name: "待删除" } });
  assert.equal(await store.remove(saved.id), true);
  assert.equal(store.get(saved.id), null);
  assert.equal(store.list().length, 0);
  // 重复删除要返回 false，让路由能回 404 而不是假装成功。
  assert.equal(await store.remove(saved.id), false);
});