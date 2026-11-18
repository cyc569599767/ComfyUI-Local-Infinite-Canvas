/**
 * 故事 → 分镜的 AI 拆解。
 *
 * 只做一件事：把一段故事拆成可执行的分镜表，字段对齐闲兔导演台的结构，
 * 这样本项目生成的分镜能直接导出到 ComfyUI 原生导演台继续跑。
 *
 * 刻意保持「无 LLM 也能用」：AI 失败时抛明确错误，由前端提示用户手动建分镜，
 * 不偷偷返回半成品——半成品分镜比没有更浪费时间。
 */
import { cloudChat } from "./prompt-optimizer.js";

const MAX_STORY_CHARS = 12000;
const MAX_SHOTS = 60;

const VIDEO_MODES = ["图生视频", "首尾帧", "多参考图", "文生视频", "参考视频", "视频延长"];

export class StoryboardAiError extends Error {
  constructor(message, { status = 502, code = "storyboard_ai_failed", details } = {}) {
    super(message);
    this.name = "StoryboardAiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function systemPrompt(maxShotSeconds) {
  return [
    "你是分镜导演。把用户的故事拆成可直接执行的镜头表。",
    "只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。",
    "",
    "JSON 结构：",
    `{"style":"整体视觉风格","beats":[{"id":"beat-1","summary":"剧情节点","act":"起|承|转|合"}],`,
    ` "characters":[{"id":"char-1","name":"角色名","role":"主角|配角","appearance":"外形","wardrobe":"服装"}],`,
    ` "scenes":[{"id":"scene-1","name":"场景名","time":"时间","weather_environment":"环境"}],`,
    ` "props":[{"id":"prop-1","name":"道具名","category":"类别","appearance":"外观"}],`,
    ` "shots":[{"id":"shot-1","title":"镜头标题","duration":5,`,
    `   "shot_type":"远景|全景|中景|近景|特写","camera_angle":"平视|俯拍|仰拍|斜侧",`,
    `   "story_beat":"这一镜承担的剧情","opening_state":"开场状态","action_progression":"动作推进","ending_state":"收尾状态",`,
    `   "dialogue":"台词，可为空","positive":"完整画面提示词","negative":"要避免的内容",`,
    `   "video_mode":"${VIDEO_MODES.join("|")}",`,
    `   "protagonist_refs":["char-1"],"scene_ref":"scene-1","prop_refs":[]}]}`,
    "",
    "规则：",
    `- 每个镜头 duration 是 1-${maxShotSeconds} 的整数秒；镜头总时长要能覆盖故事节奏。`,
    "- positive 必须是可直接出图的完整中文提示词：主体、动作、环境、光线、色彩、构图、镜头语言，不要写“同上”。",
    "- refs 里只能引用你在 characters/scenes/props 中定义过的 id，不要编造 id。",
    "- 同一个角色在不同镜头里的 appearance/wardrobe 必须一致，这是人物不漂移的前提。",
    "- video_mode 按内容选择：单人连续动作用图生视频；需要精确起止画面用首尾帧；多角色互动或多素材参考用多参考图；纯环境描写可用文生视频。",
    "- 不要输出任何 JSON 之外的内容。",
  ].join("\n");
}

/** 从可能带代码块/前言的回包里抠出第一个完整 JSON 对象。 */
function extractJson(content) {
  const text = String(content || "").trim();
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  // 从第一个 { 开始做括号配对，避免尾部多余说明破坏 JSON.parse。
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
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
          return JSON.parse(candidate.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 抢救被截断的 JSON。
 *
 * 本地 9B 模型的 max_tokens 上限是 4096，镜头一多就会在半句话处被硬切，
 * 这时 JSON 括号不闭合、parse 必然失败。但前面已经完整输出的镜头是真实的，
 * 直接丢给用户重跑只会再截一次。这里按「已知完整成员」回填出合法 JSON。
 */
function salvageTruncatedJson(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  if (start < 0) return null;

  // 找到最后一个完整的对象/数组元素收尾位置：截断点前最后一个 `}` 或 `]`。
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastComplete = -1;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth >= 1) lastComplete = index;
      if (depth === 0) return null; // 已经闭合，不该走到这里
    }
  }
  if (lastComplete < 0) return null;

