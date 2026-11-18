/**
 * 「无限・卷轴」的服务端存储。
 *
 * 移植自 infinite-creation 的 lib/core/novel.js 数据模型：四层结构
 * （总纲 outline → 分卷 volumes → 章纲 chapters → 正文 write），
 * 外加角色表、记忆表和分卷表。
 *
 * 为什么存网关而不是浏览器：
 * 小说是长周期编辑的产物，几万字正文清一次缓存就没了等于白做。
 * 分镜项目也是同样的理由放在这里。
 *
 * 为什么不复用 storyboard-projects.json：
 * 两者生命周期完全独立（一个项目可能先写小说再转分镜），
 * 混在一个文件里删除/导出会互相牵连。
 */
import fsp from "node:fs/promises";
import path from "node:path";

import { nowIso, randomId, writeJsonAtomic } from "./util.js";

const FILE_NAME = "novel-projects.json";
const VERSION = 1;

/** 生成步骤。和参考实现一致，多一步 all 表示「一次跑完全部」。 */
export const NOVEL_STEPS = ["outline", "volumes", "chapters", "write", "start", "extend", "restart", "all"];
export const CHAPTER_STATUS = ["pending", "outlined", "writing", "done"];

const MAX_CHAPTERS = 2000;
const MAX_CHARACTERS = 200;
const MAX_MEMORY = 200;
const MAX_VOLUMES = 200;

function text(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

/** 正文可以很长，单独放宽上限；截断会把整章内容悄悄吞掉。 */
function longText(value, max = 200000) {
  return String(value ?? "").slice(0, max);
}

function positiveInt(value, fallback, min = 0, max = 999999) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function oneOf(value, allowed, fallback) {
  const candidate = text(value, 32);
  return allowed.includes(candidate) ? candidate : fallback;
}

/** 角色：小说里的固定班底，生成时要塞进上下文。 */
function normalizeCharacter(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const name = text(raw.name, 80);
  const role = text(raw.role, 80);
  const description = text(raw.description, 2000);
  if (!name && !role && !description) return null;
  return {
    id: text(raw.id, 64) || `char-${index + 1}`,
    name: name || `角色${index + 1}`,
    role,
    description,
    notes: text(raw.notes, 1000),
  };
}

/**
 * 记忆：跨章要保持一致的设定（伏笔、承诺、已发生的关键事件）。
 *
 * 单独一张表而不是写进角色里：记忆是「随时间变化的状态」，
 * 角色是「不变的人设」，混在一起改一处会污染另一处。
 */
function normalizeMemory(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const content = text(raw.content ?? raw.text, 2000);
  if (!content) return null;
  return {
    id: text(raw.id, 64) || `mem-${index + 1}`,
    content,
    source: text(raw.source, 120),
    createdAt: text(raw.createdAt, 40) || nowIso(),
  };
}

/** 分卷：每卷有卷号、卷名、卷纲、覆盖章节范围。 */
function normalizeVolume(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const title = text(raw.title, 120);
  const outline = text(raw.outline, 4000);
  if (!title && !outline) return null;
  const seq = positiveInt(raw.seq, index + 1, 1, 9999);
  return {
    id: text(raw.id, 64) || `vol-${seq}`,
    seq,
    title: title || `第${seq}卷`,
    outline,
    chapterFrom: positiveInt(raw.chapterFrom, 0, 0, MAX_CHAPTERS),
    chapterTo: positiveInt(raw.chapterTo, 0, 0, MAX_CHAPTERS),
  };
}

/** 章节：章纲和正文分开存，因为两者生成时机不同（先有章纲再写正文）。 */
function normalizeChapter(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const title = text(raw.title, 200);
  const outline = text(raw.outline, 4000);
  const novel = longText(raw.novel);
  if (!title && !outline && !novel) return null;
  const seq = positiveInt(raw.seq, index + 1, 1, MAX_CHAPTERS);
  return {
    id: text(raw.id, 64) || `ch-${seq}`,
    seq,
    title: title || `第${seq}章`,
    volume: positiveInt(raw.volume, 1, 1, MAX_VOLUMES),
    outline,
    novel,
    status: oneOf(raw.status, CHAPTER_STATUS, novel ? "done" : outline ? "outlined" : "pending"),
  };
}

function normalizeStructure(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    outline: text(source.outline, 20000),
    volumes: text(source.volumes, 20000),
    chapters: text(source.chapters, 20000),
  };
}

