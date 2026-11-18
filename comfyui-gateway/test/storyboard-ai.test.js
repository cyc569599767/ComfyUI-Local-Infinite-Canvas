import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createStoryboardAi } from "../src/storyboard-ai.js";

/** 起一个假的 OpenAI 兼容服务，返回固定内容，用于验证解析而非网络行为。 */
async function fakeLlm(content, t) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-key", model: "test-model" };
}

const CLOUD_REQUIRED = { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" };

test("没配置云端通道时给出明确错误而不是静默空结果", async () => {
  const ai = createStoryboardAi({});
  await assert.rejects(() => ai.breakdown({ story: "一个人在雨夜等车" }), (error) => {
    assert.ok(error.code, "必须带 code 便于前端区分是配置问题还是生成问题");
    return true;
  });
});

test("故事为空时直接拒绝，不浪费一次云端调用", async () => {
  const ai = createStoryboardAi({});
  await assert.rejects(() => ai.breakdown({ story: "   ", cloud: CLOUD_REQUIRED }), /故事/);
});

test("剥掉 markdown 代码块后仍能解析出分镜", async (t) => {
  const board = {
    style: "冷调",
    beats: [{ id: "beat-1", summary: "等待", act: "起" }],
    characters: [{ id: "char-1", name: "林默", role: "主角" }],
    scenes: [{ id: "scene-1", name: "街角", time: "深夜" }],
    props: [],
    shots: [
      { id: "shot-1", title: "远景", duration: 5, positive: "雨夜街角全景", video_mode: "图生视频" },
      { id: "shot-2", title: "近景", duration: 4, positive: "雨水顺伞沿流下", video_mode: "首尾帧" },
    ],
  };
  // 模型经常把 JSON 包在 ```json 里，这是最常见的一类失败。
  const cloud = await fakeLlm("```json\n" + JSON.stringify(board) + "\n```", t);
  const ai = createStoryboardAi({});
  const result = await ai.breakdown({ story: "雨夜，男人在街角等人。", cloud, engine: "cloud" });
  assert.equal(result.shots.length, 2);
  assert.equal(result.shots[0].positive, "雨夜街角全景");
  assert.equal(result.characters.length, 1);
});

test("模型吐出的不存在的引用会被过滤掉", async (t) => {
  const board = {
    characters: [{ id: "char-1", name: "林默" }],
    scenes: [{ id: "scene-1", name: "街角" }],
    shots: [
      {
        id: "shot-1",
        positive: "雨夜",
        duration: 5,
        // 幻觉引用：这两个 id 在 characters/scenes 里根本不存在，
        // 原样写入会让后续生成去找不存在的参考图。
        protagonist_refs: ["char-1", "char-999"],
        scene_ref: "scene-404",
      },
    ],
  };
  const cloud = await fakeLlm(JSON.stringify(board), t);
  const ai = createStoryboardAi({});
  const result = await ai.breakdown({ story: "测试故事", cloud, engine: "cloud" });
  assert.deepEqual(result.shots[0].protagonist_refs, ["char-1"], "只保留真实存在的角色引用");
  assert.equal(result.shots[0].scene_ref, "", "不存在的场景应被清空");
});

test("重复的分镜 id 被改名，不丢镜头", async (t) => {
  const board = {
    shots: [
      { id: "same", positive: "第一镜", duration: 3 },
      { id: "same", positive: "第二镜", duration: 4 },
    ],
  };
  const cloud = await fakeLlm(JSON.stringify(board), t);
  const ai = createStoryboardAi({});
  const result = await ai.breakdown({ story: "测试故事", cloud, engine: "cloud" });
  assert.equal(result.shots.length, 2);
  assert.equal(new Set(result.shots.map((shot) => shot.id)).size, 2);
});

test("模型返回非 JSON 时报错，不把原始文本当成分镜", async (t) => {
  const cloud = await fakeLlm("抱歉，我无法完成这个请求。", t);
  const ai = createStoryboardAi({});
  await assert.rejects(() => ai.breakdown({ story: "测试故事", cloud, engine: "cloud" }), (error) => {
    assert.ok(error.code, "必须带 code，前端要能提示是拆解失败而不是网络错误");
    return true;
  });
});

test("分镜数量被压到上限内", async (t) => {
  const shots = Array.from({ length: 300 }, (_, index) => ({ id: `shot-${index}`, positive: `镜头 ${index}`, duration: 3 }));
  const cloud = await fakeLlm(JSON.stringify({ shots }), t);
  const ai = createStoryboardAi({});
  const result = await ai.breakdown({ story: "很长的故事", cloud, engine: "cloud", targetShotCount: 0 });
  assert.ok(result.shots.length > 0);
  assert.ok(result.shots.length <= 200, `分镜数应被限制，实际 ${result.shots.length}`);
});
/**
 * 本地路径：走 ComfyUI 的 llama.cpp 节点。
 *
 * 这是默认引擎——本地渠道没有 /v1/chat/completions，只支持云端就等于功能不可用。
 */
function fakeComfy({ content, status = "success", completed = true, failMessage = "" }) {
  const submitted = [];
  return {
    submitted,
    async submit(workflow) {
      submitted.push(workflow);
      return { promptId: "prompt-local-1" };
    },
    async cancel() {},
    // 注意：comfy.history() 返回的已经是该 promptId 的 entry 本身。
    // 第一版在这里多套了一层 [promptId]，导致永远读不到、白等到超时。
    async history() {
      if (status === "error") {
        return { status: { status_str: "error", completed: false, messages: [["execution_error", { exception_message: failMessage }]] } };
      }
      return {
        status: { status_str: "success", completed },
        outputs: completed ? { 4: { text: [content] } } : {},
      };
    },
  };
}

const LOCAL_BOARD = {
  style: "冷调",
  characters: [{ id: "char-1", name: "林默" }],
  scenes: [{ id: "scene-1", name: "街角" }],
  shots: [{ id: "shot-1", title: "等待", duration: 5, positive: "雨夜街角", video_mode: "图生视频" }],
};

test("默认引擎是本机 llama.cpp，不需要云端凭据", async () => {
  const comfy = fakeComfy({ content: JSON.stringify(LOCAL_BOARD) });
  const ai = createStoryboardAi({ comfy });
  // 故意不传 cloud：这正是默认渠道（本地 ComfyUI）的真实情况。
  const result = await ai.breakdown({ story: "雨夜等车", engine: "local" });
  assert.equal(result.shots.length, 1);
  assert.equal(result.shots[0].positive, "雨夜街角");
  assert.equal(comfy.submitted.length, 1, "应该向 ComfyUI 提交了一次工作流");
});

test("本地工作流使用合法的节点与参数值", async () => {
  const comfy = fakeComfy({ content: JSON.stringify(LOCAL_BOARD) });
  const ai = createStoryboardAi({ comfy });
  await ai.breakdown({ story: "雨夜等车", engine: "local" });
  const workflow = comfy.submitted[0];
  assert.equal(workflow["1"].class_type, "llama_cpp_model_loader");
  assert.equal(workflow["3"].class_type, "llama_cpp_instruct_adv");
  assert.equal(workflow["4"].class_type, "TE_text_display");
  // ComfyUI 会校验这两个：inference_mode 只接受 one by one/images/video，
  // max_frames 最小是 2。写错会直接被拒（我们第一版就是这样失败的）。
  assert.equal(workflow["3"].inputs.inference_mode, "one by one");
  assert.ok(workflow["3"].inputs.max_frames >= 2, "max_frames 不能小于 2");
  assert.ok(workflow["3"].inputs.system_prompt.includes("JSON"), "系统提示必须要求 JSON 输出");
});

test("本地模型执行失败时透出真实原因", async () => {
  const comfy = fakeComfy({ status: "error", failMessage: "CUDA out of memory" });
  const ai = createStoryboardAi({ comfy });
  await assert.rejects(() => ai.breakdown({ story: "雨夜等车", engine: "local" }), (error) => {
    assert.match(error.message, /CUDA out of memory/);
    assert.equal(error.code, "storyboard_ai_local_failed");
    return true;
  });
});

test("没有注入 comfy 时明确说本地不可用，而不是假装能跑", async () => {
  const ai = createStoryboardAi({});
  await assert.rejects(() => ai.breakdown({ story: "雨夜等车", engine: "local" }), (error) => {
    assert.equal(error.code, "storyboard_ai_no_comfy");
    return true;
  });
});

test("云端引擎仍然要求凭据，不会静默回落到本地", async () => {
  const comfy = fakeComfy({ content: JSON.stringify(LOCAL_BOARD) });
  const ai = createStoryboardAi({ comfy });
  await assert.rejects(() => ai.breakdown({ story: "雨夜等车", engine: "cloud" }), (error) => {
    assert.equal(error.code, "storyboard_ai_not_configured");
    return true;
  });
  assert.equal(comfy.submitted.length, 0, "云端配置缺失时不该偷偷跑本地");
});

test("max_tokens 必须显式设置，否则默认 1024 会截断 4 镜的 JSON", async () => {
  const comfy = fakeComfy({ content: JSON.stringify(LOCAL_BOARD) });
  const ai = createStoryboardAi({ comfy });
  await ai.breakdown({ story: "雨夜等车", engine: "local" });
  const workflow = comfy.submitted[0];
  // llama_cpp_parameters 的 max_tokens 默认是 1024，4 镜完整 JSON 约 1500+ token，
  // 不挂这个节点就会在 3499 字符处被硬切。这个断言防止回归。
  assert.equal(workflow["5"].class_type, "llama_cpp_parameters");
  assert.ok(workflow["5"].inputs.max_tokens >= 3000, `max_tokens 太小会截断，实际 ${workflow["5"].inputs.max_tokens}`);
  assert.deepEqual(workflow["3"].inputs.parameters, ["5", 0], "instruct 节点必须接上参数节点");
});

test("输出被截断时抢救已完整的镜头，而不是整体失败", async () => {
  // 模拟真实截断：JSON 在第四个镜头中途断掉，括号不闭合。
  const truncated = `{"style":"冷调","characters":[{"id":"char-1","name":"林默"}],"scenes":[{"id":"scene-1","name":"街角"}],"shots":[
    {"id":"shot-1","title":"一","duration":5,"positive":"镜头一"},
    {"id":"shot-2","title":"二","duration":4,"positive":"镜头二"},
    {"id":"shot-3","title":"三","duration":3,"positive":"镜头三"},
    {"id":"shot-4","title":"四","dur`;
  const comfy = fakeComfy({ content: truncated });
  const ai = createStoryboardAi({ comfy });
  const board = await ai.breakdown({ story: "雨夜等车", engine: "local" });
  // 前三个镜头是真实产出，不能因为第四个写了一半就全部丢弃。
  assert.equal(board.shots.length, 3);
  assert.equal(board.truncated, true, "必须标记被截断，让前端能提示用户");
  assert.deepEqual(board.shots.map((shot) => shot.positive), ["镜头一", "镜头二", "镜头三"]);
});

test("完整输出不应被标记为截断", async () => {
  const comfy = fakeComfy({ content: JSON.stringify(LOCAL_BOARD) });
  const ai = createStoryboardAi({ comfy });
  const board = await ai.breakdown({ story: "雨夜等车", engine: "local" });
  assert.equal(board.truncated, false);
  assert.equal(board.provider, "local");
});

test("完全无法解析时仍然报错，不会返回空镜头", async () => {
  const comfy = fakeComfy({ content: "抱歉，我不能完成。" });
  const ai = createStoryboardAi({ comfy });
  await assert.rejects(() => ai.breakdown({ story: "雨夜等车", engine: "local" }), (error) => {
    assert.equal(error.code, "storyboard_ai_bad_json");
    return true;
  });
});
