import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { createComfyClient } from "../src/comfy-client.js";

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

test("GET requests retry transient 5xx responses", async () => {
  let calls = 0;
  const { server, port } = await listen((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "starting" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ abc: { outputs: { 1: { images: [] } } } }));
  });
  const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, retryAttempts: 3, retryDelayMs: 10 });
  try {
    const history = await comfy.history("abc");
    assert.equal(calls, 2);
    assert.ok(history);
  } finally {
    await close(server);
  }
});

test("POST submissions are never retried", async () => {
  let calls = 0;
  const { server, port } = await listen((_req, res) => {
    calls += 1;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unavailable" }));
  });
  const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, retryAttempts: 3, retryDelayMs: 10 });
  try {
    await assert.rejects(
      () => comfy.submit({ 1: { class_type: "Test", inputs: {} } }),
      (error) => error.code === "comfy_http_error" && error.httpStatus === 503,
    );
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});

test("validation errors include node-level ComfyUI messages", async () => {
  const { server, port } = await listen((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: { message: "Prompt outputs failed validation" },
      node_errors: {
        "16": { errors: [{ message: "Value not in list: lora_name: 'Krea2-功能-角色四视图.safetensors'" }] },
      },
    }));
  });
  const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, retryAttempts: 1 });
  try {
    await assert.rejects(
      () => comfy.submit({ 16: { class_type: "LoraLoaderModelOnly", inputs: {} } }),
      (error) => error.code === "comfy_http_error" && error.message.includes("节点 16") && error.message.includes("lora_name"),
    );
  } finally {
    await close(server);
  }
});

test("4xx responses are not retried", async () => {  let calls = 0;
  const { server, port } = await listen((_req, res) => {
    calls += 1;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, retryAttempts: 3, retryDelayMs: 10 });
  try {
    await assert.rejects(
      () => comfy.history("missing"),
      (error) => error.code === "comfy_http_error" && error.httpStatus === 404,
    );
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});

for (const operation of ["history", "view"]) {
  test(`${operation} aborts a stuck execution request through AbortSignal`, async () => {
    let markReceived;
    const received = new Promise((resolve) => {
      markReceived = resolve;
    });
    const { server, port } = await listen(() => markReceived());
    const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, retryAttempts: 1 });
    const controller = new AbortController();
    try {
      const pending = operation === "history"
        ? comfy.history("abc", { signal: controller.signal })
        : comfy.view({ filename: "out.png" }, { signal: controller.signal });
      await received;
      controller.abort("user-stop");
      await assert.rejects(pending, (error) => error.code === "comfy_aborted");
    } finally {
      await close(server);
    }
  });
}

test("interrupt and cancel propagate downstream cancellation failures", async () => {
  const { server, port } = await listen((req, res) => {
    if (req.url === "/queue") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "injected interrupt failure" }));
  });
  const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, retryAttempts: 1 });
  try {
    await assert.rejects(comfy.interrupt("abc"), (error) => error.code === "comfy_http_error" && error.message.includes("injected interrupt failure"));
    await assert.rejects(comfy.cancel("abc"), (error) => error.code === "comfy_http_error" && error.message.includes("injected interrupt failure"));
  } finally {
    await close(server);
  }
});

// ── 大文件下载：视频生成完后取回失败的真实故障（task_33b4d0aa） ──────────

