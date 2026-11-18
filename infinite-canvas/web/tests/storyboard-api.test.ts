import { afterAll, expect, test } from "bun:test";
import type { AiConfig } from "../src/stores/use-config-store";

/**
 * 导演台的错误提示必须能指路。
 *
 * 后端把「云端 API 失败：Not found: POST /v1/chat/completions」写在 body.error.message，
 * axios 默认只抛「Request failed with status code 502」。用户看到后者没法判断是
 * 模型配置错了、网关没起来，还是网关自身崩了。
 */

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
});

const { breakdownStoryboard, listStoryboardProjects } = await import("../src/services/api/storyboard");

type Behaviour = { status: number; body: unknown } | "network" | "timeout";
let behaviour: Behaviour = { status: 200, body: { projects: [] } };

const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
        if (behaviour === "network") return Response.error();
        if (behaviour === "timeout") {
            // 模拟超时：拖过 axios 的 timeout 仍不返回。
            await new Promise((resolve) => setTimeout(resolve, 60000));
            return Response.json({});
        }
        return Response.json(behaviour.body, { status: behaviour.status });
    },
});

afterAll(() => {
    server.stop(true);
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const config = { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "test", apiFormat: "openai", model: "fixture" } as AiConfig;

test("网关返回的结构化错误被原样透出，而不是 axios 的通用文案", async () => {
    behaviour = { status: 502, body: { error: { message: "云端 API 失败：Not found: POST /v1/chat/completions", code: "cloud_api_failed" } } };
    const error = await breakdownStoryboard(config, { story: "雨夜等车" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("云端 API 失败：Not found: POST /v1/chat/completions");
    // 关键断言：不能退化成 axios 的原话，那句话对用户没有任何指导意义。
    expect((error as Error).message).not.toContain("status code");
});

test("网关连不上时提示检查网关，而不是抛网络原文", async () => {
    // 用一个没有人监听的端口制造真实的连接失败：Bun 的 Response.error()
    // 仍然会走 HTTP 响应路径，测不出「连不上」这条分支。
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = closed.port;
    closed.stop(true);
    const offline = { ...config, baseUrl: `http://127.0.0.1:${port}/v1` } as AiConfig;
    const error = await listStoryboardProjects(offline).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("连不上本地网关，请确认网关正在运行");
});

test("没有 error.message 的响应仍会退回到 axios 的可读描述", async () => {
    behaviour = { status: 500, body: { ok: false } };
    const error = await listStoryboardProjects(config).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("500");
});

test("非本机网关地址被明确拒绝", async () => {
    const remote = { ...config, baseUrl: "https://api.example.com/v1" } as AiConfig;
    const error = await listStoryboardProjects(remote).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("本地网关");
});