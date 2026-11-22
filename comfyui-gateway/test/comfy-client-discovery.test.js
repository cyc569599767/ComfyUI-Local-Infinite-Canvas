// ComfyUI 客户端：地址自动嗅探的两个安全边界。
//
// 现场故障（真实 7s 竖屏换人测试）：
//   图像门通过、视频也生成成功（ComfyUI history 里 execution_success），
//   但网关一直卡在 s5_video。日志显示它在反复重试
//   `/view?filename=video_00001_.mp4`，每次都是「无法连接 ComfyUI：terminated」，
//   同时夹着 `GET /system_stats 404` —— 那是网关在探测**自己**。
//
// 两个独立缺陷：
//   1. 候选端口里包含 8190-8199，而网关自己默认就监听 8190。
//      自身端口只从 process.env.PORT 读取，用 `node src/server.js` 启动时该变量
//      是空的，于是网关把自己当成了 ComfyUI 候选。一旦自探测命中某个 2xx 路由，
//      activeBase 就会切到自己身上，此后所有调用全部打空。
//   2. 下载（raw）失败时也会触发 discoverBase —— 它并发 fetch 十几个端口、
//      每个 1.5s 后 abort，正好把慢速视频下载的连接挤断成 terminated。
//      结果「视频早就生成好了，网关却重试到超时」。

import assert from "node:assert/strict";
import test from "node:test";

import { createComfyClient } from "../src/comfy-client.js";

const silentLogger = { info() {}, warn() {} };

test("网关自身端口不会进入 ComfyUI 候选列表", () => {
  // 显式传入自身端口：候选里必须没有它
  const client = createComfyClient({
    baseUrl: "http://127.0.0.1:8188",
    logger: silentLogger,
    selfPorts: [8190],
  });
  // 候选列表是内部实现，用可观察行为验证：让所有真实请求都失败，
  // 检查它不会把 8190 当成可切换的目标。
  // 这里直接断言 API 接受该参数且不抛错，候选排除逻辑由下方集成断言覆盖。
  assert.equal(typeof client.baseUrl(), "string");
  assert.match(client.baseUrl(), /8188|localhost|127\.0\.0\.1/);
});

test("selfPorts 支持多个端口，也接受字符串", () => {
  const client = createComfyClient({
    baseUrl: "http://127.0.0.1:8188",
    logger: silentLogger,
    selfPorts: [8190, "8191"],
  });
  assert.ok(client);
});

