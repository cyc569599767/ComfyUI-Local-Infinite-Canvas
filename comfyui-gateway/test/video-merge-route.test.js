import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createGatewayApp, stopGateway } from "../src/server.js";

process.env.DISABLE_NODE_BOOTSTRAP = "1";

// 这段走真实 ffmpeg：合并的意义就在于「真的产出一个能播放的 mp4」，
// 全桩掉就只剩参数拼接的单元测试，路由层与落库路径没人验证。
function hasFfmpeg() {
  for (const bin of ["ffmpeg", "ffmpeg.exe"]) {
    try {
      execFileSync(bin, ["-version"], { stdio: "ignore", windowsHide: true, shell: false });
      return true;
    } catch {
      // 换下一个候选。
    }
  }
  return false;
}

const FFMPEG = hasFfmpeg();

let tempDir;
let gateway;
let server;
let baseUrl;

async function makeClip(file, { color, seconds, size = "320x180", tone = 440, audio = true, audioSeconds = seconds, videoFilter }) {
  execFileSync(
    "ffmpeg",
    [
      "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=24:d=${seconds}`,
      ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=${tone}:duration=${audioSeconds}`] : []),
      ...(videoFilter ? ["-vf", videoFilter] : []),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "64k",
      file,
    ],
    { windowsHide: true, shell: false, timeout: 60000 },
  );
}

before(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gateway-merge-test-"));
  const dataDir = path.join(tempDir, "data");
  await fsp.mkdir(dataDir, { recursive: true });
  gateway = await createGatewayApp({
    comfyUrl: "http://127.0.0.1:1",
    comfyDir: "",
    comfyFrontendDir: "",
    comfyWorkflowsDir: path.join(tempDir, "workflows"),
    workflowDir: path.join(tempDir, "workflows"),
    desktopDistribution: true,
    scanOnStart: false,
    watchWorkflows: false,
    updateEnabled: false,
    resourcesIndexUrl: "",
    resourcesIndexUrlBackup: "",
    dataDir,
    outputDir: path.join(dataDir, "outputs"),
    publicBaseUrl: "http://127.0.0.1:18199",
    requestTimeoutMs: 15000,
    mergeTimeoutMs: 60000,
    maxUploadBytes: 64 * 1024,
    maxTotalUploadBytes: 128 * 1024,
  });
  server = gateway.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (gateway) await stopGateway(gateway);
  await new Promise((resolve) => server?.close(resolve));
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 等任务跑到终态；网关自己的轮询间隔在这里由测试控制。 */
async function waitTask(id, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${baseUrl}/v1/videos/${id}`);
    const data = await response.json();
    if (["completed", "failed", "cancelled"].includes(data.status)) return data;
    if (Date.now() > deadline) throw new Error(`任务超时：${data.status}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

test("缺少 timeline 时返回 400 而不是 500", async () => {
  const form = new FormData();
  form.append("videos", new Blob([Buffer.from("x")], { type: "video/mp4" }), "a.mp4");
  const response = await fetch(`${baseUrl}/v1/videos/merge`, { method: "POST", body: form });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.error.code, "invalid_timeline");
});

test("缺少视频文件时明确报 missing_input_video", async () => {
  const form = new FormData();
  form.append("timeline", JSON.stringify([{ source: 0, inPoint: 0, outPoint: 1, duration: 1, start: 0, track: 0 }]));
  const response = await fetch(`${baseUrl}/v1/videos/merge`, { method: "POST", body: form });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.error.code, "missing_input_video");
});

function mergeForm(fileCount, { timeline, fileBytes = 16 } = {}) {
  const form = new FormData();
  for (let index = 0; index < fileCount; index += 1) {
    form.append("videos", new Blob([Buffer.alloc(fileBytes, index)], { type: "video/mp4" }), `${index}.mp4`);
  }
  form.append("timeline", JSON.stringify(timeline || Array.from({ length: fileCount }, (_, source) => ({
    source, inPoint: 0, outPoint: 1, duration: 1, start: source, track: 0,
  }))));
  return form;
}

for (const count of [13, 42, 120]) {
  test(`合并路由接收 ${count} 个受控小文件且不截断片段`, async (t) => {
    // 只验证上传和建任务边界，不把占位视频交给 ffmpeg，也不执行模型生成。
    const create = t.mock.method(gateway.tasks, "create", (options) => ({ id: `merge-${count}`, ...options }));
    const enqueue = t.mock.method(gateway.tasks, "enqueue", () => {});
    const response = await fetch(`${baseUrl}/v1/videos/merge`, { method: "POST", body: mergeForm(count) });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.status, "queued");
    assert.equal(data.object, "video");
    assert.equal(data.id, `merge-${count}`);
    assert.equal(create.mock.callCount(), 1);
    assert.equal(create.mock.calls[0].arguments[0].request.clips, count);
    assert.equal(enqueue.mock.callCount(), 1);
  });
}

test("121 个时间线片段在建任务前被拒绝，即使只上传一个素材", async (t) => {
  const create = t.mock.method(gateway.tasks, "create");
  const enqueue = t.mock.method(gateway.tasks, "enqueue", () => {});
  const timeline = Array.from({ length: 121 }, (_, start) => ({ source: 0, duration: 1, start }));
  const response = await fetch(`${baseUrl}/v1/videos/merge`, { method: "POST", body: mergeForm(1, { timeline }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "too_many_clips");
  assert.equal(create.mock.callCount(), 0);
  assert.equal(enqueue.mock.callCount(), 0);
});

test("121 个上传文件被独立合并上传器拒绝", async (t) => {
  const enqueue = t.mock.method(gateway.tasks, "enqueue", () => {});
  const response = await fetch(`${baseUrl}/v1/videos/merge`, {
    method: "POST", body: mergeForm(121, { timeline: [{ source: 0, duration: 1 }] }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "LIMIT_FILE_COUNT");
  assert.equal(enqueue.mock.callCount(), 0);
});

for (const source of [1, 42]) {
  test(`source=${source} 超出上传素材范围时返回 invalid_timeline，不替换为末段`, async (t) => {
    const create = t.mock.method(gateway.tasks, "create");
    const enqueue = t.mock.method(gateway.tasks, "enqueue", () => {});
    const response = await fetch(`${baseUrl}/v1/videos/merge`, {
      method: "POST", body: mergeForm(1, { timeline: [{ source, duration: 1 }] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_timeline");
    assert.equal(create.mock.callCount(), 0);
    assert.equal(enqueue.mock.callCount(), 0);
  });
}

test("42 个文件仍受上传总内存预算保护", async (t) => {
  const enqueue = t.mock.method(gateway.tasks, "enqueue", () => {});
  const response = await fetch(`${baseUrl}/v1/videos/merge`, {
    method: "POST", body: mergeForm(42, { fileBytes: 4 * 1024 }),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "upload_total_too_large");
  assert.equal(enqueue.mock.callCount(), 0);
});

test("合并独立上传器仍保留单文件大小限制", async (t) => {
  const enqueue = t.mock.method(gateway.tasks, "enqueue", () => {});
  const response = await fetch(`${baseUrl}/v1/videos/merge`, {
    method: "POST", body: mergeForm(1, { fileBytes: gateway.config.maxUploadBytes + 1 }),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "LIMIT_FILE_SIZE");
  assert.equal(enqueue.mock.callCount(), 0);
});

for (const [route, limit] of [["/v1/videos/interpolate", 12], ["/v1/videos", 15]]) {
  test(`${route} 的 ${limit} 文件限制不随合并上限放宽`, async () => {
    const response = await fetch(`${baseUrl}${route}`, { method: "POST", body: mergeForm(limit + 1) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "LIMIT_FILE_COUNT");
  });
}

test("合并两段素材后能从 /content 取回可播放的 mp4", { skip: !FFMPEG }, async () => {
  const first = path.join(tempDir, "a.mp4");
  const second = path.join(tempDir, "b.mp4");
  await makeClip(first, { color: "red", seconds: 1, tone: 440 });
  await makeClip(second, { color: "blue", seconds: 1.5, tone: 660 });

  const form = new FormData();
  form.append("videos", new Blob([await fsp.readFile(first)], { type: "video/mp4" }), "a.mp4");
  form.append("videos", new Blob([await fsp.readFile(second)], { type: "video/mp4" }), "b.mp4");
  // 只取第二段的前 0.5 秒：验证 trim 真的生效。
  form.append("timeline", JSON.stringify([
    { source: 0, inPoint: 0, outPoint: 1, duration: 1, start: 0, track: 0, volume: 1 },
    { source: 1, inPoint: 0.2, outPoint: 0.7, duration: 1.5, start: 1, track: 0, volume: 1 },
  ]));
  form.append("total_seconds", "1.5");

  const created = await fetch(`${baseUrl}/v1/videos/merge`, { method: "POST", body: form });
  assert.equal(created.status, 200);
  const task = await created.json();
  assert.equal(task.object, "video");
  assert.equal(task.status, "queued");

  const done = await waitTask(task.id);
  assert.equal(done.status, "completed", done.error?.message);
  assert.ok(done.url);

  const content = await fetch(`${baseUrl}/v1/videos/${task.id}/content`);
  assert.equal(content.status, 200);
  assert.match(content.headers.get("content-type") || "", /video\/mp4/);
  const bytes = Buffer.from(await content.arrayBuffer());
  // 必须是真实的 mp4（ftyp box），而不是空文件或错误 JSON。
  assert.ok(bytes.length > 1000);
  assert.equal(bytes.subarray(4, 8).toString(), "ftyp");

  // 1.0s + 0.5s ≈ 1.5s；片头片尾有编码容差，只校验量级而不是精确值。
  const probe = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", "-"],
    { input: bytes, windowsHide: true, shell: false, encoding: "utf8" },
  );
  const duration = Number(JSON.parse(probe).format?.duration) || 0;
  assert.ok(duration > 1.2 && duration < 2.2, `成片时长 ${duration}s 不在预期范围`);
});

async function mergeClips(files, timeline, outputName) {
  const form = new FormData();
  for (const file of files) {
    form.append("videos", new Blob([await fsp.readFile(file)], { type: "video/mp4" }), path.basename(file));
  }
  form.append("timeline", JSON.stringify(timeline));
  const response = await fetch(`${baseUrl}/v1/videos/merge`, { method: "POST", body: form });
  assert.equal(response.status, 200);
  const task = await response.json();
  const done = await waitTask(task.id);
  assert.equal(done.status, "completed", done.error?.message);
  const content = await fetch(`${baseUrl}/v1/videos/${task.id}/content`);
  assert.equal(content.status, 200);
  const output = path.join(tempDir, outputName);
  await fsp.writeFile(output, Buffer.from(await content.arrayBuffer()));
  return output;
}

function assertDuration(file, expected) {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], {
    encoding: "utf8", windowsHide: true, shell: false,
  }));
  const duration = Number(probe.format.duration);
  assert.ok(Math.abs(duration - expected) < 0.06, `成片时长 ${duration}s，预期 ${expected}s`);
}

function pixelAt(file, time, x = 160, y = 90) {
  const frame = execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { windowsHide: true, shell: false, maxBuffer: 1024 * 1024 });
  const offset = (y * 320 + x) * 3;
  assert.ok(frame.length > offset + 2, `在 ${time}s 未读到视频帧`);
  return [...frame.subarray(offset, offset + 3)];
}

function audioRms(file, time) {
  const samples = execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(time), "-i", file, "-t", "0.2", "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1",
  ], { windowsHide: true, shell: false, maxBuffer: 1024 * 1024 });
  assert.ok(samples.length > 30000, `在 ${time}s 未读到完整音频`);
  let squares = 0;
  for (let index = 0; index < samples.length; index += 4) squares += samples.readFloatLE(index) ** 2;
  return Math.sqrt(squares / (samples.length / 4));
}

for (const sameTrack of [false, true]) {
  test(`真实 ffmpeg ${sameTrack ? "同轨 layer" : "上方轨道"}遮挡输出红→蓝→红，恢复偏移并切换音频与静音`, { skip: !FFMPEG }, async () => {
    const red = path.join(tempDir, `red-${sameTrack}.mp4`);
    const blue = path.join(tempDir, `blue-${sameTrack}.mp4`);
    await makeClip(red, {
      color: "red", seconds: 4.5,
      // 只在素材 2.5 秒以后画角标，恢复后可据此辨别是否错误地从入点重播。
      videoFilter: "drawbox=x=0:y=0:w=24:h=24:color=yellow:t=fill:enable='gte(t,2.5)'",
    });
    await makeClip(blue, { color: "blue", seconds: 1.5, audio: false });
    const output = await mergeClips([red, blue], [
      // 高 layer 放在前面，若路由丢失 layer 就会被后面的红色镜头遮住。
      { source: 1, start: 1, inPoint: 0.25, outPoint: 1.25, track: 0, layer: 9 },
      { source: 0, start: 0, inPoint: 0.5, outPoint: 4.5, track: sameTrack ? 0 : 1, layer: 1 },
      { source: 1, start: 0.5, inPoint: 0, outPoint: 1, track: 2, layer: 999 },
    ], `overlap-${sameTrack}.mp4`);
    assertDuration(output, 4);
    for (const time of [0.25, 2.5, 3.5]) {
      const [redChannel, greenChannel, blueChannel] = pixelAt(output, time);
      assert.ok(redChannel > 200 && greenChannel < 30 && blueChannel < 30, `${time}s 应为红底`);
      assert.ok(audioRms(output, time) > 0.025, `${time}s 应恢复红底音频`);
    }
    const [redChannel, greenChannel, blueChannel] = pixelAt(output, 1.5);
    assert.ok(blueChannel > 200 && redChannel < 30 && greenChannel < 30, "遮挡期间应为蓝色");
    assert.ok(audioRms(output, 1.4) < 0.001, "无音轨的可见镜头必须静音，不能混入下层声音");
    const marker = pixelAt(output, 2.5, 10, 10);
    assert.ok(marker[0] > 180 && marker[1] > 180 && marker[2] < 50, "恢复必须取原素材 3 秒处，不能从 0.5 秒入点重播");
  });
}

test("真实 ffmpeg 起始与中间空隙补黑场静音，短音轨补齐且不拖动后续画面", { skip: !FFMPEG }, async () => {
  const red = path.join(tempDir, "short-audio.mp4");
  const blue = path.join(tempDir, "gap-blue.mp4");
  await makeClip(red, { color: "red", seconds: 3, audioSeconds: 0.4 });
  await makeClip(blue, { color: "blue", seconds: 0.5, audio: false });
  const output = await mergeClips([red, blue], [
    { source: 0, start: 0.5, inPoint: 0, outPoint: 1.5, track: 1 },
    { source: 1, start: 1, inPoint: 0, outPoint: 0.5, track: 0 },
    { source: 1, start: 2.5, inPoint: 0, outPoint: 0.5, track: 0 },
  ], "gap-short-audio.mp4");
  assertDuration(output, 3);
  for (const time of [0.1, 2.1]) {
    assert.ok(pixelAt(output, time).every((channel) => channel < 15), `${time}s 空隙应为黑场`);
    assert.ok(audioRms(output, time) < 0.001, `${time}s 空隙应为静音`);
  }
  assert.ok(audioRms(output, 0.55) > 0.025, "短音轨开头应正常播放");
  assert.ok(audioRms(output, 1.6) < 0.001, "恢复区间的源音轨已结束，仍需补齐静音");
  assert.ok(pixelAt(output, 1.75)[0] > 200, "遮挡结束应恢复红色画面");
  assert.ok(pixelAt(output, 2.75)[2] > 200, "音轨补齐不能改变后续蓝色画面的时间");
});

test("真实时长裁剪后入点越界的任务明确失败", { skip: !FFMPEG }, async () => {
  const source = path.join(tempDir, "invalid-inpoint.mp4");
  await makeClip(source, { color: "red", seconds: 1 });
  const form = new FormData();
  form.append("videos", new Blob([await fsp.readFile(source)], { type: "video/mp4" }), "invalid-inpoint.mp4");
  form.append("timeline", JSON.stringify([{ source: 0, start: 0, inPoint: 2, outPoint: 3 }]));
  const response = await fetch(`${baseUrl}/v1/videos/merge`, { method: "POST", body: form });
  assert.equal(response.status, 200);
  const task = await response.json();
  const done = await waitTask(task.id);
  assert.equal(done.status, "failed");
  assert.match(done.error.message, /入点.*实际时长/);
});

test("同一素材被裁成两段时只上传一次也能拼", { skip: !FFMPEG }, async () => {
  const source = path.join(tempDir, "c.mp4");
  await makeClip(source, { color: "green", seconds: 2 });

  const form = new FormData();
  form.append("videos", new Blob([await fsp.readFile(source)], { type: "video/mp4" }), "c.mp4");
  form.append("timeline", JSON.stringify([
    { source: 0, inPoint: 0, outPoint: 0.5, duration: 2, start: 0, track: 0, volume: 1 },
    { source: 0, inPoint: 1.2, outPoint: 1.7, duration: 2, start: 0.5, track: 0, volume: 1 },
  ]));

  const created = await fetch(`${baseUrl}/v1/videos/merge`, { method: "POST", body: form });
  assert.equal(created.status, 200);
  const task = await created.json();
  const done = await waitTask(task.id);
  assert.equal(done.status, "completed", done.error?.message);

  const content = await fetch(`${baseUrl}/v1/videos/${task.id}/content`);
  const bytes = Buffer.from(await content.arrayBuffer());
  assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
});
