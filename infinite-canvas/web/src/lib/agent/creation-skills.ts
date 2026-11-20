import { Inflate, zipSync } from "fflate";

/** 键为 skillName/relativePath，值为原始字节的标准 base64（不是 UTF-8 正文或 data URL）。 */
export type SkillFileOverrides = Record<string, string>;

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 2000;
const ENTRY_FILES = ["SKILL.cn.md", "SKILL.md"] as const;
const BASE_URL = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
const PUBLIC_ROOT = `${BASE_URL.replace(/\/$/, "")}/creation-skills/`;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

type SkillFile = { path: string; bytes: number; sha256?: string; base64?: string };
type Skill = { name: string; entry: string; files: Map<string, SkillFile> };
type Catalog = Map<string, Skill>;
let manifestPromise: Promise<Catalog> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function safePath(value: unknown): asserts value is string {
    if (typeof value !== "string" || !value || value.length > 1024 || value.includes("..") ||
        /[\\:%<>"|?*\x00-\x1f\x7f]/.test(value) || value.split("/").some((part) =>
            !part || part === "." || /[. ]$/.test(part) ||
            ["__proto__", "prototype", "constructor"].includes(part.toLowerCase()) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
        throw new Error(`不安全的技能文件路径：${String(value)}`);
    }
}

function safeName(value: unknown): asserts value is string {
    safePath(value);
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value) || value.toLowerCase() === "skills") {
        throw new Error(`不合法的技能名称：${value}`);
    }
}

function uniquePath(seen: Set<string>, path: string) {
    const key = path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new Error(`重复或大小写冲突的文件路径：${path}`);
    seen.add(key);
}

function validateFileTree(paths: Iterable<string>) {
    const files = new Set<string>();
    for (const path of paths) uniquePath(files, path);
    for (const path of files) {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i += 1) {
            if (files.has(parts.slice(0, i).join("/"))) throw new Error(`技能文件与目录路径冲突：${path}`);
        }
    }
}

function chooseEntry(paths: Iterable<string>): string {
    const files = new Set(paths);
    const entry = ENTRY_FILES.find((name) => files.has(name));
    if (!entry) throw new Error("技能根目录必须包含 SKILL.md 或 SKILL.cn.md");
    return entry;
}

function textPath(path: string): boolean {
    return /\.(md|mdx|txt|text|json|jsonl|yaml|yml|csv|tsv|toml|ini|cfg|xml|rst)$/i.test(path) ||
        /^(license|notice|copying|authors|changelog|readme)(\.[\w-]+)?$/i.test(path.split("/").pop() || "");
}

function decodeText(bytes: Uint8Array, label: string, limit = MAX_TEXT_BYTES): string {
    if (bytes.length > limit) throw new Error(`${label} 超过文本读取上限（${limit} 字节）`);
    let text: string;
    try { text = utf8.decode(bytes); } catch { throw new Error(`${label} 不是有效的 UTF-8 文本`); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error(`${label} 含二进制控制字符，不能作为文本读取`);
    return text;
}

function base64Size(value: unknown): number {
    if (typeof value !== "string" || value.length > Math.ceil(MAX_ZIP_BYTES / 3) * 4 ||
        value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
        throw new Error("技能 overrides 必须是标准 base64，单文件不能超过 50MB");
    }
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    if (value.slice(0, value.length - padding).includes("=") || (padding > 0 && value.length < 4)) {
        throw new Error("技能 overrides 的 base64 填充不合法");
    }
    const size = value.length / 4 * 3 - padding;
    if (size > MAX_ZIP_BYTES) throw new Error("技能 override 文件超过 50MB");
    return size;
}

function fromBase64(value: string): Uint8Array {
    base64Size(value);
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
    const parts: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 0x6000) {
        parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 0x6000))));
    }
    return parts.join("");
}

