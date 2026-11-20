import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { defaultCreationPipeline } from "../src/lib/agent/creation-pipeline";
import { loadCreationSkill, loadCreationSkillReference, exportCreationPipeline, importCreationPipeline } from "../src/lib/agent/creation-skills";
const original = globalThis.fetch;
globalThis.fetch = (async (url: unknown) => {
    if (!String(url).startsWith("/creation-skills/")) throw new Error("禁止外网");
    return new Response(readFileSync(`public${String(url)}`));
}) as typeof fetch;
afterAll(() => { globalThis.fetch = original; });

test("17个真实技能包及完整参考文件哈希一致", async () => {
    const manifest = JSON.parse(readFileSync("public/creation-skills/manifest.json", "utf8"));
    expect(manifest.skills).toHaveLength(17);
    for (const skill of manifest.skills) {
        for (const file of skill.files) {
            const data = readFileSync(`public/creation-skills/${skill.name}/${file.path}`);
            expect(data.byteLength).toBe(file.bytes);
            expect(createHash("sha256").update(data).digest("hex")).toBe(file.sha256);
        }
    }
    const h3 = await loadCreationSkill("h3-prompt-writing");
    expect(h3.content.length).toBeGreaterThan(100);
    expect(h3.references.length).toBeGreaterThan(0);
    const ref = await loadCreationSkillReference("h3-prompt-writing", h3.references[0]);
    expect(ref.length).toBeGreaterThan(0);
});
test("流水线ZIP往返保留12配置及全部技能文件", async () => {
    const config = defaultCreationPipeline();
    const zip = await exportCreationPipeline(config);
    const restored = await importCreationPipeline(zip);
    expect(restored.config).toEqual(config);
    expect(Object.keys(restored.files).length).toBe(1189);
    const source = await loadCreationSkill("webnovel-writing");
    expect((await loadCreationSkill("webnovel-writing", restored.files)).content).toBe(source.content);
});
test("导入拒绝穿越和缺正文，读取拒绝非白名单文件", async () => {
    const config = strToU8(JSON.stringify({ version: 1, skillPipeline: defaultCreationPipeline() }));
    await expect(importCreationPipeline(zipSync({ "IC_CONFIG.json": config, "../evil": strToU8("bad") }))).rejects.toThrow();
    await expect(importCreationPipeline(zipSync({ "IC_CONFIG.json": config, "skills/bad/reference.txt": strToU8("bad") }))).rejects.toThrow();
    await expect(loadCreationSkillReference("webnovel-writing", "../secret")).rejects.toThrow();
    await expect(loadCreationSkillReference("webnovel-writing", "not-present.txt")).rejects.toThrow();
});