function normalizeProject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = text(raw.name ?? raw.project?.name, 120);
  const idea = text(raw.idea ?? raw.project?.idea, 4000);
  if (!name && !idea) return null;
  const createdAt = text(raw.createdAt, 40) || nowIso();
  return {
    id: text(raw.id, 64) || randomId("nv_"),
    name: name || "未命名小说",
    idea,
    createdAt,
    updatedAt: text(raw.updatedAt, 40) || createdAt,
    structure: normalizeStructure(raw.structure),
    characters: (Array.isArray(raw.characters) ? raw.characters : []).map(normalizeCharacter).filter(Boolean).slice(0, MAX_CHARACTERS),
    memory: (Array.isArray(raw.memory) ? raw.memory : []).map(normalizeMemory).filter(Boolean).slice(0, MAX_MEMORY),
    volumes: (Array.isArray(raw.volumes) ? raw.volumes : []).map(normalizeVolume).filter(Boolean).slice(0, MAX_VOLUMES),
    chapters: (Array.isArray(raw.chapters) ? raw.chapters : []).map(normalizeChapter).filter(Boolean).slice(0, MAX_CHAPTERS),
  };
}

export function createNovelStore({ dataDir, logger } = {}) {
  const file = path.join(dataDir, FILE_NAME);
  let projects = [];
  let persistQueue = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await fsp.readFile(file, "utf8"));
      // 坏条目不能拖垮整个列表；逐个校验，跳过不合法的。
      projects = (Array.isArray(raw?.projects) ? raw.projects : []).map(normalizeProject).filter(Boolean);
    } catch {
      // 首次运行，或文件还没生成。
    }
  }

  function persist() {
    const payload = { version: VERSION, updatedAt: nowIso(), projects };
    const write = persistQueue.then(() => writeJsonAtomic(file, payload));
    persistQueue = write.catch((error) => logger?.warn?.(`保存小说项目失败：${error.message}`));
    return write;
  }

  /**
   * 列表只返回摘要。
   *
   * 正文动辄几十万字，列表页把它们全带上会让一次 GET 变成几 MB，
   * 所以这里只给统计量，正文按需单独取。
   */
  function list() {
    return projects
      .map((item) => ({
        id: item.id,
        name: item.name,
        idea: item.idea.slice(0, 120),
        chapterCount: item.chapters.length,
        wordCount: item.chapters.reduce((sum, chapter) => sum + chapter.novel.length, 0),
        volumeCount: item.volumes.length,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function get(id) {
    const found = projects.find((item) => item.id === id);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  async function create({ name, idea } = {}) {
    const project = normalizeProject({ name, idea, createdAt: nowIso(), updatedAt: nowIso() });
    if (!project) throw new Error("小说名和中心思想至少填一个");
    projects.push(project);
    await persist();
    logger?.info?.(`已创建小说项目：${project.name}`);
    return JSON.parse(JSON.stringify(project));
  }

  /**
   * 局部更新。
   *
   * 只覆盖传进来的字段：面板里改角色不该顺手把正在写的正文清空。
   */
  async function update(id, patch = {}) {
    const index = projects.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const current = projects[index];
    const merged = normalizeProject({
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: nowIso(),
      // structure 是对象，浅合并否则改一个字段会把另外两个抹掉。
      structure: patch.structure ? { ...current.structure, ...patch.structure } : current.structure,
    });
    projects[index] = merged;
    await persist();
    return JSON.parse(JSON.stringify(merged));
  }

  async function remove(id) {
    const index = projects.findIndex((item) => item.id === id);
    if (index < 0) return false;
    projects.splice(index, 1);
    await persist();
    return true;
  }

  /** 给生成器用：拼一段可读的上下文，让模型知道前文发生了什么。 */
  function contextBlock(id, { maxChapters = 8, maxChars = 12000 } = {}) {
    const project = projects.find((item) => item.id === id);
    if (!project) return "";
    const lines = [];
    if (project.idea) lines.push(`中心思想：${project.idea}`);
    if (project.structure.outline) lines.push(`总纲：\n${project.structure.outline}`);
    if (project.characters.length) {
      lines.push(`角色：\n${project.characters.map((c) => `- ${c.name}${c.role ? `（${c.role}）` : ""}：${c.description}`).join("\n")}`);
    }
    if (project.memory.length) {
      lines.push(`已知设定：\n${project.memory.map((m) => `- ${m.content}`).join("\n")}`);
    }
    // 最近几章带上结尾，避免续写时人物凭空消失或情节断裂。
    const recent = project.chapters.filter((c) => c.novel).slice(-maxChapters);
    if (recent.length) {
      lines.push(
        `最近章节：\n${recent
          .map((c) => `【${c.title}】${c.novel.slice(-Math.floor(maxChars / recent.length))}`)
          .join("\n")}`,
      );
    }
    return lines.join("\n\n");
  }

  return { load, list, get, create, update, remove, contextBlock, persist };
}