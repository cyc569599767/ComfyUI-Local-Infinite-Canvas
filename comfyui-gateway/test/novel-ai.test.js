import test from "node:test";
import assert from "node:assert/strict";

import { createNovelAi, NovelAiError } from "../src/novel-ai.js";

// 用一个假的 LLM 顶掉本地/云端推理，只验证「提示词组装 + 输出解析」这一层。
// 真实推理需要 ComfyUI 和 GGUF 模型，不适合放进单元测试。
function fakeAi(reply) {
  return createNovelAi({ comfy: { submit: async () => ({ promptId: "p" }), history: async () => ({
    status: { completed: true }, outputs: { "4": { text: [reply] } },
  }) }, cancel: async () => {} });
}

const reply = (value) => () => ({
  status: { completed: true },
  outputs: { "4": { text: [value] } },
});

function aiWith(replyText) {
  return createNovelAi({
    comfy: {
      submit: async () => ({ promptId: "p1" }),
      history: async () => reply(replyText)(),
      cancel: async () => {},
    },
  });
}

test("总纲：能从带代码块的回复里抠出 JSON", async () => {
  const ai = aiWith(
    '好的，以下是总纲：\n```json\n{"title":"暗河","premise":"法医能看见倒计时","genre":"悬疑","sellingPoint":"高概念","engine":"倒计时逼近","conflict":"救人还是自救","firstVolumeGoal":"查出第一个死者的真相","outline":"完整总纲正文"}\n```',
  );
  const data = await ai.outline({ idea: "一个法医的故事" });
  assert.equal(data.title, "暗河");
  assert.equal(data.outline, "完整总纲正文");
  assert.equal(data.genre, "悬疑");
});

test("总纲：JSON 前后有解释文字也要能解析", async () => {
  const ai = aiWith('我来写总纲。{"title":"测试","outline":"正文"}以上是总纲，希望满意。');
  const data = await ai.outline({ idea: "想法" });
  assert.equal(data.title, "测试");
});

test("总纲：拿不到 JSON 时报明确错误，不返回半成品", async () => {
  const ai = aiWith("抱歉，我无法完成这个请求。");
  await assert.rejects(() => ai.outline({ idea: "想法" }), (error) => {
    assert.ok(error instanceof NovelAiError);
    assert.equal(error.code, "novel_ai_bad_json");
    return true;
  });
});

test("总纲：中心思想为空时不调用模型", async () => {
  let submitted = false;
  const ai = createNovelAi({
    comfy: {
      submit: async () => { submitted = true; return { promptId: "p" }; },
      history: async () => null,
      cancel: async () => {},
    },
  });
  await assert.rejects(() => ai.outline({ idea: "   " }), /请先填写中心思想/);
  assert.equal(submitted, false, "空输入不该浪费一次推理");
});

test("分卷：按 seq 排序，字段缺失时补默认值", async () => {
  const ai = aiWith(
    '{"volumes":[{"seq":2,"title":"第二卷","outline":"卷二纲","chapterFrom":11,"chapterTo":20},{"seq":1,"title":"第一卷","outline":"卷一纲","chapterFrom":1,"chapterTo":10}]}',
  );
  const list = await ai.volumes({ idea: "想法", structure: {}, volumeCount: 5 });
  assert.equal(list.length, 2);
  assert.equal(list[0].seq, 1, "必须按 seq 升序");
  assert.equal(list[1].title, "第二卷");
});

test("分卷：seq 缺失时按数组顺序补", async () => {
  const ai = aiWith('{"volumes":[{"title":"甲"},{"title":"乙"}]}');
  const list = await ai.volumes({ idea: "想法", structure: {} });
  assert.deepEqual(list.map((v) => v.seq), [1, 2]);
});

test("章纲：保持 seq 升序，正文留空待写", async () => {
  const ai = aiWith(
    '{"chapters":[{"seq":2,"title":"第二章","volume":1,"outline":"目标/阻碍/变化/钩子"},{"seq":1,"title":"第一章","volume":1,"outline":"目标/阻碍/变化/钩子"}]}',
  );
  const list = await ai.chapters({ idea: "想法", structure: {}, volumes: [], chapterCount: 2 });
  assert.deepEqual(list.map((c) => c.seq), [1, 2]);
  assert.equal(list[0].novel, "");
  assert.equal(list[0].status, "outlined");
});

test("正文：没有章纲时拒绝生成，避免写出跑题内容", async () => {
  const ai = aiWith("正文内容");
  await assert.rejects(
    () => ai.chapterBody({ idea: "想法", chapter: { seq: 1, title: "一", outline: "" } }),
    /先有章纲|章纲/,
  );
});

