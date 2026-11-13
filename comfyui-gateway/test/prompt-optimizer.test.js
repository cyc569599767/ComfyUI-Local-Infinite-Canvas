import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptOptimizer } from "../src/prompt-optimizer.js";
import h3ObjectInfo from "./fixtures/h3-prompt-object-info.json" with { type: "json" };

process.env.ALLOW_PRIVATE_CLOUD = "1";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REF_OUTPUT = `思考过程:
这里不应该出现在结果里。

subject_definitions:

<Subject 1> is the replacement character in <Picture 1>.
<Video 1> is the source video.

summary:

Replace the target person in <Video 1> with <Subject 1>.

retention_analysis:

<Subject 1>: fully_preserved.
<Video 1>: partially_preserved.

detailed_description:

[Shot 1] Keep the original action and camera.

overall_soundscape:

Street ambience.

non_diegetic_music:

No added music.`;

test("local H3 optimize keeps all full-reference sections", async () => {
    const optimizer = createPromptOptimizer({
        config: { rootDir },
        comfy: {
            objectInfo: async () => structuredClone(h3ObjectInfo),
            submit: async () => ({ promptId: "test-prompt" }),
            history: async () => ({ status: { completed: true }, outputs: { "4": { text: [REF_OUTPUT] } } }),
        },
        logger: null,
    });
    const result = await optimizer.optimize({
        prompt: "replace the dancer with the character in the image",
        mode: "全参考模式(Reference to Video)",
        duration: 5,
        uploadedImages: [{ name: "character.png" }],
        engine: "local",
    });
    assert.match(result.prompt, /^subject_definitions:/);
    assert.match(result.prompt, /retention_analysis:/);
    assert.match(result.prompt, /detailed_description:/);
    assert.doesNotMatch(result.prompt, /思考过程/);
});

