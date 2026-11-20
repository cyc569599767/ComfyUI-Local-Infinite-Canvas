#!/usr/bin/env node
// 仅复制文件和计算摘要；绝不加载或执行技能目录中的脚本。
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const SKILLS = [
    "webnovel-writing", "sd-script-engine", "short-drama-scriptwriting",
    "novel-to-skitscreenplay", "image-prompt-writing", "sd-asset-engine",
    "era-consistency-optimizer", "tts-voice-design", "story-pipeline-cn",
    "sd-storyboard-engine", "scene-blocking-consistency", "h3-prompt-writing",
    "video-cinematography", "ai-music-studio", "music-caption-rewriter",
    "novel-to-video", "short-drama-director",
];
const webRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const positional = args.filter((arg) => arg !== "--check");
if (positional.length > 1 || positional.some((arg) => arg.startsWith("--"))) {
    throw new Error("用法：node sync-creation-skills.cjs [参考项目/skills] [--check]");
}
const sourceRoot = path.resolve(positional[0] || path.join(webRoot, "../../../infinite-creation/skills"));
const targetRoot = path.join(webRoot, "public/creation-skills");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function inspectLocation(location) {
    const parent = path.dirname(location);
    if (parent !== location) inspectLocation(parent);
    if (!fs.existsSync(location)) return;
    if (fs.lstatSync(location).isSymbolicLink()) throw new Error(`不允许符号链接：${location}`);
}

function safeRelative(relative) {
    if (!relative || /[\\:%\x00-\x1f\x7f]/.test(relative) || relative.split("/").some((part) =>
        !part || /^\.+$/.test(part) || /[. ]$/.test(part) || ["__proto__", "prototype", "constructor"].includes(part))) {
        throw new Error(`不安全的相对路径：${relative}`);
    }
}

function collect(directory, prefix = "", directories = []) {
    const result = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        safeRelative(relative);
        const absolute = path.join(directory, entry.name);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error(`不允许符号链接：${absolute}`);
        if (stat.isDirectory()) {
            directories.push(relative);
            result.push(...collect(absolute, relative, directories));
        } else if (stat.isFile()) {
            result.push({ path: relative, data: fs.readFileSync(absolute) });
        } else {
            throw new Error(`不支持的文件类型：${absolute}`);
        }
    }
    return result;
}

function main() {
    inspectLocation(sourceRoot);
    inspectLocation(targetRoot);
    if (!fs.statSync(sourceRoot).isDirectory() || !fs.statSync(path.dirname(targetRoot)).isDirectory()) {
        throw new Error("参考技能目录或目标 public 目录不存在");
    }
    const licensePath = path.join(sourceRoot, "../LICENSE");
    inspectLocation(licensePath);
    const license = fs.readFileSync(licensePath);
    const planned = [];
    const directories = new Set([targetRoot]);
    let sourceFiles = 0;
    let sourceBytes = 0;
    const skills = SKILLS.map((name) => {
        const sourceDirectory = path.join(sourceRoot, name);
        inspectLocation(sourceDirectory);
        const subdirectories = [];
        const files = collect(sourceDirectory, "", subdirectories);
        sourceFiles += files.length;
        sourceBytes += files.reduce((sum, file) => sum + file.data.length, 0);
        const entry = ["SKILL.cn.md", "SKILL.md"].find((candidate) => files.some((file) => file.path === candidate));
        if (!entry) throw new Error(`技能缺少正文入口：${name}`);
        // 每个包都随附上游根许可证，单独导出时也不会遗失 Required Notice。
        const existingNotice = files.find((file) => file.path === "LICENSE.upstream");
        if (existingNotice && !existingNotice.data.equals(license)) throw new Error(`${name}/LICENSE.upstream 已有不同内容`);
        if (!existingNotice) files.push({ path: "LICENSE.upstream", data: license });
        files.sort((a, b) => compare(a.path, b.path));
        const targetDirectory = path.join(targetRoot, name);
        directories.add(targetDirectory);
        for (const directory of subdirectories) directories.add(path.join(targetDirectory, directory));
        if (fs.existsSync(targetDirectory)) {
            const allowed = new Set(files.map((file) => file.path));
            for (const file of collect(targetDirectory)) {
                if (!allowed.has(file.path)) throw new Error(`目标存在未列入清单的文件，未修改：${name}/${file.path}`);
            }
        }
        return {
            name,
            entry,
            files: files.map(({ path: relative, data }) => {
                planned.push({ location: path.join(targetDirectory, relative), data });
                return { path: relative, bytes: data.length, sha256: hash(data) };
            }),
        };
    });
    const manifest = Buffer.from(`${JSON.stringify({ version: 1, skills }, null, 2)}\n`, "utf8");
    planned.push({ location: path.join(targetRoot, "manifest.json"), data: manifest });

    // 先检查全部冲突，再开始新增；已有文件完全相同则只校验，绝不覆盖。
    for (const { location, data } of planned) {
        inspectLocation(location);
        if (fs.existsSync(location)) {
            const actual = fs.readFileSync(location);
            if (actual.length !== data.length || hash(actual) !== hash(data) || !actual.equals(data)) {
                throw new Error(`拒绝覆盖不同内容的已有文件：${location}`);
            }
        } else if (checkOnly) {
            throw new Error(`校验失败，缺少文件：${location}`);
        }
    }
    let added = 0;
    if (!checkOnly) {
        for (const directory of directories) fs.mkdirSync(directory, { recursive: true });
        for (const { location, data } of planned) {
            if (fs.existsSync(location)) continue;
            fs.writeFileSync(location, data, { flag: "wx" });
            added += 1;
        }
    }
    for (const { location, data } of planned) {
        const actual = fs.readFileSync(location);
        if (actual.length !== data.length || hash(actual) !== hash(data) || !actual.equals(data)) {
            throw new Error(`字节或 SHA-256 校验失败：${location}`);
        }
    }
    console.log(JSON.stringify({
        mode: checkOnly ? "check" : "sync", sourceRoot, targetRoot,
        skills: skills.length, sourceFiles, sourceBytes,
        bundledFiles: skills.reduce((sum, skill) => sum + skill.files.length, 0),
        bundledBytes: skills.reduce((sum, skill) => sum + skill.files.reduce((n, file) => n + file.bytes, 0), 0),
        added, verifiedFiles: planned.length, manifestSha256: hash(manifest),
        upstreamLicenseSha256: hash(license),
    }, null, 2));
}

main();