test("正文：直接返回模型给的原文本，不做 JSON 解析", async () => {
  const ai = aiWith("雨夜里，他站在便利店门口，手里的伞还在滴水。");
  const body = await ai.chapterBody({
    idea: "想法",
    chapter: { seq: 1, title: "一", outline: "目标/阻碍/变化/钩子" },
  });
  assert.equal(body, "雨夜里，他站在便利店门口，手里的伞还在滴水。");
});

test("正文：模型返回纯空白时报错，不静默存空章", async () => {
  const ai = aiWith("   ");
  // 报错发生在「本地模型没有返回文本输出」这一步：纯空白在 runLocal 就被判空，
  // 比一路传到 chapterBody 再发现更早，错误也更准确。
  await assert.rejects(
    () => ai.chapterBody({ idea: "想法", chapter: { seq: 1, title: "一", outline: "纲" } }),
    /没有返回文本输出|没有返回正文/,
  );
});

test("嵌套 JSON 里的对象不会提前截断", async () => {
  // 朴素的 indexOf('}') 会在第一个内层对象处收尾，导致解析失败。
  const ai = aiWith('{"title":"书","meta":{"a":{"b":1}},"outline":"正文"}');
  const data = await ai.outline({ idea: "想法" });
  assert.equal(data.title, "书");
  assert.equal(data.outline, "正文");
});

test("字符串里含有花括号也不会打断解析", async () => {
  const ai = aiWith('{"title":"含{花括号}的书名","outline":"正文"}');
  const data = await ai.outline({ idea: "想法" });
  assert.equal(data.title, "含{花括号}的书名");
});
test("连不上 ComfyUI 时给出提交失败，而不是「没有返回结构化内容」", async () => {
  // 真实场景：网关起着但 ComfyUI 没开。submit 抛网络错误，
  // 如果直接冒上去会被归类成 JSON 解析失败，用户完全无从下手。
  const ai = createNovelAi({
    comfy: {
      submit: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8188"); },
      history: async () => null,
      cancel: async () => {},
    },
  });
  await assert.rejects(() => ai.outline({ idea: "想法" }), (error) => {
    assert.equal(error.code, "novel_ai_local_submit_failed");
    assert.match(error.message, /无法提交到 ComfyUI/);
    assert.match(error.message, /ECONNREFUSED/);
    return true;
  });
});

test("没有连接 ComfyUI 时直接报不可用", async () => {
  const ai = createNovelAi({ comfy: null });
  await assert.rejects(() => ai.outline({ idea: "想法" }), (error) => {
    assert.equal(error.code, "novel_ai_no_comfy");
    return true;
  });
});

test("云端未配置时给出明确提示，不静默发请求", async () => {
  const ai = createNovelAi({ comfy: null });
  await assert.rejects(
    () => ai.outline({ idea: "想法", engine: "cloud", cloud: { baseUrl: "", apiKey: "", model: "" } }),
    (error) => {
      assert.equal(error.code, "novel_ai_not_configured");
      assert.match(error.message, /Base URL、API Key 和模型/);
      return true;
    },
  );
});

test("章纲：没有分卷时所有章节归卷 1，不让模型瞎编卷号", async () => {
  // 实测 bug：只生成了总纲就生成章纲，模型把 20 章分到卷 1/2/3/4 又跳回卷 1。
  const ai = aiWith(
    '{"chapters":[{"seq":1,"title":"一","volume":3,"outline":"纲"},{"seq":2,"title":"二","volume":7,"outline":"纲"}]}',
  );
  const list = await ai.chapters({ idea: "想法", structure: {}, volumes: [], chapterCount: 2 });
  assert.deepEqual(list.map((c) => c.volume), [1, 1], "没有分卷就该统一归卷 1");
});

test("章纲：有分卷时按章节范围判定卷号", async () => {
  const volumes = [
    { seq: 1, title: "卷一", outline: "o", chapterFrom: 1, chapterTo: 10 },
    { seq: 2, title: "卷二", outline: "o", chapterFrom: 11, chapterTo: 20 },
  ];
  // 第 12 章落在卷二范围（11-20），模型却标成卷 1，应按范围纠正成卷 2。
  // 用 chapterCount=12 让批次覆盖到第 12 章，才能测到跨卷判定。
  const ai = createNovelAi({
    comfy: {
      submit: async () => ({ promptId: "p" }),
      history: async () => ({
        status: { completed: true },
        outputs: { "4": { text: [JSON.stringify({ chapters: Array.from({ length: 12 }, (_, i) => ({
          seq: i + 1, title: `第${i + 1}章`, volume: 1, outline: "纲",
        })) })] } },
      }),
      cancel: async () => {},
    },
  });
  const list = await ai.chapters({ idea: "想法", structure: {}, volumes, chapterCount: 12, batchSize: 12 });
  assert.equal(list[0].volume, 1, "第 1 章属于卷一");
  assert.equal(list[11].volume, 2, "第 12 章落在卷二范围，应纠正为卷 2");
});