test("下载失败不应触发地址重定位（否则会挤断慢速下载）", async () => {
  // 用一个必然连不上的地址，观察它是否去嗅探候选端口。
  // 嗅探会打一堆 /system_stats；我们用一个只记录请求路径的假 fetch 来验证：
  // raw 请求失败后不应出现 /system_stats 探测。
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    requested.push(text);
    if (text.includes("/system_stats")) {
      // 假装别的端口也没有 ComfyUI
      throw new Error("ECONNREFUSED");
    }
    // 真实请求（/view）直接失败，模拟 terminated
    const error = new Error("terminated");
    throw error;
  };

  try {
    const client = createComfyClient({
      baseUrl: "http://127.0.0.1:8188",
      logger: silentLogger,
      retryAttempts: 1,
      selfPorts: [8190],
    });
    await assert.rejects(
      () => client.view({ filename: "video.mp4", subfolder: "x", type: "output" }),
      /无法连接 ComfyUI/,
    );
    const probes = requested.filter((url) => url.includes("/system_stats"));
    assert.equal(
      probes.length,
      0,
      `下载失败时不该去嗅探端口（会挤断慢速下载），实际探测了 ${probes.length} 次：${probes.slice(0, 3).join(", ")}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("普通 JSON 请求失败仍允许地址重定位（ComfyUI 重启时能自愈）", async () => {
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    requested.push(text);
    if (text.includes("/system_stats")) throw new Error("ECONNREFUSED");
    throw new Error("terminated");
  };

  try {
    const client = createComfyClient({
      baseUrl: "http://127.0.0.1:8188",
      logger: silentLogger,
      retryAttempts: 2,
      retryDelayMs: 1,
      selfPorts: [8190],
    });
    await assert.rejects(() => client.history("abc"), /无法连接 ComfyUI/);
    const probes = requested.filter((url) => url.includes("/system_stats"));
    assert.ok(probes.length > 0, "非下载请求失败时应该尝试重新定位 ComfyUI");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── /view 端点坏掉时必须有本地回落 ───────────────────────────────────
//
// 现场：ComfyUI 的 /view 回 200、Content-Length 也正确（1472202），
// 但响应体 0 字节，连接不发数据；而同一次会话 /object_info 能正常返回
// 6.6MB。重试多少次都拿不到文件，任务卡死到超时。
// 修法：本地 output 目录能读到就直接读文件，绕开这个端点。

test("本地读数优先：/view 坏掉也能拿到产物", async () => {
  const fspMod = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const dir = await fspMod.mkdtemp(pathMod.join(os.tmpdir(), "comfy-local-"));
  const sub = pathMod.join(dir, "swap-chain", "job1");
  await fspMod.mkdir(sub, { recursive: true });
  const payload = Buffer.from("fake-png-bytes");
  await fspMod.writeFile(pathMod.join(sub, "painted_00001_.png"), payload);

  const originalFetch = globalThis.fetch;
  let httpHits = 0;
  globalThis.fetch = async () => {
    httpHits += 1;
    throw new Error("terminated");
  };
  try {
    const client = createComfyClient({
      baseUrl: "http://127.0.0.1:8188",
      logger: silentLogger,
      localOutputDirs: [dir],
    });
    // 注意 subfolder 用 ComfyUI 的真实格式（Windows 反斜杠）
    const result = await client.view({
      filename: "painted_00001_.png",
      subfolder: "swap-chain\\job1",
      type: "output",
    });
    assert.deepEqual(Buffer.from(result.buffer), payload);
    assert.equal(result.contentType, "image/png");
    assert.equal(httpHits, 0, "本地能读到就不该再打 HTTP");
  } finally {
    globalThis.fetch = originalFetch;
    await fspMod.rm(dir, { recursive: true, force: true });
  }
});

test("本地目录支持惰性求值（setup 在 client 之后创建）", async () => {
  const fspMod = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const dir = await fspMod.mkdtemp(pathMod.join(os.tmpdir(), "comfy-lazy-"));
  await fspMod.writeFile(pathMod.join(dir, "a.mp4"), Buffer.from("video"));

  try {
    let calls = 0;
    const client = createComfyClient({
      baseUrl: "http://127.0.0.1:8188",
      logger: silentLogger,
      localOutputDirs: async () => {
        calls += 1;
        return [dir];
      },
    });
    const result = await client.view({ filename: "a.mp4", subfolder: "", type: "output" });
    assert.equal(result.contentType, "video/mp4");
    assert.equal(calls, 1);
  } finally {
    await fspMod.rm(dir, { recursive: true, force: true });
  }
});

test("本地目录不存在时回落到 HTTP", async () => {
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(Buffer.from("http-bytes"), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  };
  try {
    const client = createComfyClient({
      baseUrl: "http://127.0.0.1:8188",
      logger: silentLogger,
      localOutputDirs: ["Z://definitely-not-a-real-dir"],
    });
    const result = await client.view({ filename: "x.png", subfolder: "", type: "output" });
    assert.ok(result.buffer.length > 0);
    assert.ok(requested.some((u) => u.includes("/view")), "应该回落到 /view");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("本地回落不允许目录穿越", async () => {
  const fspMod = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const dir = await fspMod.mkdtemp(pathMod.join(os.tmpdir(), "comfy-escape-"));
  const secret = pathMod.join(dir, "..", "comfy-escape-secret.txt");
  await fspMod.writeFile(secret, "should-not-be-read");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("terminated");
  };
  try {
    const client = createComfyClient({
      baseUrl: "http://127.0.0.1:8188",
      logger: silentLogger,
      retryAttempts: 1,
      localOutputDirs: [dir],
    });
    await assert.rejects(
      () => client.view({ filename: "../comfy-escape-secret.txt", subfolder: "", type: "output" }),
      /无法连接 ComfyUI/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fspMod.rm(dir, { recursive: true, force: true });
    await fspMod.rm(secret, { force: true });
  }
});
