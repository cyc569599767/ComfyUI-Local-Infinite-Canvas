/**
 * 「无限・卷轴」的 AI 生成。
 *
 * 四层结构逐层生成：总纲 → 分卷 → 章纲 → 正文。
 *
 * 为什么不一次性让模型写完整本：
 * 本地 llama.cpp 节点 max_tokens 上限是 4096，写不了一整章正文；
 * 就算用云端，一次要求几十万字也会被截断或跑偏。
 * 参考实现同样是「按层、按章逐步推进」——这是唯一能稳定产出的策略，
 * 所以这里的每一步只负责一层，正文按章单独请求。
 */
import { cloudChat } from "./prompt-optimizer.js";

const MAX_IDEA_CHARS = 6000;

export class NovelAiError extends Error {
  constructor(message, { status = 502, code = "novel_ai_failed", details } = {}) {
    super(message);
    this.name = "NovelAiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function text(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function positiveInt(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 从可能带代码块/前言的回包里抠出第一个完整 JSON 对象。 */
function extractJson(content) {
  const raw = String(content || "").trim();
  if (!raw) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 模型偶尔会在 JSON 前加一段解释；这种情况下宁可重试也不要用半截数据。 */
function requireJson(content) {
  const parsed = extractJson(content);
  if (!parsed) throw new NovelAiError("模型没有返回可解析的结构化内容，请重试", { status: 502, code: "novel_ai_bad_json" });
  return parsed;
}

/**
 * 把模型给的卷号夹到真实存在的卷上。
 *
 * 没有分卷时一律归卷 1——总纲里根本没有卷的概念，模型给的卷号是编的。
 * 有分卷时按章节序号落在哪一卷的 chapterFrom..chapterTo 区间里判定，
 * 区间也没命中就按比例归到最近的卷。
 */
function normalizeVolumeNo(raw, volumes, seq) {
  if (!Array.isArray(volumes) || !volumes.length) return 1;
  const byRange = volumes.find((v) => seq >= v.chapterFrom && seq <= v.chapterTo);
  if (byRange) return byRange.seq;
  const candidate = Math.trunc(Number(raw));
  if (volumes.some((v) => v.seq === candidate)) return candidate;
  const sorted = [...volumes].sort((a, b) => a.seq - b.seq);
  const last = sorted[sorted.length - 1];
  return seq > (last.chapterTo || 0) ? last.seq : sorted[0].seq;
}

const BASE_RULES = [
  "你是中文长篇小说作者，按用户给的中心思想写书。",
  "输出必须是简体中文，文风自然、有画面感，避免空洞的形容词堆砌。",
];

function outlinePrompt(idea) {
  return {
    system: [
      ...BASE_RULES,
      "本次只写【总纲】。只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。",
      'JSON 结构：{"title":"书名","premise":"一句话核心设定","genre":"题材","sellingPoint":"卖点",',
      ' "engine":"故事引擎（推动剧情不断前进的核心机制）",',
      ' "conflict":"核心冲突","firstVolumeGoal":"第一卷目标",',
      ' "outline":"300-600 字的总纲正文，交代世界观、主角处境、主要矛盾与走向"}',
    ].join("\n"),
    userText: `中心思想：\n${idea}`,
  };
}

function volumesPrompt(idea, structure, volumeCount) {
  return {
    system: [
      ...BASE_RULES,
      `本次只写【分卷】。输出 ${volumeCount} 卷以内。只输出一个 JSON 对象。`,
      'JSON 结构：{"volumes":[{"seq":1,"title":"卷名","outline":"本卷卷纲：核心目标+主要冲突+卷末变化",',
      ' "chapterFrom":1,"chapterTo":10}]}',
      "规则：",
      "- chapterFrom/chapterTo 必须连续且不重叠，从第 1 章开始。",
      "- 每卷 outline 要写清这一卷自己的阶段目标，不是重复总纲。",
      "- seq 从 1 开始递增。",
    ].join("\n"),
    userText: [`中心思想：\n${idea}`, structure.outline ? `总纲：\n${structure.outline}` : ""].filter(Boolean).join("\n\n"),
  };
}

function chaptersPrompt(idea, structure, volumes, count, batch = {}) {
  const from = batch.from || 1;
  const to = batch.to || count;
  const previous = Array.isArray(batch.previous) ? batch.previous.filter(Boolean) : [];
  return {
    system: [
      ...BASE_RULES,
      `本次只写【章纲】。为第 ${from} 到第 ${to} 章写章纲，共 ${to - from + 1} 章。只输出一个 JSON 对象。`,
      'JSON 结构：{"chapters":[{"seq":' + from + ',"title":"章名","volume":1,',
      ' "outline":"本章纲要：本章目标 / 阻碍 / 变化 / 章末钩子"}]}',
      "规则：",
      `- seq 必须从 ${from} 开始连续递增到 ${to}，不要从 1 开始。`,
      "- volume 必须落在给定的卷号范围内。",
      "- 每章 outline 必须包含四要素，缺一个都不合格。",
      "- 章与章之间要有承接，章末钩子要真实勾人，不要用「欲知后事如何」这种套话。",
      previous.length ? "- 下面是紧邻的前几章，你的第一批必须自然接上它们，不要重复已写过的情节。" : "",
    ].filter(Boolean).join("\n"),
    userText: [
      `中心思想：\n${idea}`,
      structure.outline ? `总纲：\n${structure.outline}` : "",
      volumes.length ? `分卷：\n${volumes.map((v) => `第${v.seq}卷《${v.title}》（第${v.chapterFrom}-${v.chapterTo}章）：${v.outline}`).join("\n")}` : "",
      previous.length ? `前面已写的章（请接着写）：\n${previous.join("\n")}` : "",
    ].filter(Boolean).join("\n\n"),
  };
}

function chapterBodyPrompt({ idea, structure, volume, chapter, context, targetWords }) {
  return {
    system: [
      ...BASE_RULES,
      "本次只写【一章正文】。直接输出正文，不要输出标题、不要 JSON、不要任何解释或总结。",
      `目标长度约 ${targetWords} 字（可以有浮动，但不要写成梗概）。`,
      "要求：",
      "- 严格围绕本章章纲的四要素展开，不要跑到别的章节内容上去。",
      "- 人物性格与设定必须和给定角色一致，不要凭空改人设。",
      "- 对白要有身份感；场景描写服务于情绪，不要堆砌。",
      "- 章末留钩子，但不要用「欲知后事如何」这类套话。",
    ].join("\n"),
    userText: [
      `中心思想：\n${idea}`,
      structure.outline ? `总纲：\n${structure.outline}` : "",
      volume ? `所属卷：第${volume.seq}卷《${volume.title}》\n卷纲：${volume.outline}` : "",
      `本章（第${chapter.seq}章《${chapter.title}》）章纲：\n${chapter.outline}`,
      context ? `前文参考：\n${context}` : "",
    ].filter(Boolean).join("\n\n"),
  };
}

export function createNovelAi({ logger, comfy = null, localModel = "Qwen3.5-9B-Q4_K_M.gguf" } = {}) {
  /**
   * 本地 llama.cpp 推理。
   *
   * 和分镜拆解共用同一条本地链路：本项目默认只有本地 ComfyUI，
   * 它没有 /v1/chat/completions，所以要求云端 key 等于把功能锁死。
   */
  async function runLocal({ system, userText, signal, deadlineMs = 600000, maxTokens = 4096 }) {
    if (!comfy) {
      throw new NovelAiError("本地生成不可用：网关没有连接 ComfyUI", { status: 503, code: "novel_ai_no_comfy" });
    }
    const workflow = {
      "1": {
        class_type: "llama_cpp_model_loader",
        inputs: { model: localModel, mmproj: "None", chat_handler: "None", n_ctx: 16384, vram_limit: -1, image_min_tokens: 0, image_max_tokens: 0, load_mtp: false },
        _meta: { title: "Novel LLM" },
      },
      // 必须显式挂 parameters：不挂时 max_tokens 用节点默认值 1024，
      // 章纲这种结构化输出会在中途被硬截断，JSON 直接解析失败。
      "5": {
        class_type: "llama_cpp_parameters",
        inputs: { max_tokens: Math.min(4096, Math.max(512, maxTokens)), top_k: 40, top_p: 0.9, min_p: 0.05, typical_p: 1, temperature: 0.75, repeat_penalty: 1.08, frequency_penalty: 0, present_penalty: 0, mirostat_mode: 0, mirostat_eta: 0.1, mirostat_tau: 5, state_uid: -1 },
        _meta: { title: "Novel sampling" },
      },
      "3": {
        class_type: "llama_cpp_instruct_adv",
        inputs: {
          llama_model: ["1", 0],
          parameters: ["5", 0],
          preset_prompt: "Empty - Nothing",
          custom_prompt: userText,
          system_prompt: system,
          inference_mode: "one by one",
          max_frames: 2,
          max_size: 512,
          seed: 0,
          force_offload: true,
          save_states: false,
        },
        _meta: { title: "Novel generation" },
      },
      "4": {
        class_type: "TE_text_display",
        inputs: { text: "", input_text: ["3", 0], use_edited_text: false, edited_from_text: "" },
        _meta: { title: "Novel output" },
      },
    };

    let submitted;
    try {
      submitted = await comfy.submit(workflow, { signal });
    } catch (error) {
      // 连不上 ComfyUI 时 submit 会抛网络错误。如果直接往上冒，
      // 用户看到的是「模型没有返回可解析的结构化内容」，完全误导。
      throw new NovelAiError(`本地生成失败：无法提交到 ComfyUI（${error?.message || String(error)}）`, {
        status: 502,
        code: "novel_ai_local_submit_failed",
      });
    }
    const promptId = submitted.promptId;
    const deadline = Date.now() + deadlineMs;
    let running = true;
    let cancelPromise = null;
    const cancel = () => {
      if (!running) return Promise.resolve();
      if (!cancelPromise) cancelPromise = typeof comfy.cancel === "function" ? comfy.cancel(promptId) : comfy.interrupt(promptId);
      return cancelPromise;
    };
    const onAbort = () => void cancel();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          await cancel();
          throw new NovelAiError("生成已取消", { status: 400, code: "cancelled" });
        }
        const entry = await comfy.history(promptId);
        if (entry) {
          if (entry.status?.status_str === "error") {
            running = false;
            throw new NovelAiError("本地模型执行失败，请查看 ComfyUI 日志", { status: 502, code: "novel_ai_local_failed" });
          }
          if (entry.status?.completed) {
            running = false;
            const output = entry.outputs?.["4"];
            const value = output?.text?.[0] ?? output?.string?.[0] ?? output?.text;
            if (typeof value === "string" && value.trim()) return value;
            throw new NovelAiError("本地模型没有返回文本输出", { status: 502, code: "novel_ai_local_empty" });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      await cancel();
      throw new NovelAiError("本地生成超时（模型加载或推理过慢）", { status: 504, code: "novel_ai_local_timeout" });
    } finally {
      running = false;
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  /** 统一入口：本地/云端二选一，其余代码不用关心区别。 */
  async function generate({ system, userText, cloud, engine, signal, deadlineMs, maxTokens }) {
    const useCloud = String(engine || "local").toLowerCase() === "cloud";
    if (useCloud) {
      if (!cloud?.baseUrl || !cloud?.apiKey || !cloud?.model) {
        throw new NovelAiError("请先在设置里配置云端模型的 Base URL、API Key 和模型", { status: 400, code: "novel_ai_not_configured" });
      }
      const started = Date.now();
      try {
        // 小说生成比拆解更慢，超时给足 8 分钟。
        const result = await cloudChat({ system, userText, cloud, signal, temperature: 0.8, maxTokens: Math.min(8192, maxTokens || 4096), timeoutMs: 480000 });
        logger?.info?.(`小说云端生成完成（${Math.round((Date.now() - started) / 1000)}s，finish=${result.finishReason || "?"}）`);
        // 带推理的模型会把 token 预算花在 reasoning_content 上：
        // finish_reason=length 且正文为空，就是「思考吃光了预算」；
        // 普通 HTTP 400 不在这里推断为截断，也不拆批重试。
        if (result.finishReason === "length" && !String(result.content || "").trim()) {
          throw new NovelAiError(
            "模型把全部输出预算用在了推理上，正文被截断（finish_reason=length）。请减少单次生成数量，或换用不带长推理的模型。",
            { status: 502, code: "novel_ai_truncated_by_reasoning" },
          );
        }
        return result.content || "";
      } catch (error) {
        if (error?.code === "cloud_api_bad_request") {
          throw new NovelAiError(error.message || "上游拒绝了云端请求", {
            status: 502,
            code: error.code,
            details: error.details,
          });
        }
        if (error instanceof NovelAiError) throw error;
        throw new NovelAiError(`云端生成失败：${error?.message || String(error)}`, {
          status: error?.status || 502,
          code: error?.code || "novel_ai_cloud_failed",
          details: error?.details,
        });
      }
    }
    return runLocal({ system, userText, signal, deadlineMs, maxTokens });
  }

  async function outline({ idea, cloud, engine, signal }) {
    const seed = text(idea, MAX_IDEA_CHARS);
    if (!seed) throw new NovelAiError("请先填写中心思想", { status: 400, code: "novel_idea_required" });
    const raw = await generate({ ...outlinePrompt(seed), cloud, engine, signal, maxTokens: 8192 });
    const data = requireJson(raw);
    return {
      title: text(data.title, 120),
      premise: text(data.premise, 400),
      genre: text(data.genre, 60),
      sellingPoint: text(data.sellingPoint, 400),
      engine: text(data.engine, 400),
      conflict: text(data.conflict, 600),
      firstVolumeGoal: text(data.firstVolumeGoal, 600),
      outline: text(data.outline, 20000),
    };
  }

  async function volumes({ idea, structure = {}, volumeCount = 5, cloud, engine, signal }) {
    const seed = text(idea, MAX_IDEA_CHARS);
    const count = positiveInt(volumeCount, 5, 1, 30);
    // 分卷要列出每卷的卷纲，30 卷同样会超预算，给足 8192。
    const raw = await generate({ ...volumesPrompt(seed, structure, count), cloud, engine, signal, maxTokens: 8192 });
    const data = requireJson(raw);
    const list = Array.isArray(data.volumes) ? data.volumes : [];
    return list
      .map((item, index) => ({
        id: `vol-${index + 1}`,
        seq: positiveInt(item.seq, index + 1, 1, 999),
        title: text(item.title, 120) || `第${index + 1}卷`,
        outline: text(item.outline, 4000),
        chapterFrom: positiveInt(item.chapterFrom, 0, 0, 99999),
        chapterTo: positiveInt(item.chapterTo, 0, 0, 99999),
      }))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, 30);
  }

  /**
   * 章纲：分批生成。
   *
   * 一次要 20 章会失败——带推理的模型把 max_tokens 全花在 reasoning_content 上，
   * 正文（JSON）一个字都没吐出来就被截断（实测 finish_reason=length、
   * content 空、reasoning 6417 字符）。分批既压住了思考量，也让失败只丢一批。
   *
   * 每批 5 章是实测出来的：3 章稳过，20 章必败，5 章在安全区内。
   */
  /**
   * 章纲：分批 + 自适应降批。
   *
   * 实测这个模型（deepseek-v4.1-flash）的推理用量**随机**：
   * 同一提示词有时 reasoning_content 为 0（5 章一次成功），
   * 有时吃掉 6000+ token 导致正文被截断（finish_reason=length、content 空）。
   * 所以不能靠固定批大小赌运气，必须「截断就拆半重试」。
   *
   * 降到 1 章还截断就说明是模型侧问题，直接报错让用户换模型。
   */
  async function chapters({ idea, structure = {}, volumes = [], chapterCount = 20, cloud, engine, signal, batchSize = 5 }) {
    const seed = text(idea, MAX_IDEA_CHARS);
    const total = positiveInt(chapterCount, 20, 1, 200);
    const collected = [];

    /** 生成 [from,to] 这一段，遇到截断就拆半递归。 */
    async function generateRange(from, to) {
      if (signal?.aborted) throw new NovelAiError("生成已取消", { status: 400, code: "cancelled" });
      const size = to - from + 1;
      let raw;
      try {
        raw = await generate({
          ...chaptersPrompt(seed, structure, volumes, size, {
            from,
            to,
            // 带上已生成的尾部，否则每批各写各的、接不上。
            previous: collected.slice(-3).map((c) => `第${c.seq}章《${c.title}》：${c.outline}`),
          }),
          cloud, engine, signal, maxTokens: 8192,
        });
      } catch (error) {
        // 降批只针对「输出为空/被截断」这一类症状——本地和云端的报错文案不同
        // （local_empty / truncated_by_reasoning / cloud_failed+截断），
        // 但它们根因相同：模型的思考把输出预算吃光了。
        // 配置类错误（没配 key、连不上 ComfyUI）不降批，直接抛给用户。
        const outputEmpty = ["novel_ai_local_empty", "novel_ai_truncated_by_reasoning", "novel_ai_empty_body"].includes(error?.code)
          || (error?.code === "novel_ai_cloud_failed" && /截断|length/.test(error.message));
        if (outputEmpty) {
          if (size <= 1) {
            throw new NovelAiError(
              "连单章章纲都被推理截断了。这个模型的推理长度不可控，请换用不带长推理的模型（如非 reasoning 版本）。",
              { status: 502, code: "novel_ai_reasoning_uncontrollable" },
            );
          }
          const mid = from + Math.floor(size / 2) - 1;
          logger?.warn?.(`章纲第 ${from}-${to} 章被推理截断，拆成 ${from}-${mid} 与 ${mid + 1}-${to} 重试`);
          await generateRange(from, mid);
          await generateRange(mid + 1, to);
          return;
        }
        throw error;
      }
      // JSON 被截成半截也会抛 bad_json：这是「输出预算不够」的另一种表现，
      // 和空内容一样应该降批重试，而不是让整批失败。
      let data;
      try {
        data = requireJson(raw);
      } catch (error) {
        if (size > 1) {
          const mid = from + Math.floor(size / 2) - 1;
          logger?.warn?.(`章纲第 ${from}-${to} 章返回不完整 JSON，拆成 ${from}-${mid} 与 ${mid + 1}-${to} 重试`);
          await generateRange(from, mid);
          await generateRange(mid + 1, to);
          return;
        }
        throw new NovelAiError(
          `第 ${from} 章返回不完整 JSON。这个模型的输出长度不稳定，请重试或减少单次生成数量。`,
          { status: 502, code: "novel_ai_bad_json" },
        );
      }
      const list = Array.isArray(data.chapters) ? data.chapters : [];
      if (!list.length) {
        if (size > 1) {
          // 空批次同样可能是思考过长导致，按同一策略拆半。
          const mid = from + Math.floor(size / 2) - 1;
          logger?.warn?.(`章纲第 ${from}-${to} 章返回空，拆半重试`);
          await generateRange(from, mid);
          await generateRange(mid + 1, to);
          return;
        }
        throw new NovelAiError(`第 ${from} 章没有生成出章纲，请重试`, { status: 502, code: "novel_ai_empty_batch" });
      }
      // 模型给错 seq 时按段内顺序纠正，避免覆盖已有章节。
      list.forEach((item, index) => {
        collected.push({
          id: `ch-${from + index}`,
          seq: from + index,
          title: text(item.title, 200) || `第${from + index}章`,
          // 卷号必须落在真实存在的卷里：没生成分卷时模型会瞎猜
          // （实测 20 章被分到卷 1/2/3/4 又跳回 1），统一归卷 1。
          volume: normalizeVolumeNo(item.volume, volumes, from + index),
          outline: text(item.outline, 4000),
          novel: "",
          status: "outlined",
        });
      });
    }

    const perBatch = positiveInt(batchSize, 5, 1, 10);
    for (let start = 1; start <= total; start += perBatch) {
      await generateRange(start, Math.min(total, start + perBatch - 1));
    }

    return collected.sort((a, b) => a.seq - b.seq).slice(0, total);
  }

  /** 单章正文。一次一章是硬约束：4096 token 装不下整本。 */
  async function chapterBody({ idea, structure = {}, volume = null, chapter, context = "", targetWords = 1200, cloud, engine, signal }) {
    if (!chapter?.outline) throw new NovelAiError("这一章还没有章纲，先生成章纲", { status: 400, code: "novel_outline_required" });
    const words = positiveInt(targetWords, 1200, 300, 6000);
    const raw = await generate({
      ...chapterBodyPrompt({ idea: text(idea, MAX_IDEA_CHARS), structure, volume, chapter, context, targetWords: words }),
      cloud, engine, signal, deadlineMs: 900000,
      // 正文长度直接决定预算：每字约 1.5 token，留 2 倍余量给推理。
      maxTokens: Math.min(8192, Math.max(2048, Math.ceil(words * 3))),
    });
    const body = String(raw || "").trim();
    if (!body) throw new NovelAiError("模型没有返回正文", { status: 502, code: "novel_ai_empty_body" });
    return body;
  }

  return { outline, volumes, chapters, chapterBody };
}