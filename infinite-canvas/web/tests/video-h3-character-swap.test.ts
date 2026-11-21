// H3 角色替换（video-h3-character-swap）入参与额度校验。
//
// 该工作流走 Ref2VA + Character Swap LoRA，额度是 6 图 / 1 源视频 / 2 音频。
// 本文件锁定两条底线：
//   1. 额度内的请求正常发出，且参数与模式符合换人语义（强制 reference）；
//   2. 超限必须抛错拒绝，不能静默截断——静默截断会让用户以为第 7 张角色参考
//      也参与了换人，出片后才发现换错了人。
import { afterAll, expect, test } from "bun:test";
import type { AiConfig, ChannelModel } from "../src/stores/use-config-store";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
});

const { defaultConfig } = await import("../src/stores/use-config-store");
const { createVideoGenerationTask } = await import("../src/services/api/video");

const requests: FormData[] = [];
const requestPaths: string[] = [];
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
        requestPaths.push(new URL(req.url).pathname);
        requests.push(await req.formData());
        return Response.json({ id: "fixture-task", status: "queued" });
    },
});
afterAll(() => {
    server.stop(true);
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const models: ChannelModel[] = [{ name: "video-h3-character-swap", workflowId: "video-h3-character-swap", capability: "video" }];
const config: AiConfig = {
    ...defaultConfig,
    videoMode: "reference",
    size: "1280x720",
    vquality: "720",
    videoSeconds: "5",
    referenceAcceleration: false,
    channels: [{ id: "fixture", name: "Fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "test", apiFormat: "openai", models }],
};
const swapConfig: AiConfig = { ...config, model: "fixture::video-h3-character-swap", videoModel: "fixture::video-h3-character-swap" };

const pic = (n: number) => ({
    id: `ref-${n}`,
    name: `char${n}.png`,
    type: "image/png",
    dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII=",
});
const vid = (n: number) => ({ id: `v-${n}`, name: `src${n}.mp4`, type: "video/mp4", url: "data:video/mp4;base64,AAAAHGZ0eXBpc29t", durationMs: 4000 });
const aud = (n: number) => ({ id: `a-${n}`, name: `track${n}.wav`, type: "audio/wav", url: "data:audio/wav;base64,UklGRiQAAABXQVZF" });

test("额度内：6 图 + 1 源视频 + 2 音频正常提交", async () => {
    const before = requests.length;
    await createVideoGenerationTask(swapConfig, "把视频里的人换成图中的角色", [pic(1), pic(2), pic(3), pic(4), pic(5), pic(6)], {
        videos: [vid(1)],
        audios: [aud(1), aud(2)],
    });
    expect(requests.length).toBe(before + 1);
    expect(requestPaths.at(-1)).toBe("/v1/videos");
    const body = requests.at(-1)!;
    // 非 creationH3 工作流用带方括号的重复字段名，后端按数组收集。
    expect(body.getAll("image[]")).toHaveLength(6);
    expect(body.getAll("video[]")).toHaveLength(1);
    expect(body.getAll("audio[]")).toHaveLength(2);
    // 换人必须走全参考模式，否则 LoRA 拿不到源视频。
    expect(String(body.get("mode"))).toBe("reference");
    expect(String(body.get("model"))).toBe("video-h3-character-swap");
    // 源视频时长要一起带上：后端靠它算帧数，探不到视频时用它兜底。
    expect(Number(body.get("source_duration_seconds"))).toBeGreaterThan(0);
});

test("最小额度：1 图 + 1 源视频即可提交", async () => {
    const before = requests.length;
    await createVideoGenerationTask(swapConfig, "替换角色", [pic(1)], { videos: [vid(1)] });
    expect(requests.length).toBe(before + 1);
    const body = requests.at(-1)!;
    expect(body.getAll("image[]")).toHaveLength(1);
    expect(body.getAll("video[]")).toHaveLength(1);
});

test("超限 7 张参考图必须报错，不能静默截断", async () => {
    const before = requests.length;
    await expect(
        createVideoGenerationTask(swapConfig, "替换角色", [pic(1), pic(2), pic(3), pic(4), pic(5), pic(6), pic(7)], { videos: [vid(1)] }),
    ).rejects.toThrow(/超出参入上限|7 张参考图/);
    // 关键：报错时不能已经把请求发出去。
    expect(requests.length).toBe(before);
});

test("超限 2 段源视频必须报错", async () => {
    const before = requests.length;
    await expect(createVideoGenerationTask(swapConfig, "替换角色", [pic(1)], { videos: [vid(1), vid(2)] })).rejects.toThrow(/源视频/);
    expect(requests.length).toBe(before);
});

test("超限 3 段音频必须报错", async () => {
    const before = requests.length;
    await expect(
        createVideoGenerationTask(swapConfig, "替换角色", [pic(1)], { videos: [vid(1)], audios: [aud(1), aud(2), aud(3)] }),
    ).rejects.toThrow(/音频/);
    expect(requests.length).toBe(before);
});

test("报错文案要指明是哪一类超限，方便用户只删多余的那几个", async () => {
    const error = await createVideoGenerationTask(swapConfig, "替换角色", [pic(1), pic(2), pic(3), pic(4), pic(5), pic(6), pic(7)], { videos: [vid(1)] }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(Error);
    const message = String((error as Error).message);
    // 只说「超出上限」不够，必须点出是图片超了、上限是 6。
    expect(message).toContain("7 张参考图");
    expect(message).toContain("上限 6");
});
