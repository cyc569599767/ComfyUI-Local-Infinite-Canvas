/**
 * 「故事分镜导演台」的服务端存储。
 *
 * 字段结构对齐闲兔 XiantuStoryboardDirector 的 storyboard_json，原因有二：
 * 1) 用户在 ComfyUI 原生导演台里已有的项目可以直接粘进来，不用重新拆一遍；
 * 2) 需要时能把这里的项目原样导出，丢回 ComfyUI 继续跑它的批量队列。
 *
 * 存的是纯数据（项目、资产、分镜），不含图片本体——素材走现有的画布/资产存储，
 * 这里只记引用，所以体积可控，整份读写即可。
 */
import fsp from "node:fs/promises";
import path from "node:path";

import { nowIso, randomId, writeJsonAtomic } from "./util.js";

const FILE_NAME = "storyboard-projects.json";
const VERSION = 3;
export const MAX_SHOTS = 500;
export const MAX_ASSETS_PER_KIND = 200;

const ASSET_KINDS = ["characters", "scenes", "props"];
const VIDEO_MODES = ["图生视频", "首尾帧", "多参考图", "文生视频", "参考视频", "视频延长"];
const IMAGE_ENGINES = ["Qwen Image 2.1", "KR"];
const IMAGE_MODES = ["文生图", "图片编辑"];
const SELECTION_MODES = ["当前分镜", "勾选分镜", "从当前开始"];

function text(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function textList(value, max = 16, maxLength = 200) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, maxLength)).filter(Boolean).slice(0, max);
}

function oneOf(value, allowed, fallback) {
  const candidate = text(value, 64);
  return allowed.includes(candidate) ? candidate : fallback;
}

function positiveInt(value, fallback, min = 1, max = 9999) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 资产（角色/场景/道具）共用一个形状，kind 用来区分表。 */
function normalizeAsset(raw, index, kind) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id, 64) || `${kind}-${index + 1}`;
  const name = text(raw.name, 120);
  if (!name && !text(raw.appearance, 400)) return null;
  const base = {
    id,
    name: name || id,
    image_prompt: text(raw.image_prompt ?? raw.prompt, 2000),
    negative_prompt: text(raw.negative_prompt, 1000),
    image_prompt_engine: oneOf(raw.image_prompt_engine, IMAGE_ENGINES, "Qwen Image 2.1"),
    image_task_id: text(raw.image_task_id, 120) || undefined,
    image_url: text(raw.image_url, 2048) || undefined,
    image_storage_key: text(raw.image_storage_key, 512) || undefined,
  };
  if (kind === "characters") {
    return { ...base, kind: "character", role: text(raw.role, 120), appearance: text(raw.appearance, 800), wardrobe: text(raw.wardrobe, 800) };
  }
  if (kind === "scenes") {
    return {
      ...base,
      kind: "scene",
      time: text(raw.time, 120),
      weather_environment: text(raw.weather_environment, 300),
      spatial_structure: text(raw.spatial_structure, 300),
      fixed_visuals: text(raw.fixed_visuals, 300),
    };
  }
  return { ...base, kind: "prop", category: text(raw.category, 120), appearance: text(raw.appearance, 800) };
}

/**
 * 单个分镜。字段名沿用官方结构（shot_id/positive/negative/...），
 * 这样导出后 ComfyUI 那边能直接认。
 */
function normalizeShot(raw, index, usedIds) {
  if (!raw || typeof raw !== "object") return null;
  let id = text(raw.id ?? raw.shot_id, 64) || `shot-${index + 1}`;
  // ID 必须唯一：重复会让批量队列覆盖同一个镜头。
  if (usedIds.has(id)) id = `${id}-${index + 1}`;
  usedIds.add(id);
  return {
    id,
    selected: Boolean(raw.selected),
    title: text(raw.title, 160),
    group_id: text(raw.group_id, 64),
    duration: positiveInt(raw.duration, 5, 1, 60),
    shot_type: text(raw.shot_type, 64),
    camera_angle: text(raw.camera_angle, 64),
    technique: text(raw.technique, 120),
    story_beat: text(raw.story_beat, 600),
    opening_state: text(raw.opening_state, 600),
    action_progression: text(raw.action_progression, 900),
    ending_state: text(raw.ending_state, 600),
    dialogue: text(raw.dialogue, 900),
    positive: text(raw.positive, 4000),
    negative: text(raw.negative ?? raw.negative_prompt, 2000),
    first_frame_prompt: text(raw.first_frame_prompt, 2000),
    last_frame_prompt: text(raw.last_frame_prompt, 2000),
    image_prompt_engine: oneOf(raw.image_prompt_engine, IMAGE_ENGINES, "Qwen Image 2.1"),
    image_generation_mode: oneOf(raw.image_generation_mode, IMAGE_MODES, "文生图"),
    video_mode: oneOf(raw.video_mode ?? raw.video_generation_mode, VIDEO_MODES, "图生视频"),
    video_generation_reason: text(raw.video_generation_reason, 600),
    protagonist_refs: textList(raw.protagonist_refs, 8, 120),
    supporting_refs: textList(raw.supporting_refs, 12, 120),
    prop_refs: textList(raw.prop_refs, 12, 120),
    scene_ref: text(raw.scene_ref, 300),
    reference_requirements: textList(raw.reference_requirements, 12, 240),
    assets: textList(raw.assets, 16, 2048),
    // 生成结果只存引用，不存 base64，避免整份项目膨胀到几十 MB。
    image_url: text(raw.image_url, 2048) || undefined,
    image_storage_key: text(raw.image_storage_key, 512) || undefined,
    video_url: text(raw.video_url, 2048) || undefined,
    video_storage_key: text(raw.video_storage_key, 512) || undefined,
    updated_at: text(raw.updated_at, 40) || undefined,
  };
}