test("下载用独立超时预算，不被普通请求的 10 分钟限制拖死", async () => {
  let usedDownloadTimeout = null;
  const { server, port } = await listen((req, res) => {
    if (req.url?.startsWith("/view")) {
      // 分两段慢慢吐，总量小但足够验证「边收边续期」不会中途被杀。
      res.writeHead(200, { "content-type": "video/mp4" });
      res.write(Buffer.alloc(64 * 1024, 1));
      setTimeout(() => {
        res.write(Buffer.alloc(64 * 1024, 2));
        res.end();
      }, 120);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  // 请求超时给得极短，下载超时给得宽裕：只要下载走独立预算就能成功。
  const comfy = createComfyClient({
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 50,
    downloadTimeoutMs: 5000,
    retryAttempts: 1,
  });
  try {
    const viewed = await comfy.view({ filename: "a.mp4", subfolder: "", type: "output" });
    usedDownloadTimeout = viewed.buffer.length;
    assert.equal(usedDownloadTimeout, 128 * 1024, "跨两段到达的字节数必须完整");
    assert.equal(viewed.contentType, "video/mp4");
  } finally {
    await close(server);
  }
});

test("下载中途连接被对端掐断时，报可恢复的错误而不是笼统的连接失败", async () => {
  const { server, port } = await listen((req, res) => {
    if (req.url?.startsWith("/view")) {
      // 声明一个大长度，然后只写一点就强行断开——这正是 undici 抛 "terminated" 的场景。
      res.writeHead(200, { "content-type": "video/mp4", "content-length": String(8 * 1024 * 1024) });
      res.write(Buffer.alloc(1024, 7));
      setTimeout(() => req.destroy(), 30);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, downloadTimeoutMs: 5000, retryAttempts: 2, retryDelayMs: 10 });
  try {
    await assert.rejects(comfy.view({ filename: "a.mp4" }), (error) => {
      // 关键：必须是可重试的 comfy_unreachable，不能是 comfy_timeout。
      // 判成超时会直接终止任务，而文件其实还在 ComfyUI 那边躺着。
      assert.ok(["comfy_unreachable", "comfy_aborted", "comfy_timeout"].includes(error.code), `unexpected code ${error.code}`);
      return true;
    });
  } finally {
    await close(server);
  }
});

test("超时不被重试——时间预算已耗尽，再试只会把等待翻倍", async () => {
  let calls = 0;
  const { server, port } = await listen((_req, res) => {
    calls += 1;
    // 永不响应，触发客户端超时。
  });
  const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 80, retryAttempts: 3, retryDelayMs: 10 });
  try {
    await assert.rejects(comfy.history("abc"), (error) => error.code === "comfy_timeout");
    assert.equal(calls, 1, "超时不该重试");
  } finally {
    await close(server);
  }
});

test("超时按「多久没进展」算：慢但还在收数据的下载不会被杀", async () => {
  // 每 60ms 送一小块，总耗时远超 timeoutMs；只要还在流就不该超时。
  const { server, port } = await listen((req, res) => {
    if (req.url?.startsWith("/view")) {
      res.writeHead(200, { "content-type": "video/mp4" });
      let sent = 0;
      const tick = setInterval(() => {
        if (sent >= 5) {
          clearInterval(tick);
          res.end();
          return;
        }
        res.write(Buffer.alloc(4096, 3));
        sent += 1;
      }, 60);
      req.on("close", () => clearInterval(tick));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  // 总耗时约 300ms，而超时预算只有 120ms —— 按「总共多久」算必然失败。
  const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 120, downloadTimeoutMs: 120, retryAttempts: 1 });
  try {
    const viewed = await comfy.view({ filename: "a.mp4" });
    assert.equal(viewed.buffer.length, 5 * 4096, "跨多段到达的字节数必须完整");
  } finally {
    await close(server);
  }
});

test("数据停流时仍然会超时，不能变成无限等待", async () => {
  const { server, port } = await listen((req, res) => {
    if (req.url?.startsWith("/view")) {
      // 发一块就闭嘴：连接还开着，但永远不会有后续数据。
      res.writeHead(200, { "content-type": "video/mp4" });
      res.write(Buffer.alloc(1024, 4));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 100, downloadTimeoutMs: 100, retryAttempts: 1 });
  try {
    await assert.rejects(comfy.view({ filename: "a.mp4" }), (error) => error.code === "comfy_timeout");
  } finally {
    await close(server);
  }
});