  // 从截断点回退，补上缺失的闭合符号。最多补 8 层，防止病态输入。
  let body = raw.slice(start, lastComplete + 1);
  let open = 0;
  inString = false;
  escaped = false;
  for (const char of body) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") open += 1;
    else if (char === "}" || char === "]") open -= 1;
  }
  // 回退到最后一个完整的数组元素之后，属于哪个容器就补哪种括号。
  const closers = [];
  let guard = 0;
  const stack = [];
  inString = false;
  escaped = false;
  for (const char of body) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") stack.pop();
  }
  while (stack.length && guard < 8) {
    closers.push(stack.pop());
    guard += 1;
  }
  body = body + closers.join("");
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function text(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function textList(value, max = 12, maxLength = 120) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, maxLength)).filter(Boolean).slice(0, max);
}

function positiveInt(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * 把模型返回的松散 JSON 收敛成项目可用的形状。
 * 这里做的是「保底」而不是「改造」：能用的字段原样保留，缺失的给合理默认。
 */
function normalizeBoard(board, { maxShotSeconds, targetShotCount }) {
  if (!board || typeof board !== "object") return null;
  const characters = (Array.isArray(board.characters) ? board.characters : [])
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const name = text(item.name, 120);
      if (!name) return null;
      return {
        id: text(item.id, 64) || `char-${index + 1}`,
        name,
        role: text(item.role, 60) || "配角",
        appearance: text(item.appearance, 800),
        wardrobe: text(item.wardrobe, 800),
      };
    })
    .filter(Boolean);
  const scenes = (Array.isArray(board.scenes) ? board.scenes : [])
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const name = text(item.name, 120);
      if (!name) return null;
      return {
        id: text(item.id, 64) || `scene-${index + 1}`,
        name,
        time: text(item.time, 120),
        weather_environment: text(item.weather_environment, 300),
        spatial_structure: text(item.spatial_structure, 300),
        fixed_visuals: text(item.fixed_visuals, 300),
      };
    })
    .filter(Boolean);
  const props = (Array.isArray(board.props) ? board.props : [])
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const name = text(item.name, 120);
      if (!name) return null;
      return { id: text(item.id, 64) || `prop-${index + 1}`, name, category: text(item.category, 120), appearance: text(item.appearance, 800) };
    })
    .filter(Boolean);

  const characterIds = new Set(characters.map((item) => item.id));
  const sceneIds = new Set(scenes.map((item) => item.id));
  const propIds = new Set(props.map((item) => item.id));
  // 只保留真实存在的引用：让模型编造 id 属于幻觉，不能带进后续生成。
  const keepRefs = (list, allowed) => textList(list).filter((id) => allowed.has(id));

  const usedIds = new Set();
  const shots = (Array.isArray(board.shots) ? board.shots : [])
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      let id = text(item.id, 64) || `shot-${index + 1}`;
      if (usedIds.has(id)) id = `${id}-${index + 1}`;
      usedIds.add(id);
      const positive = text(item.positive ?? item.prompt, 4000);
      if (!positive) return null;
      return {
        id,
        selected: false,
        title: text(item.title, 160) || `镜头 ${index + 1}`,
        duration: positiveInt(item.duration, 5, 1, maxShotSeconds),
        shot_type: text(item.shot_type, 64),
        camera_angle: text(item.camera_angle, 64),
        story_beat: text(item.story_beat, 600),
        opening_state: text(item.opening_state, 600),
        action_progression: text(item.action_progression, 900),
        ending_state: text(item.ending_state, 600),
        dialogue: text(item.dialogue, 900),
        positive,
        negative: text(item.negative, 2000),
        video_mode: VIDEO_MODES.includes(text(item.video_mode, 40)) ? text(item.video_mode, 40) : "图生视频",
        protagonist_refs: keepRefs(item.protagonist_refs, characterIds),
        supporting_refs: keepRefs(item.supporting_refs, characterIds),
        prop_refs: keepRefs(item.prop_refs, propIds),
        scene_ref: sceneIds.has(text(item.scene_ref, 300)) ? text(item.scene_ref, 300) : "",
      };
    })
    .filter(Boolean)
    .slice(0, Math.min(MAX_SHOTS, targetShotCount || MAX_SHOTS));

  if (!shots.length) return null;
  const beats = (Array.isArray(board.beats) ? board.beats : [])
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const summary = text(item.summary, 600);
      if (!summary) return null;
      return { id: text(item.id, 64) || `beat-${index + 1}`, summary, act: text(item.act, 40) };
    })
    .filter(Boolean);

  return { style: text(board.style, 300), beats, characters, scenes, props, shots };
}