function normalizeProject(raw, { create = false } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const now = nowIso();
  const project = raw.project && typeof raw.project === "object" ? raw.project : raw;
  const name = text(project.name, 160);
  const id = text(raw.id, 64) || (create ? randomId("sb_") : "");
  if (!id) return null;
  if (create && !name) return null;

  const usedShotIds = new Set();
  const shots = (Array.isArray(raw.shots) ? raw.shots : [])
    .map((shot, index) => normalizeShot(shot, index, usedShotIds))
    .filter(Boolean)
    .slice(0, MAX_SHOTS);

  const assets = {};
  for (const kind of ASSET_KINDS) {
    const list = Array.isArray(raw[kind]) ? raw[kind] : [];
    assets[kind] = list
      .map((item, index) => normalizeAsset(item, index, kind))
      .filter(Boolean)
      .slice(0, MAX_ASSETS_PER_KIND);
  }

  return {
    id,
    version: VERSION,
    project: {
      name: name || "未命名故事",
      story: text(project.story ?? raw.story, 20000),
      style: text(project.style, 300),
      aspect_ratio: text(project.aspect_ratio, 32) || "16:9",
      max_shot_seconds: positiveInt(project.max_shot_seconds, 10, 1, 60),
      target_shot_count: positiveInt(project.target_shot_count, 0, 0, MAX_SHOTS),
      negative_prompt: text(project.negative_prompt, 2000),
      video_model: text(project.video_model, 120),
      image_model: text(project.image_model, 120),
    },
    characters: assets.characters,
    scenes: assets.scenes,
    props: assets.props,
    story_beats: (Array.isArray(raw.story_beats) ? raw.story_beats : [])
      .map((beat, index) => {
        if (!beat || typeof beat !== "object") return null;
        return { id: text(beat.id, 64) || `beat-${index + 1}`, summary: text(beat.summary, 600), act: text(beat.act, 80) };
      })
      .filter(Boolean)
      .slice(0, MAX_SHOTS),
    shots,
    active_shot_id: text(raw.active_shot_id, 64),
    selection_mode: oneOf(raw.selection_mode, SELECTION_MODES, "当前分镜"),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: now,
  };
}

export function createStoryboardStore({ dataDir, logger } = {}) {
  const file = path.join(dataDir, FILE_NAME);
  let projects = [];
  let persistQueue = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await fsp.readFile(file, "utf8"));
      // 坏条目不能拖垮整个列表；逐个校验，跳过不合法的。
      projects = (Array.isArray(raw?.projects) ? raw.projects : []).map((item) => normalizeProject(item)).filter(Boolean);
    } catch {
      // 首次运行，或文件还没生成。
    }
  }

  function persist() {
    const payload = { version: VERSION, updatedAt: nowIso(), projects };
    const write = persistQueue.then(() => writeJsonAtomic(file, payload));
    persistQueue = write.catch((error) => logger?.warn?.(`保存分镜项目失败：${error.message}`));
    return write;
  }

  function list() {
    // 列表只需要摘要：把 story 和分镜正文裁掉，避免一屏加载几十万字。
    return projects
      .map((item) => ({
        id: item.id,
        name: item.project.name,
        shotCount: item.shots.length,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function get(id) {
    const found = projects.find((item) => item.id === id);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  async function save(input) {
    const existing = input?.id ? projects.find((item) => item.id === input.id) : null;
    const normalized = normalizeProject({ ...input, id: input?.id || randomId("sb_") }, { create: !existing });
    if (!normalized) throw new Error("分镜项目不合法：需要项目名称");
    if (existing) {
      normalized.createdAt = existing.createdAt;
      projects = projects.map((item) => (item.id === normalized.id ? normalized : item));
    } else {
      projects = [normalized, ...projects];
    }
    await persist();
    return normalized;
  }

  async function remove(id) {
    const next = projects.filter((item) => item.id !== id);
    if (next.length === projects.length) return false;
    projects = next;
    await persist();
    return true;
  }

  /**
   * 导出成 ComfyUI 原生导演台能吃的 storyboard_json。
   * 只输出官方认识的字段，多余字段会让对方的校验直接报错。
   */
  function toComfyStoryboard(id) {
    const item = projects.find((entry) => entry.id === id);
    if (!item) return null;
    return {
      version: item.version,
      project: item.project,
      characters: item.characters,
      scenes: item.scenes,
      props: item.props,
      story_beats: item.story_beats,
      active_asset_task_id: "",
      shots: item.shots.map((shot) => ({ ...shot, shot_id: shot.id })),
    };
  }

  return { load, list, get, save, remove, toComfyStoryboard, SELECTION_MODES, VIDEO_MODES };
}