async function fetchBytes(relative: string, limit: number): Promise<Uint8Array> {
    safePath(relative);
    const response = await fetch(PUBLIC_ROOT + relative.split("/").map(encodeURIComponent).join("/"), { redirect: "error" });
    if (!response.ok) throw new Error(`读取技能文件失败（${response.status}）：${relative}`);
    const declared = Number(response.headers.get("content-length"));
    if (declared > limit) {
        await response.body?.cancel();
        throw new Error(`技能文件超过读取上限：${relative}`);
    }
    if (!response.body) throw new Error(`技能文件响应缺少正文：${relative}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > limit) {
                await reader.cancel();
                throw new Error(`技能文件超过读取上限：${relative}`);
            }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
}

async function readManifest(): Promise<Catalog> {
    const raw: unknown = JSON.parse(decodeText(await fetchBytes("manifest.json", 2 * 1024 * 1024), "manifest.json", 2 * 1024 * 1024));
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.skills)) throw new Error("技能 manifest 格式或版本不支持");
    const catalog: Catalog = new Map();
    const names = new Set<string>();
    let count = 0;
    let bytes = 0;
    for (const item of raw.skills) {
        if (!isRecord(item) || !Array.isArray(item.files)) throw new Error("技能 manifest 的 files 格式不合法");
        safeName(item.name);
        uniquePath(names, item.name);
        const paths = new Set<string>();
        const files = new Map<string, SkillFile>();
        for (const file of item.files) {
            if (!isRecord(file)) throw new Error("技能 manifest 文件条目不合法");
            safePath(file.path);
            uniquePath(paths, file.path);
            if (typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
                typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
                throw new Error(`技能 manifest 字节数或 SHA-256 不合法：${item.name}/${file.path}`);
            }
            count += 1;
            bytes += file.bytes;
            if (count > MAX_FILES || bytes > MAX_ZIP_BYTES) throw new Error("技能 manifest 超过 2000 个文件或 50MB");
            files.set(file.path, { path: file.path, bytes: file.bytes, sha256: file.sha256 });
        }
        validateFileTree(files.keys());
        const entry = chooseEntry(files.keys());
        if (item.entry !== entry) throw new Error(`技能 manifest 正文入口不合法：${item.name}`);
        catalog.set(item.name, { name: item.name, entry, files });
    }
    return catalog;
}

async function getCatalog(overrides?: SkillFileOverrides): Promise<Catalog> {
    manifestPromise ??= readManifest().catch((error: unknown) => { manifestPromise = undefined; throw error; });
    const base = await manifestPromise;
    if (overrides === undefined) return base;
    if (!isRecord(overrides)) throw new Error("技能 overrides 必须是 base64 文件对象");
    const catalog: Catalog = new Map([...base].map(([name, skill]) => [name, { ...skill, files: new Map(skill.files) }]));
    const paths = new Set<string>();
    let count = 0;
    let bytes = 0;
    // public 只允许 manifest 白名单；导入文件以经过校验的显式键扩展内存白名单，不进行任意路径 fetch。
    for (const [key, value] of Object.entries(overrides)) {
        safePath(key);
        uniquePath(paths, key);
        const [name, ...parts] = key.split("/");
        safeName(name);
        const relative = parts.join("/");
        safePath(relative);
        const size = base64Size(value);
        count += 1;
        bytes += size;
        if (count > MAX_FILES || bytes > MAX_ZIP_BYTES) throw new Error("技能 overrides 超过 2000 个文件或 50MB");
        let skill = catalog.get(name);
        if (!skill) {
            skill = { name, entry: "", files: new Map() };
            catalog.set(name, skill);
        }
        skill.files.set(relative, { path: relative, bytes: size, base64: value });
    }
    const names = new Set<string>();
    for (const skill of catalog.values()) {
        uniquePath(names, skill.name);
        validateFileTree(skill.files.keys());
        skill.entry = chooseEntry(skill.files.keys());
        const entry = skill.files.get(skill.entry)!;
        if (entry.base64 !== undefined) decodeText(fromBase64(entry.base64), `${skill.name}/${skill.entry}`);
    }
    return catalog;
}

function getSkill(catalog: Catalog, name: string): Skill {
    safeName(name);
    const skill = catalog.get(name);
    if (!skill) throw new Error(`技能不在 manifest 或导入白名单中：${name}`);
    return skill;
}

async function readFile(skill: Skill, path: string, textOnly: boolean): Promise<Uint8Array> {
    safePath(path);
    const file = skill.files.get(path);
    if (!file) throw new Error(`文件不在技能白名单中：${skill.name}/${path}`);
    if (textOnly && (!textPath(path) || file.bytes > MAX_TEXT_BYTES)) {
        throw new Error(`仅允许读取不超过 512KB 的文本参考：${skill.name}/${path}`);
    }
    if (file.base64 !== undefined) return fromBase64(file.base64);
    const bytes = await fetchBytes(`${skill.name}/${path}`, file.bytes);
    if (bytes.length !== file.bytes) throw new Error(`技能文件字节数校验失败：${skill.name}/${path}`);
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (sha256 !== file.sha256) throw new Error(`技能文件 SHA-256 校验失败：${skill.name}/${path}`);
    return bytes;
}

/** references 是相对技能目录的可读取文本路径，不执行或渲染其中的内容。 */
export async function loadCreationSkill(name: string, overrides?: SkillFileOverrides): Promise<{ name: string; content: string; references: string[] }> {
    safeName(name);
    const skill = getSkill(await getCatalog(overrides), name);
    const content = decodeText(await readFile(skill, skill.entry, true), `${name}/${skill.entry}`);
    const references = [...skill.files.values()]
        .filter((file) => file.path !== skill.entry && textPath(file.path) && file.bytes <= MAX_TEXT_BYTES)
        .map((file) => file.path).sort();
    return { name, content, references };
}

export async function loadCreationSkillReference(name: string, ref: string, overrides?: SkillFileOverrides): Promise<string> {
    safeName(name);
    safePath(ref);
    const skill = getSkill(await getCatalog(overrides), name);
    return decodeText(await readFile(skill, ref, true), `${name}/${ref}`);
}

export async function listCreationSkills(overrides?: SkillFileOverrides): Promise<string[]> {
    return [...(await getCatalog(overrides)).keys()].sort();
}

function referencedSkills(config: unknown): string[] {
    if (!isRecord(config) || !isRecord(config.nodes)) throw new Error("skillPipeline.nodes 必须是对象");
    const names = new Set<string>();
    for (const [id, node] of Object.entries(config.nodes)) {
        if (node === null || node === undefined) continue;
        if (!isRecord(node)) throw new Error(`流水线节点必须是对象：${id}`);
        if (node.skills === undefined) continue;
        if (!Array.isArray(node.skills)) throw new Error(`节点 ${id} 的 skills 必须是数组`);
        for (const value of node.skills) {
            if (typeof value !== "string") throw new Error(`节点 ${id} 的技能名必须是字符串`);
            const name = value.trim();
            if (!name) continue;
            safeName(name);
            names.add(name);
        }
    }
    return [...names].sort();
}

/** 兼容参考项目：IC_CONFIG.json + skills/{技能名}/{完整文件相对路径}。 */
export async function exportCreationPipeline(config: unknown, overrides?: SkillFileOverrides): Promise<Uint8Array> {
    const configText = JSON.stringify({ version: 1, skillPipeline: config });
    const configBytes = encoder.encode(configText);
    if (configBytes.length > MAX_ZIP_BYTES) throw new Error("流水线配置超过 50MB");
    const names = referencedSkills(JSON.parse(configText).skillPipeline);
    const catalog = await getCatalog(overrides);
    const files: Record<string, Uint8Array> = Object.create(null);
    files["IC_CONFIG.json"] = configBytes;
    let total = configBytes.length;
    let count = 1;
    // 先按元数据检查整包，再下载，避免超限包读取大量资源后才失败。
    for (const name of names) {
        for (const file of getSkill(catalog, name).files.values()) {
            total += file.bytes;
            count += 1;
            if (total > MAX_ZIP_BYTES || count > MAX_FILES) throw new Error("导出包展开后超过 50MB 或 2000 个文件");
        }
    }
    for (const name of names) {
        const skill = getSkill(catalog, name);
        for (const path of [...skill.files.keys()].sort()) {
            const bytes = await readFile(skill, path, false);
            if (path === skill.entry) decodeText(bytes, `${name}/${path}`);
            files[`skills/${name}/${path}`] = bytes;
        }
    }
    const bytes = zipSync(files, { level: 6 });
    if (bytes.length > MAX_ZIP_BYTES) throw new Error("压缩后的流水线包超过 50MB");
    return bytes;
}

type ZipEntry = { path: string; size: number; compressedSize: number; offset: number; method: number; crc: number; directory: boolean };

// 解压前检查中央目录与本地头；不能只信 unzipSync 的声明体积或让重复键静默覆盖。
function zipEntries(bytes: Uint8Array): ZipEntry[] {
    if (bytes.length < 22 || bytes.length > MAX_ZIP_BYTES) throw new Error("ZIP 无效或压缩体积超过 50MB");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    const minimum = Math.max(0, end - 65535);
    for (; end >= minimum; end -= 1) {
        if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
    }
    if (end < minimum) throw new Error("ZIP 缺少完整的中央目录结尾");
    const count = view.getUint16(end + 10, true);
    const centralSize = view.getUint32(end + 12, true);
    const centralOffset = view.getUint32(end + 16, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count ||
        count > MAX_FILES || centralOffset + centralSize !== end) {
        throw new Error("不支持分卷、ZIP64、超过 2000 条目或损坏的 ZIP");
    }
    const entries: ZipEntry[] = [];
    const paths = new Set<string>();
    const ranges: { start: number; end: number }[] = [];
    let offset = centralOffset;
    let total = 0;
    for (let index = 0; index < count; index += 1) {
        if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
        const flags = view.getUint16(offset + 8, true);
        const method = view.getUint16(offset + 10, true);
        const crc = view.getUint32(offset + 16, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const size = view.getUint32(offset + 24, true);
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const attributes = view.getUint32(offset + 38, true);
        const mode = (attributes >>> 16) & 0xf000;
        const local = view.getUint32(offset + 42, true);
        const next = offset + 46 + nameLength + extraLength + commentLength;
        if (next > end || (flags & 0x2041) || ![0, 8].includes(method) || view.getUint16(offset + 34, true) ||
            ![0, 0x4000, 0x8000].includes(mode) || local === 0xffffffff || compressedSize === 0xffffffff || size === 0xffffffff) {
            throw new Error("ZIP 含加密、链接、特殊文件、ZIP64 或不支持的压缩方式");
        }
        const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
        const name = utf8.decode(rawName);
        const directory = name.endsWith("/");
        const path = directory ? name.slice(0, -1) : name;
        safePath(path);
        uniquePath(paths, path);
        if ((directory && size !== 0) || (!directory && (mode === 0x4000 || (attributes & 0x10)))) throw new Error(`ZIP 目录标记不合法：${name}`);
        total += size;
        if (total > MAX_ZIP_BYTES) throw new Error("ZIP 展开体积超过 50MB");
        if (local + 30 > centralOffset || view.getUint32(local, true) !== 0x04034b50 ||
            view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) {
            throw new Error(`ZIP 本地文件头不匹配：${name}`);
        }
        const localNameLength = view.getUint16(local + 26, true);
        const dataOffset = local + 30 + localNameLength + view.getUint16(local + 28, true);
        if (dataOffset + compressedSize > centralOffset || localNameLength !== nameLength ||
            !rawName.every((byte, i) => byte === bytes[local + 30 + i]) ||
            (!(flags & 8) && (view.getUint32(local + 14, true) !== crc || view.getUint32(local + 18, true) !== compressedSize || view.getUint32(local + 22, true) !== size))) {
            throw new Error(`ZIP 文件名或字节数不匹配：${name}`);
        }
        ranges.push({ start: local, end: dataOffset + compressedSize });
        entries.push({ path, size, compressedSize, offset: dataOffset, method, crc, directory });
        offset = next;
    }
    if (offset !== end) throw new Error("ZIP 中央目录长度不匹配");
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i += 1) {
        if (ranges[i].start < ranges[i - 1].end) throw new Error("ZIP 文件数据重叠");
    }
    const filePaths = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.path.normalize("NFC").toLowerCase()));
    for (const entry of entries) {
        const parts = entry.path.normalize("NFC").toLowerCase().split("/");
        for (let i = 1; i < parts.length; i += 1) {
            if (filePaths.has(parts.slice(0, i).join("/"))) throw new Error("ZIP 文件与目录路径冲突");
        }
    }
    return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
});

function extractFile(archive: Uint8Array, entry: ZipEntry): Uint8Array {
    const compressed = archive.subarray(entry.offset, entry.offset + entry.compressedSize);
    const result = new Uint8Array(entry.size);
    let length = 0;
    let checksum = 0xffffffff;
    const accept = (chunk: Uint8Array) => {
        length += chunk.length;
        if (length > entry.size) throw new Error(`ZIP 实际展开体积超过声明：${entry.path}`);
        result.set(chunk, length - chunk.length);
        for (const byte of chunk) checksum = crcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
    };
    if (entry.method === 0) accept(compressed);
    else {
        // 分块膨胀并实时计数，防止伪造中央目录体积绕过展开上限。
        const inflater = new Inflate((chunk) => accept(chunk));
        if (!compressed.length) inflater.push(compressed, true);
        for (let offset = 0; offset < compressed.length; offset += 4096) {
            inflater.push(compressed.subarray(offset, offset + 4096), offset + 4096 >= compressed.length);
        }
    }
    if (length !== entry.size || ((checksum ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error(`ZIP 文件长度或 CRC 校验失败：${entry.path}`);
    return result;
}

/** 只返回配置与 base64 文件，不安装、不执行脚本、不写磁盘；支持有/无 skills/ 前缀。 */
export async function importCreationPipeline(bytes: Uint8Array): Promise<{ config: unknown; files: SkillFileOverrides }> {
    const entries = zipEntries(bytes);
    const configEntry = entries.find((entry) => entry.path === "IC_CONFIG.json" && !entry.directory);
    if (!configEntry) throw new Error("流水线 ZIP 根目录缺少 IC_CONFIG.json");
    const parsed: unknown = JSON.parse(decodeText(extractFile(bytes, configEntry), "IC_CONFIG.json", MAX_ZIP_BYTES));
    if (!isRecord(parsed) || parsed.version !== 1 || !Object.prototype.hasOwnProperty.call(parsed, "skillPipeline")) {
        throw new Error("IC_CONFIG.json 必须包含 version: 1 和 skillPipeline");
    }
    const referenced = referencedSkills(parsed.skillPipeline);
    const files: SkillFileOverrides = Object.create(null);
    const normalized = new Set<string>();
    const groups = new Map<string, Set<string>>();
    for (const entry of entries) {
        if (entry === configEntry) continue;
        if (entry.directory) { extractFile(bytes, entry); continue; }
        const key = entry.path.startsWith("skills/") ? entry.path.slice(7) : entry.path;
        safePath(key);
        uniquePath(normalized, key);
        const [name, ...parts] = key.split("/");
        safeName(name);
        const relative = parts.join("/");
        safePath(relative);
        const data = extractFile(bytes, entry);
        if (ENTRY_FILES.some((candidate) => candidate === relative)) decodeText(data, key);
        files[key] = toBase64(data);
        const group = groups.get(name) ?? new Set<string>();
        group.add(relative);
        groups.set(name, group);
    }
    const names = new Set<string>();
    for (const [name, paths] of groups) {
        uniquePath(names, name);
        validateFileTree(paths);
        chooseEntry(paths);
    }
    for (const name of referenced) {
        if (!groups.has(name)) throw new Error(`配置引用的技能未完整打包（缺少正文）：${name}`);
    }
    return { config: parsed.skillPipeline, files };
}