/** 从 ComfyUI 的 history 里捞出执行失败的具体原因，而不是只报「失败」。 */
function describeHistoryError(entry) {
  const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
  // 结构是 [[事件名, { exception_message, ... }], ...]，异常正文在第二个元素里，
  // 只读 item.message 会永远拿到事件名（例如 "execution_error"）。
  const parts = [];
  for (const item of messages) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!Array.isArray(item)) continue;
    const [, payload] = item;
    const detail = payload?.exception_message || payload?.message || "";
    if (detail) parts.push(detail);
  }
  return parts.join("；");
}

export function createStoryboardAi({ logger, comfy = null, localModel = "Qwen3.5-9B-Q4_K_M.gguf" } = {}) {
  /**
   * 走本机 ComfyUI 的 llama.cpp 节点做拆解。
   *
   * 本项目默认只有「本地 ComfyUI」一个渠道，它没有 /v1/chat/completions，
   * 所以要求用户先配云端 key 等于把这个功能锁死。本机已经装了 Qwen GGUF 和
   * llama_cpp 节点，就直接用它们——和提示词优化是同一条本地链路。
   */
  async function breakdownLocal({ system, userText, signal, deadlineMs = 600000 }) {
    if (!comfy) {
      throw new StoryboardAiError("本地拆解不可用：网关没有连接 ComfyUI", { status: 503, code: "storyboard_ai_no_comfy" });
    }
    const workflow = {
      "1": {
        class_type: "llama_cpp_model_loader",
        inputs: { model: localModel, mmproj: "None", chat_handler: "None", n_ctx: 16384, vram_limit: -1, image_min_tokens: 0, image_max_tokens: 0, load_mtp: false },
        _meta: { title: "Storyboard LLM" },
      },
      // 必须挂 parameters：不挂时 max_tokens 用节点默认 1024，
      // 4 镜的完整 JSON 会在 3499 字符处被硬截断（JSON 解析直接失败）。
      // 该节点 max_tokens 上限是 4096，再多只能减少镜头数。
      "5": {
        class_type: "llama_cpp_parameters",
        inputs: { max_tokens: 4096, top_k: 40, top_p: 0.9, min_p: 0.05, typical_p: 1, temperature: 0.35, repeat_penalty: 1.05, frequency_penalty: 0, present_penalty: 0, mirostat_mode: 0, mirostat_eta: 0.1, mirostat_tau: 5, state_uid: -1 },
        _meta: { title: "Storyboard sampling" },
      },
      "3": {
        class_type: "llama_cpp_instruct_adv",
        inputs: {
          llama_model: ["1", 0],
          parameters: ["5", 0],
          preset_prompt: "Empty - Nothing",
          custom_prompt: userText,
          system_prompt: system,
          // 合法值只有 one by one / images / video；纯文本拆解用 one by one，
          // 另外 max_frames 最小值是 2（1 会被 ComfyUI 校验直接拒绝）。
          inference_mode: "one by one",
          max_frames: 2,
          max_size: 512,
          seed: 0,
          force_offload: true,
          save_states: false,
        },
        _meta: { title: "Storyboard breakdown" },
      },
      "4": {
        class_type: "TE_text_display",
        inputs: { text: "", input_text: ["3", 0], use_edited_text: false, edited_from_text: "" },
        _meta: { title: "Storyboard output" },
      },
    };

    const submitted = await comfy.submit(workflow, { signal });
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
          throw new StoryboardAiError("分镜拆解已取消", { status: 400, code: "cancelled" });
        }
        // comfy.history() 已经返回该 promptId 的 entry 本身（内部做过 data[promptId]），
        // 这里不能再套一层 [promptId]，否则永远取不到、白等到超时。
        const entry = await comfy.history(promptId);
        if (entry) {
          const status = entry.status?.status_str;
          if (status === "error") {
            running = false;
            throw new StoryboardAiError(`本地模型执行失败：${describeHistoryError(entry) || "未知错误"}`, { status: 502, code: "storyboard_ai_local_failed" });
          }
          if (entry.status?.completed) {
            running = false;
            const output = entry.outputs?.["4"];
            const value = output?.text?.[0] ?? output?.string?.[0] ?? output?.text;
            if (typeof value === "string" && value.trim()) return value;
            throw new StoryboardAiError("本地模型没有返回文本输出", { status: 502, code: "storyboard_ai_local_empty" });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      await cancel();
      throw new StoryboardAiError("本地拆解超时（模型加载或推理过慢）", { status: 504, code: "storyboard_ai_local_timeout" });
    } finally {
      running = false;
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  async function breakdown({ story, style = "", maxShotSeconds = 10, targetShotCount = 0, cloud = {}, engine = "local", signal }) {
    const text0 = text(story, MAX_STORY_CHARS);
    if (!text0) throw new StoryboardAiError("请先填写故事内容", { status: 400, code: "storyboard_story_required" });
    const useCloud = String(engine || "local").toLowerCase() === "cloud";
    if (useCloud && (!cloud?.baseUrl || !cloud?.apiKey || !cloud?.model)) {
      throw new StoryboardAiError("请先在设置里配置云端模型的 Base URL、API Key 和模型，AI 拆解需要它", {
        status: 400,
        code: "storyboard_ai_not_configured",
      });
    }
    const maxSeconds = positiveInt(maxShotSeconds, 10, 1, 60);
    const wantCount = positiveInt(targetShotCount, 0, 0, MAX_SHOTS);
    const userText = [
      style ? `整体风格偏好：${text(style, 300)}` : "",
      wantCount ? `期望镜头数量：约 ${wantCount} 个（可以浮动）` : "",
      `单个镜头最长 ${maxSeconds} 秒。`,
      "",
      "故事：",
      text0,
    ].filter(Boolean).join("\n");

    const started = Date.now();
    let content;
    try {
      content = useCloud
        ? // 拆解要吐出整张分镜表（几十个字段 × N 镜），比普通提示词慢得多；
        // 带 reasoning 的模型更慢，120 秒不够，给 8 分钟。
          (await cloudChat({ system: systemPrompt(maxSeconds), userText, cloud, signal, temperature: 0.4, maxTokens: 8192, timeoutMs: 480000 })).content
        : await breakdownLocal({ system: systemPrompt(maxSeconds), userText, signal });
    } catch (error) {
      if (error instanceof StoryboardAiError) throw error;
      // 复用 cloudChat 的报错文案：配置缺失/超时/HTTP 失败都已分类，不再二次包装。
      throw new StoryboardAiError(error?.message || "AI 拆解请求失败", { status: error?.status || 502, code: error?.code || "storyboard_ai_failed" });
    }

    let parsed = extractJson(content);
    let truncated = false;
    if (!parsed) {
      // 本地 9B 的 max_tokens 上限 4096，镜头一多必被硬切。
      // 前面已经完整的镜头是真实产出，抢救出来远好过让用户重跑再被切一次。
      parsed = salvageTruncatedJson(content);
      truncated = Boolean(parsed);
    }
    if (!parsed) {
      throw new StoryboardAiError("AI 返回的内容不是有效 JSON，请重试，或换一个支持结构化输出的模型", {
        status: 502,
        code: "storyboard_ai_bad_json",
        details: { sample: text(content, 800) },
      });
    }
    const board = normalizeBoard(parsed, { maxShotSeconds: maxSeconds, targetShotCount: wantCount });
    if (!board) {
      throw new StoryboardAiError("AI 没有返回可用的镜头（positive 全为空），请补充故事细节后重试", {
        status: 502,
        code: "storyboard_ai_empty_shots",
      });
    }
    if (truncated) {
      logger?.warn?.(`分镜拆解输出被截断，已抢救 ${board.shots.length} 镜（max_tokens=${useCloud ? 8192 : 4096}）`);
    }
    logger?.info?.(`分镜拆解完成：${board.shots.length} 镜，${Date.now() - started}ms`);
    return { ...board, provider: useCloud ? "cloud" : "local", truncated, elapsedMs: Date.now() - started };
  }

  return { breakdown };
}