test("cloud H3 optimize uses the full-reference prompt for reference mode", async () => {
    let captured = null;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            captured = JSON.parse(body);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: REF_OUTPUT } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.optimize({
            prompt: "replace the dancer with the character in the image",
            mode: "全参考模式(Reference to Video)",
            duration: 5,
            uploadedImages: [{ name: "character.png" }],
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        assert.match(captured.messages[0].content, /Video Prompt Writing Guide/);
        assert.match(captured.messages[0].content, /subject_definitions/);
        assert.match(captured.messages[0].content, /retention_analysis/);
        assert.match(captured.messages[0].content, /fully_preserved/);
        assert.match(captured.messages[0].content, /attribute_transfer/);
        assert.match(captured.messages[0].content, /fully_copy/);
        assert.match(captured.messages[0].content, /reference generation/);
        assert.match(captured.messages[0].content, /Preserve every original word and punctuation mark verbatim/);
        assert.match(captured.messages[0].content, /输出语言：字段正文全部使用中文/);
        assert.match(result.prompt, /^subject_definitions:/);
        assert.match(result.prompt, /retention_analysis:/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cloud H3 FL2VA prepends the official frame alignment line", async () => {
    const output = `integrated_multimodal_description: [Shot 1] 开场画面。\n[Shot 2] At 00:05.000, 画面落到尾帧。\n\noverall_soundscape: 街道环境声。\n\nnon_diegetic_music: 无配乐。`;
    let captured = null;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            captured = JSON.parse(body);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.optimize({
            prompt: "人物从街道走到镜头前",
            mode: "首尾帧视频(FL2VA)",
            duration: 10,
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        assert.match(captured.messages[0].content, /Video Prompt Writing Guide/);
        assert.match(captured.messages[0].content, /How the reference pictures align/);
        assert.match(captured.messages[0].content, /对齐句由系统在正文前补充/);
        assert.match(captured.messages[1]?.content || captured.messages[0].content, /首尾帧视频：从 Picture 1 连续过渡到 Picture 2/);
        assert.ok(result.prompt.startsWith("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 2) aligns with the 10.00-second mark of the target video.\n\n"), result.prompt);
        assert.match(result.prompt, /integrated_multimodal_description: \[Shot 1\]/);
        assert.match(result.prompt, /\[Shot 2\] At 00:05.000/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cloud H3 three-part prompt keeps headings and defaults to Chinese content", async () => {
    const output = `integrated_multimodal_description: [Shot 1] 人物看向镜头。\noverall_soundscape: 街道环境声。\nnon_diegetic_music: 无配乐。`;
    let captured = null;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            captured = JSON.parse(body);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.optimize({
            prompt: "人物看向镜头",
            mode: "文生视频(T2VA)",
            duration: 5,
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        assert.match(captured.messages[0].content, /Video Prompt Writing Guide/);
        assert.match(captured.messages[0].content, /Preserve every original word and punctuation mark verbatim/);
        assert.match(captured.messages[0].content, /integrated_multimodal_description/);
        assert.match(captured.messages[0].content, /字段正文全部使用中文/);
        assert.match(result.prompt, /^integrated_multimodal_description:/);
        assert.match(result.prompt, /overall_soundscape:/);
        assert.match(result.prompt, /non_diegetic_music:/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cloud H3 English output keeps Chinese dialogue", async () => {
    const output = `integrated_multimodal_description: [Shot 1] A man asks: <d>[Chinese]你就是沈三叔？</d>\noverall_soundscape: Room tone.\nnon_diegetic_music: 无配乐。`;
    let captured = null;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            captured = JSON.parse(body);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.optimize({
            prompt: "画面外男人问道：“你就是沈三叔？”",
            mode: "文生视频(T2VA)",
            duration: 5,
            language: "en",
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        assert.match(captured.messages[0].content, /Write every field body in English/);
        assert.match(captured.messages[0].content, /Chinese dialogue stays Chinese/);
        assert.match(captured.messages[1].content, /输出语言：英文/);
        assert.match(result.prompt, /<d>\[Chinese\]你就是沈三叔？<\/d>/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cloud H3 sends reference images to the vision model", async () => {
    const output = `integrated_multimodal_description: [Shot 1] 画面与参考图一致。\noverall_soundscape: 环境声。\nnon_diegetic_music: 无。`;
    const image = "data:image/png;base64,iVBORw0KGgo=";
    let captured = null;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            captured = JSON.parse(body);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.optimize({
            prompt: "人物从街道走到镜头前",
            mode: "首尾帧视频(FL2VA)",
            duration: 10,
            cloudImages: [image],
            imageCount: 1,
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        const content = captured.messages[1].content;
        assert.ok(Array.isArray(content), "image request must use multimodal content");
        assert.equal(content[0].type, "text");
        assert.match(content[0].text, /参考图片：1 张（已随消息附上/);
        assert.equal(content[1].type, "image_url");
        assert.equal(content[1].image_url.url, image);
        assert.match(result.prompt, /^How the reference pictures align/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cloud H3 fixes missing speaker ids and off-screen markers", async () => {
    const output = `integrated_multimodal_description: [Shot 1] 画面右侧外传来男人声音 (S1) 质问：<d>[Chinese] 你就是沈三叔？</d> 老头儿反问：<d>[Chinese] 沈什么叔？</d> 画面外同一个男人 (S1) 说：<d>[Chinese] 老东西。</d>\noverall_soundscape: 环境声。\nnon_diegetic_music: N/A`;
    let captured = null;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            captured = JSON.parse(body);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.optimize({
            prompt: "画面外男人问道：“你就是沈三叔？” 老头儿反问：“沈什么叔？”",
            mode: "文生视频(T2VA)",
            duration: 10,
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        assert.match(result.prompt, /老头儿\s*\(S2\)/);
        assert.match(result.prompt, /男人声音\s*\(S1\) off-screen/);
        assert.match(result.prompt, /不在画面中，不对应任何参考图/);
        assert.ok(result.speakerTags.fixed >= 3, JSON.stringify(result.speakerTags));
        assert.equal(result.speakerTags.issues.length, 0);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

/**
 * 短剧 skill 只在全参考模式叠加。这两条测试用 stub fetch 直接看 system prompt，
 * 因为要断言的重点是「拼装了什么」，不是「请求有没有到」。
 */
async function captureCloudSystemPrompt({ mode }) {
    let system = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        system = String(body.messages?.[0]?.content || "");
        return new Response(JSON.stringify({ choices: [{ message: { content: REF_OUTPUT } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        await optimizer.optimize({
            prompt: "岚汐坐在办公桌后，赵磊站在桌前。",
            mode,
            duration: 15,
            uploadedImages: [{ name: "lanxi.png" }],
            engine: "cloud",
            cloud: { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m" },
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
    return system;
}

test("full-reference mode layers the short-drama skill on top of h3-prompt-writing", async () => {
    const system = await captureCloudSystemPrompt({ mode: "全参考模式(Reference to Video)" });
    // h3-prompt-writing 的六段式格式仍然在（短剧 skill 声明要配合它使用）
    assert.match(system, /subject_definitions/);
    assert.match(system, /retention_analysis/);
    assert.match(system, /Video Prompt Writing Guide/);
    // 短剧 skill 的生产规范已叠加
    assert.match(system, /人物三层加固法/, "应包含人物锁定规范");
    assert.match(system, /位置锁定法/, "应包含位置锁定规范");
    assert.match(system, /说话镜头锁人规则/, "应包含说话镜头锁人规则");
    assert.match(system, /常见错误清单/, "应包含常见错误清单");
});

test("short-drama skill drops its workflow and storyboard sections", async () => {
    const system = await captureCloudSystemPrompt({ mode: "全参考模式(Reference to Video)" });
    // 接口只返回六段式正文，流程类章节会诱导模型输出分镜表或检查清单
    assert.doesNotMatch(system, /## 工作流程/);
    assert.doesNotMatch(system, /## 分镜表规范/);
    assert.doesNotMatch(system, /## 交付检查清单/);
    assert.doesNotMatch(system, /一、分镜表模板/);
    // 并明确告诉模型不要输出分镜表
    assert.match(system, /分镜表只在内部推演使用/);
});

test("non-reference modes do not load the short-drama skill", async () => {
    // T2VA 没有参考图编号、整集统一这类概念，塞短剧规范只会稀释真正的格式要求
    for (const mode of ["文生视频(T2VA)", "首帧图生视频(I2VA)"]) {
        const system = await captureCloudSystemPrompt({ mode });
        assert.doesNotMatch(system, /人物三层加固法/, `${mode} 不应叠加短剧 skill`);
        assert.doesNotMatch(system, /位置锁定法/, `${mode} 不应叠加短剧 skill`);
        assert.match(system, /subject_definitions/, `${mode} 仍应有 H3 六段式格式`);
    }
});

test("local H3 passes the English language directive to the workflow", async () => {
    let submitted = null;
    const optimizer = createPromptOptimizer({
        config: { rootDir },
        comfy: {
            objectInfo: async () => structuredClone(h3ObjectInfo),
            submit: async (workflow) => {
                submitted = workflow;
                return { promptId: "test-prompt" };
            },
            history: async () => ({ status: { completed: true }, outputs: { "4": { text: [REF_OUTPUT] } } }),
        },
        logger: null,
    });
    await optimizer.optimize({
        prompt: "人物看向镜头",
        mode: "文生视频(T2VA)",
        duration: 5,
        language: "en",
        engine: "local",
    });
    assert.ok(submitted, "workflow was not submitted");
    assert.match(submitted["3"].inputs.system_prompt, /Write every field body in English/);
    assert.match(submitted["3"].inputs.system_prompt, /Chinese dialogue stays Chinese/);
});


test("cloud caption sends the image as image_url and returns the prompt", async () => {
    let captured = null;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            captured = JSON.parse(body);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: "一位身穿古装的年轻男子，神情沉静。" } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.captionImage({
            cloudImages: ["data:image/png;base64,AAAA"],
            language: "zh",
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        const content = captured.messages[1].content;
        assert.ok(Array.isArray(content), "user content should carry text + image");
        assert.equal(content[0].type, "text");
        assert.equal(content[1].type, "image_url");
        assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
        assert.equal(result.engine, "cloud");
        assert.match(result.prompt, /古装/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("loopback base urls are allowed without ALLOW_PRIVATE_CLOUD", async () => {
    // 本机跑 OpenAI 兼容服务（LM Studio / Ollama / vLLM）是最常见的本地推理用法。
    // 请求会真的发出去，所以这里起一个最小的本地服务来接它。
    const previous = process.env.ALLOW_PRIVATE_CLOUD;
    delete process.env.ALLOW_PRIVATE_CLOUD;
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "本机模型回复" } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.captionImage({
            cloudImages: ["data:image/png;base64,AAAA"],
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m" },
        });
        assert.equal(result.engine, "cloud");
        assert.equal(result.prompt, "本机模型回复");
    } finally {
        await new Promise((resolve) => server.close(resolve));
        process.env.ALLOW_PRIVATE_CLOUD = previous;
    }
});

test("LAN private base urls still require ALLOW_PRIVATE_CLOUD", async () => {
    const previous = process.env.ALLOW_PRIVATE_CLOUD;
    delete process.env.ALLOW_PRIVATE_CLOUD;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        // 内网段会把请求送到别的设备，和「本机自用」不是一回事，默认仍然拒绝。
        for (const baseUrl of ["http://192.168.1.10:8080/v1", "http://10.0.0.5:8080/v1", "http://172.16.0.2:8080/v1"]) {
            await assert.rejects(
                () => optimizer.captionImage({
                    cloudImages: ["data:image/png;base64,AAAA"],
                    engine: "cloud",
                    cloud: { baseUrl, apiKey: "k", model: "m" },
                }),
                /内网/,
                `${baseUrl} 应被拒绝`,
            );
        }
    } finally {
        process.env.ALLOW_PRIVATE_CLOUD = previous;
    }
});

test("cloud H3 retries with temperature=1 when the provider rejects 0.6", async () => {
    // 这条重试逻辑只对远程服务有意义：回环地址根本不发 temperature（见下一条测试）。
    // 这里 stub fetch，既能断言请求体，又不用真的连一台远程服务器。
    const bodies = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body || "{}")));
        if (bodies.length === 1) {
            return new Response(JSON.stringify({ error: { message: "invalid temperature: only 1 is allowed for this model" } }), {
                status: 400,
                headers: { "content-type": "application/json" },
            });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "optimized prompt" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.optimize({
            prompt: "a cat",
            mode: "文生视频(T2VA)",
            duration: 5,
            engine: "cloud",
            cloud: { baseUrl: "https://api.example.com/v1", apiKey: "test", model: "kimi-thinking" },
        });
        assert.equal(bodies.length, 2);
        assert.equal(bodies[0].temperature, 0.6);
        assert.equal(bodies[1].temperature, 1);
        assert.equal(result.prompt, "optimized prompt");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("loopback endpoints do not receive temperature at all", async () => {
    // 本机模型服务对 temperature 的接受度不一（有的只允许 1，有的被它锁死采样），
    // 回环地址一律不传，交给服务自己的默认值。
    const bodies = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            bodies.push(JSON.parse(body));
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: "本机回复" } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        for (const host of ["127.0.0.1", "localhost"]) {
            bodies.length = 0;
            const result = await optimizer.optimize({
                prompt: "一只猫",
                mode: "文生视频(T2VA)",
                duration: 5,
                engine: "cloud",
                cloud: { baseUrl: `http://${host}:${port}/v1`, apiKey: "test", model: "local-model" },
            });
            assert.equal(result.prompt, "本机回复", `${host} 应正常返回`);
            assert.equal(bodies.length, 1);
            assert.equal("temperature" in bodies[0], false, `${host} 的请求体不应包含 temperature`);
            // 其它参数该照常带，别为了去掉一个字段把请求削没了
            assert.equal(bodies[0].model, "local-model");
            assert.ok(bodies[0].messages?.length);
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("loopback is not retried on a temperature rejection it cannot fix", async () => {
    // 回环请求里没有 temperature，重试成 1 也改变不了结果，不该白跑第二遍。
    let calls = 0;
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            calls += 1;
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "invalid temperature: only 1 is allowed for this model" } }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        await assert.rejects(
            () => optimizer.optimize({
                prompt: "一只猫",
                mode: "文生视频(T2VA)",
                duration: 5,
                engine: "cloud",
                cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "local" },
            }),
            /云端 API 失败/,
        );
        assert.equal(calls, 1, "回环地址不应因为 temperature 报错而重试");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("local caption applies explicit model aliases before submitting", async () => {
    let submitted = null;
    const optimizer = createPromptOptimizer({
        config: { rootDir },
        comfy: {
            objectInfo: async () => structuredClone(h3ObjectInfo),
            submit: async (workflow) => {
                submitted = workflow;
                return { promptId: "caption-alias" };
            },
            history: async () => ({ status: { completed: true }, outputs: { "4": { text: ["一只猫"] } } }),
        },
        logger: { info() {} },
        loaderSpecs: [
            { classType: "llama_cpp_model_loader", input: "model" },
            { classType: "llama_cpp_model_loader", input: "mmproj" },
        ],
        modelAliasFor: (classType, input, value) => {
            if (classType !== "llama_cpp_model_loader") return "";
            if (input === "model" && value === "Qwen3.5-9B-Q4_K_M.gguf") return "Qwen3.5-9B-Q6_K.gguf";
            if (input === "mmproj" && value === "mmproj-BF16.gguf") return "mmproj-Custom-BF16.gguf";
            return "";
        },
    });
    await optimizer.captionImage({ uploadedImages: [{ name: "cat.png" }] });
    assert.equal(submitted["2"].inputs.model, "Qwen3.5-9B-Q6_K.gguf");
    assert.equal(submitted["2"].inputs.mmproj, "mmproj-Custom-BF16.gguf");
});

test("local image optimize applies aliases for the Qwen PE loader inputs", async () => {
    let submitted = null;
    const optimizer = createPromptOptimizer({
        config: { rootDir },
        comfy: {
            objectInfo: async () => structuredClone(h3ObjectInfo),
            submit: async (workflow) => {
                submitted = workflow;
                return { promptId: "image-alias" };
            },
            history: async () => ({ status: { completed: true }, outputs: { "2": { text: ["a quiet bookstore at night, warm light"] } } }),
        },
        logger: { info() {} },
        loaderSpecs: [
            { classType: "TE_Qwen_Image_2_1_Prompt_Enhancer", input: "主模型" },
            { classType: "TE_Qwen_Image_2_1_Prompt_Enhancer", input: "mmproj" },
        ],
        modelAliasFor: (classType, input, value) => {
            if (classType !== "TE_Qwen_Image_2_1_Prompt_Enhancer") return "";
            if (input === "主模型" && value === "Qwen3.5-9B-Q4_K_M.gguf") return "Qwen3.5-9B-Q6_K.gguf";
            if (input === "mmproj" && value === "mmproj-BF16.gguf") return "mmproj-Custom-BF16.gguf";
            return "";
        },
    });
    await optimizer.optimizeImage({ prompt: "a bookstore", engine: "local" });
    assert.equal(submitted["1"].inputs["主模型"], "Qwen3.5-9B-Q6_K.gguf");
    assert.equal(submitted["1"].inputs.mmproj, "mmproj-Custom-BF16.gguf");
});

test("templates stay untouched when no alias function is provided", async () => {
    let submitted = null;
    const optimizer = createPromptOptimizer({
        config: { rootDir },
        comfy: {
            objectInfo: async () => structuredClone(h3ObjectInfo),
            submit: async (workflow) => {
                submitted = workflow;
                return { promptId: "no-alias" };
            },
            history: async () => ({ status: { completed: true }, outputs: { "4": { text: ["一只猫"] } } }),
        },
        logger: null,
    });
    await optimizer.captionImage({ uploadedImages: [{ name: "cat.png" }] });
    assert.equal(submitted["2"].inputs.model, "Qwen3.5-9B-Q4_K_M.gguf");
    assert.equal(submitted["2"].inputs.mmproj, "mmproj-BF16.gguf");
});
