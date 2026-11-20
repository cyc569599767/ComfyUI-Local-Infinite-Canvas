// 本地 ComfyUI 音频能力（上游 v0.25.3 audio-local.js 的 ComfyUI 分支）。
//
// 边界说明：
// - 本分支的 /v1/audio/speech 仍由「自由卡片 + 注册表工作流」驱动（音色设计/克隆/音乐三种 mode），
//   不能被这里的实现覆盖；因此 IndexTTS 台词走独立路由 /v1/audio/speech-indextts。
// - 上游 audio-local.js 里依赖本地 Python venv 的 generateSong（ACE-Step UI 工作流）以及
//   audio-engine.js 的 runYue2Song / runSoulXVoice 不随本分支提供运行环境，未纳入。

import { runWorkflow } from "./runner.js";
import { uploadImages } from "./uploads.js";
import { autoSongDuration } from "./audio-song.js";

const AUDIO_EXT = /\.(wav|mp3|flac|ogg|m4a|aac)$/i;

function pickAudio(files) {
  return files.find((f) => /^audio\//i.test(f.mimeType || "") || AUDIO_EXT.test(f.filename || ""));
}

// 画布会把上游文本块编号成「【文本1】」再拼进生成提示词；台词/歌曲标签不能把这层编号念出来。
export function stripCanvasTextLabels(text) {
  return String(text || "").replace(/(^|\n)\s*【文本\s*\d+】\s*/g, "$1").trim();
}

function uploadedAudioName(uploaded) {
  if (!uploaded?.name) return "";
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

async function uploadReference(comfy, referenceFile) {
  if (!referenceFile?.buffer) return "";
  const [uploaded] = await uploadImages(comfy, [referenceFile]);
  const name = uploadedAudioName(uploaded);
  if (!name) throw Object.assign(new Error("参考音频上传失败"), { status: 502, code: "reference_upload_failed" });
  return name;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

async function runAndPick({ workflow, name, comfy, config, logger, signal, requestId }) {
  const result = await runWorkflow({
    entry: { name, type: "audio", workflow, bindings: {}, defaults: {}, presets: {} },
    context: { prompt: "", count: 1, params: {} },
    comfy,
    timeoutMs: config.requestTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    signal,
    requestId,
    logger,
  });
  const file = pickAudio(result.files);
  if (!file) throw Object.assign(new Error("本地语音工作流没有返回音频输出"), { status: 502, code: "no_audio_output" });
  return { buffer: file.buffer, mimeType: file.mimeType || "audio/wav", filename: file.filename };
}

// 台词 / 零样本克隆：IndexTTS-2（本地节点）。reference 为必填参考音频；instructions 走情绪文本节点。
export async function synthesizeSpeech({ comfy, config, logger, text, seed, speed, instructions, referenceFile, signal, requestId }) {
  const content = stripCanvasTextLabels(text);
  if (!content) throw Object.assign(new Error("台词文本不能为空"), { status: 400, code: "missing_text" });
  const description = String(instructions || "").trim();
  if (!referenceFile?.buffer) {
    throw Object.assign(new Error("台词生成需要参考音色，请先上传 3–15 秒参考音频"), { status: 400, code: "missing_reference_audio" });
  }
  const referenceName = await uploadReference(comfy, referenceFile);
  const speechSpeed = clampNumber(speed, 1, 0.5, 2);
  const seedValue = Number.isFinite(seed) ? Math.trunc(seed) : Math.floor(Math.random() * 2 ** 32);
  const workflow = {
    "1": { class_type: "easy downloadIndexTTSAndLoadModel", inputs: { model: "IndexTTS-2", download_from: "modelscope" } },
    "2": { class_type: "LoadAudio", inputs: { audio: referenceName } },
    "3": {
      class_type: "easy indexTTSGenerate",
      inputs: {
        indextts_model: ["1", 0],
        text: content,
        unload_model: true,
        do_sample: true,
        temperature: 0.8,
        top_p: 0.9,
        top_k: 30,
        num_beams: 3,
        repetition_penalty: 10.0,
        length_penalty: 0.0,
        max_mel_tokens: 1815,
        max_tokens_per_sentence: 120,
        speech_speed: speechSpeed,
        seed: seedValue,
        ...(description ? { emotions: ["5", 0] } : { reference_audio: ["2", 0] }),
      },
    },
    "4": { class_type: "SaveAudio", inputs: { audio: ["3", 0], filename_prefix: "audio/indextts2" } },
  };
  if (description) {
    workflow["5"] = {
      class_type: "easy indexTTSEmotionText",
      inputs: { reference_audio: ["2", 0], voice_name: "", description, use_random: false },
    };
  }
  return runAndPick({ workflow, name: "indextts2-speech", comfy, config, logger, signal, requestId });
}

// 无参考台词：MiniMax H3 描述音色语音（T8 Speech Studio），不给参考音频也能自然说话。
const H3_SPEECH_LANGUAGES = {
  zh: "Chinese", en: "English", ja: "Japanese", ko: "Korean", fr: "French",
  de: "German", es: "Spanish", it: "Italian", pt: "Portuguese", ru: "Russian", ar: "Arabic",
};
const H3_DEFAULT_VOICE = {
  Chinese: "一位成年女声，自然温暖，像面对面聊天，吐字清晰，情绪克制，有真实的停顿。",
  English: "An adult speaker with a natural warm voice, clear diction, human micro-pauses, and close conversational delivery.",
};

function estimateSpeechSeconds(text) {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  const words = text.replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, " ").trim().split(/\s+/).filter(Boolean).length;
  return cjk * 0.26 + words * 0.42 + 1.5;
}

export async function synthesizeSpeechH3({ comfy, config, logger, text, voiceDescription, instructions, language, seed, signal, requestId }) {
  const content = stripCanvasTextLabels(text);
  if (!content) throw Object.assign(new Error("台词文本不能为空"), { status: 400, code: "missing_text" });
  const h3Language = H3_SPEECH_LANGUAGES[String(language || "zh").trim()] || "";
  if (!h3Language) throw Object.assign(new Error("H3 语音不支持该语言"), { status: 400, code: "unsupported_language" });
  const seconds = estimateSpeechSeconds(content);
  if (seconds > 15.08) {
    throw Object.assign(new Error(`台词约 ${Math.ceil(seconds)} 秒，超过 H3 单段约 15 秒上限；请把台词拆成多段再生成`), { status: 400, code: "text_too_long" });
  }
  const renderSeconds = clampNumber(seconds, 5.2, 5.17, 15.08);
  const description = String(voiceDescription || "").trim() || H3_DEFAULT_VOICE[h3Language] || H3_DEFAULT_VOICE.English;
  const direction = String(instructions || "").trim() || "自然、真诚、像面对面交谈，语速自然";
  const seedValue = Number.isFinite(seed) ? Math.trunc(seed) : Math.floor(Math.random() * 2 ** 31);
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3_int8_convrot.safetensors", type: "minimax", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
    "5": {
      class_type: "MiniMaxH3VoiceProfileT8",
      inputs: {
        voice_mode: "described_voice",
        speaker_id: "narrator",
        voice_description: description,
        language: h3Language,
        rights_confirmed: false,
        reference_start_seconds: 0,
        reference_duration_seconds: 0,
        highpass_60hz: true,
        peak_limit_minus_3_dbfs: true,
      },
    },
    "6": {
      class_type: "MiniMaxH3SpeechPlanT8",
      inputs: {
        voice_profile: ["5", 0],
        text: content,
        language: h3Language,
        acting_direction: direction,
        emotion: "neutral",
        emotion_intensity: 0.4,
        space: "studio",
        chunking: "single_segment",
        target_units: 18,
        max_units: 24,
      },
    },
    "7": {
      class_type: "MiniMaxH3SpeechStudioT8",
      inputs: {
        model: ["1", 0],
        clip: ["2", 0],
        video_vae: ["3", 0],
        audio_vae: ["4", 0],
        voice_profile: ["5", 0],
        speech_plan: ["6", 0],
        segment_index: 0,
        seed: seedValue,
        render_seconds: renderSeconds,
        resolution: 32,
        steps: 20,
        sampler_name: "res_multistep",
        scheduler: "simple",
        shift_video: 12,
        shift_audio: 3,
        trim_mode: "none",
        verify_mode: "off",
        asr_model_directory: "",
        asr_language: h3Language,
        min_similarity: 0.85,
        unload_asr_after_verify: true,
        speaker_check_mode: "off",
        speaker_model_directory: "",
        min_speaker_similarity: 0.86,
        unload_speaker_after_verify: true,
        peak_limit_dbfs: -1,
        release_policy: "unload_all_models",
      },
    },
    "8": { class_type: "SaveAudio", inputs: { audio: ["7", 0], filename_prefix: "audio/h3_speech" } },
  };
  return runAndPick({ workflow, name: "h3-speech", comfy, config, logger, signal, requestId });
}

// 歌曲：ComfyUI 官方 YuE2 Text-to-Music 口径 —— ABC 规划 → GenerateMusic → KSampler(cfg=1,32) → VAE。
const YUE2_COMFY_DEFAULT_CHECKPOINT = "yue2_3b_int8_convrot.safetensors";
export const YUE2_PRECISION_CHECKPOINTS = Object.freeze({
  fast: YUE2_COMFY_DEFAULT_CHECKPOINT,
  quality: "yue2_3b_bf16.safetensors",
});

export function resolveYue2Precision(rawPrecision, { envCheckpoint = "", bf16Installed = null } = {}) {
  const raw = rawPrecision === undefined || rawPrecision === null ? "" : String(rawPrecision).trim().toLowerCase();
  const precision = raw || "fast";
  if (precision !== "fast" && precision !== "quality") {
    const error = new Error('precision 只支持 "fast" 或 "quality"');
    error.status = 400;
    error.code = "invalid_precision";
    throw error;
  }
  if (precision === "quality") {
    if (bf16Installed === false) {
      const error = new Error("YuE2 质量档需要 yue2_3b_bf16.safetensors；请到资源中心安装 YuE2-3B BF16 后重试");
      error.status = 503;
      error.code = "audio_model_missing";
      error.details = { engine: "comfyui", resourceId: "yue2_3b_bf16" };
      throw error;
    }
    return { precision, checkpoint: YUE2_PRECISION_CHECKPOINTS.quality };
  }
  return { precision, checkpoint: String(envCheckpoint || "").trim() || YUE2_PRECISION_CHECKPOINTS.fast };
}

export function buildYue2ComfyWorkflow({ style, lyrics, seed, mode = "full", seconds = 120, checkpoint = YUE2_COMFY_DEFAULT_CHECKPOINT, instrumental = false }) {
  const rawSeconds = Number(seconds);
  const resolvedSeconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : instrumental ? 200 : autoSongDuration(lyrics);
  const maxDuration = Math.round(clampNumber(resolvedSeconds, instrumental ? 200 : 120, 10, 300));
  const safeSeed = Math.trunc(clampNumber(seed, Date.now() % 2147483647, 0, Number.MAX_SAFE_INTEGER));
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "2": {
      class_type: "YuE2GenerateABC",
      inputs: { clip: ["1", 1], style, lyrics, seed: safeSeed, mode, max_abc_tokens: 8192, temperature: 0.7, top_p: 0.9, top_k: 30, repetition_penalty: 1.005, penalty_window: 100 },
    },
    ...(instrumental ? { "9": { class_type: "YuE2InstrumentalConvert", inputs: { abc: ["2", 0], overlap: "vocal", keep_chords: true } } } : {}),
    "3": {
      class_type: "YuE2GenerateMusic",
      inputs: { clip: ["1", 1], style, lyrics, abc: instrumental ? ["9", 0] : ["2", 0], seed: safeSeed, mode, max_duration: maxDuration, temperature: 1.0, top_p: 0.95, top_k: 100, repetition_penalty: 1.2 },
    },
    "4": { class_type: "EmptyYuE2LatentAudio", inputs: { seconds: ["3", 1], batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: { model: ["1", 0], positive: ["3", 0], negative: ["6", 0], latent_image: ["4", 0], seed: safeSeed, steps: 32, cfg: 1, sampler_name: "dpm_2", scheduler: "sgm_uniform", denoise: 1 },
    },
    "6": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["3", 0] } },
    "7": { class_type: "VAEDecodeAudio", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "8": { class_type: "SaveAudio", inputs: { audio: ["7", 0], filename_prefix: "audio/yue2" } },
  };
}

export async function runYue2ComfySong({ comfy, config, logger, style, lyrics, seed, cot = "full", duration, signal, requestId, checkpoint, instrumental = false }) {
  const mode = String(cot || "full").toLowerCase();
  const workflow = buildYue2ComfyWorkflow({
    style,
    lyrics,
    seed,
    mode: mode === "melody" ? "melody" : mode === "off" ? "off" : "full",
    seconds: duration,
    checkpoint,
    instrumental,
  });
  const result = await runAndPick({ workflow, name: instrumental ? "yue2-comfy-instrumental" : "yue2-comfy-song", comfy, config, logger, signal, requestId });
  return { buffer: result.buffer, mimeType: result.mimeType || "audio/flac", meta: { engine: "yue2-comfy", instrumental } };
}