test("章纲：分批生成，seq 跨批连续不重复", async () => {
  let batch = 0;
  const ai = createNovelAi({
    comfy: {
      submit: async () => ({ promptId: "p" }),
      // 每批返回 2 章，验证跨批的 seq 是连续递增的。
      history: async () => {
        batch += 1;
        const start = (batch - 1) * 2 + 1;
        return {
          status: { completed: true },
          outputs: { "4": { text: [JSON.stringify({ chapters: [
            { seq: start, title: `第${start}章`, volume: 1, outline: "纲" },
            { seq: start + 1, title: `第${start + 1}章`, volume: 1, outline: "纲" },
          ] })] } },
        };
      },
      cancel: async () => {},
    },
  });
  const list = await ai.chapters({ idea: "想法", structure: {}, volumes: [], chapterCount: 6, batchSize: 2 });
  assert.equal(list.length, 6);
  assert.deepEqual(list.map((c) => c.seq), [1, 2, 3, 4, 5, 6], "跨批 seq 必须连续");
  assert.equal(batch, 3, "6 章 / 每批 2 章 = 3 批");
});

test("章纲：模型返回空批次时报错，不静默少章", async () => {
  const ai = aiWith('{"chapters":[]}');
  await assert.rejects(
    () => ai.chapters({ idea: "想法", structure: {}, volumes: [], chapterCount: 5, batchSize: 5 }),
    /没有生成出章纲/,
  );
});

test("章纲：推理截断时自动拆半重试，而不是整批失败", async () => {
  // 真实失败模式：模型把 8192 token 全花在 reasoning_content 上，
  // content 为空、finish_reason=length。固定批大小会整批失败，
  // 必须拆半重试才能把章纲写出来。
  const sizes = [];
  let attempt = 0;
  const ai = createNovelAi({
    comfy: {
      submit: async () => ({ promptId: "p" }),
      history: async () => {
        attempt += 1;
        // 第一次给 6 章：模拟被推理截断（返回空）。
        if (attempt === 1) return { status: { completed: true }, outputs: { "4": { text: [""] } } };
        // 拆半后每批 3 章，返回真实内容。
        const start = attempt === 2 ? 1 : 4;
        sizes.push(start);
        return {
          status: { completed: true },
          outputs: { "4": { text: [JSON.stringify({ chapters: Array.from({ length: 3 }, (_, i) => ({
            seq: start + i, title: `第${start + i}章`, volume: 1, outline: "纲",
          })) })] } },
        };
      },
      cancel: async () => {},
    },
  });
  const list = await ai.chapters({ idea: "想法", structure: {}, volumes: [], chapterCount: 6, batchSize: 6 });
  assert.equal(list.length, 6, "拆半后应补齐全部章节");
  assert.deepEqual(list.map((c) => c.seq), [1, 2, 3, 4, 5, 6], "seq 仍要连续");
  assert.equal(attempt, 3, "1 次失败 + 2 次拆半 = 3 次调用");
});

test("章纲：单章仍被截断时报错，并提示换模型", async () => {
  const ai = createNovelAi({
    comfy: {
      submit: async () => ({ promptId: "p" }),
      // 永远返回空，模拟推理不可控的模型。
      history: async () => ({ status: { completed: true }, outputs: { "4": { text: [""] } } }),
      cancel: async () => {},
    },
  });
  // 单章时不应该无限拆下去，而是明确报错。
  await assert.rejects(
    () => ai.chapters({ idea: "想法", structure: {}, volumes: [], chapterCount: 1, batchSize: 1 }),
    /没有生成出章纲|推理/,
  );
});

test("章纲：JSON 被截成半截时同样降批重试", async () => {
  // 实测过的失败模式：content 非空但 JSON 只有前半截（被输出上限切断），
  // 报的是 bad_json 而不是空内容。这和「空内容」根因相同，都要降批。
  let attempt = 0;
  const ai = createNovelAi({
    comfy: {
      submit: async () => ({ promptId: "p" }),
      history: async () => {
        attempt += 1;
        if (attempt === 1) {
          // 半截 JSON：chapters 数组没闭合。
          return { status: { completed: true }, outputs: { "4": { text: ['{"chapters":[{"seq":1,"title":"一","volume":1,"outline":"纲"'], } } };
        }
        const start = attempt === 2 ? 1 : 3;
        return {
          status: { completed: true },
          outputs: { "4": { text: [JSON.stringify({ chapters: Array.from({ length: 2 }, (_, i) => ({
            seq: start + i, title: `第${start + i}章`, volume: 1, outline: "纲",
          })) })] } },
        };
      },
      cancel: async () => {},
    },
  });
  const list = await ai.chapters({ idea: "想法", structure: {}, volumes: [], chapterCount: 4, batchSize: 4 });
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((c) => c.seq), [1, 2, 3, 4]);
});
