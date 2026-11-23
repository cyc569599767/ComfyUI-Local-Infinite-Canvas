// 角色替换的源视频就是「当前视频节点自己的内容」。
//
// 现场：视频节点上有视频，选「H3 角色替换」提交，却报
// 「ref_videos 需要至少 1 张视频，但当前视频数 0」。
// 因为 referenceVideos 只从上游连线收集，不含节点自身。
import { expect, test } from "bun:test";

import { needsSelfSourceVideo, withSelfSourceVideo } from "../src/lib/canvas/self-source-video";

const vid = (id: string) => ({ id, url: `blob:${id}` });

test("角色替换需要自身视频", () => {
  expect(needsSelfSourceVideo("video-h3-character-swap", "reference")).toBe(true);
});

test("Viggle 换人也要自身视频", () => {
  expect(needsSelfSourceVideo("video-h3-viggle-swap", "swap")).toBe(true);
});

test("Viggle 编辑档同样需要", () => {
  expect(needsSelfSourceVideo("video-h3-viggle-swap", "edit")).toBe(true);
});

test("普通文生/首尾帧不补自身视频（避免塞进多余素材）", () => {
  expect(needsSelfSourceVideo("video-h3-t2v", "text")).toBe(false);
  expect(needsSelfSourceVideo("video-h3-frames", "frames")).toBe(false);
  expect(needsSelfSourceVideo("video-h3-fast", "frames")).toBe(false);
});

test("节点自身有视频时补进去（现场场景）", () => {
  const out = withSelfSourceVideo([], "video-h3-character-swap", "reference", vid("self"));
  expect(out.length).toBe(1);
  expect(out[0].id).toBe("self");
});

test("自身没有视频时不凭空造素材", () => {
  const out = withSelfSourceVideo([], "video-h3-character-swap", "reference", null);
  expect(out.length).toBe(0);
});

test("已在上游列表里的自身视频不重复添加", () => {
  const self = vid("self");
  const out = withSelfSourceVideo([self], "video-h3-character-swap", "reference", self);
  expect(out.length).toBe(1);
});

test("自身与上游同时存在时只保留一个，自身优先", () => {
  const out = withSelfSourceVideo([vid("upstream")], "video-h3-character-swap", "reference", vid("self"));
  expect(out.length).toBe(1);
  expect(out[0].id).toBe("self");
});

test("非源视频工作流不会把自身视频塞进请求", () => {
  const out = withSelfSourceVideo([], "video-h3-t2v", "text", vid("self"));
  expect(out.length).toBe(0);
});
