// i18n 键完整性：组件里 t("...") 用到的每个 key，中英文案都必须存在。
//
// 这是自动化面板那次事故的回归防护：canvas.automation.* 整套 54 个 key
// 在合并时漏掉，面板直接把原始 key 渲染给用户（"canvas.automation.title"），
// 而当时没有任何测试能发现 —— 因为缺 key 不会报错，只会静默显示 key 本身。
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import enUS from "../src/i18n/locales/en-US";
import zhCN from "../src/i18n/locales/zh-CN";

const SRC = path.resolve(import.meta.dir, "../src");

/** 收集 src 下所有 t("...") / t(`...`) 里出现的静态 key。模板占位符（如 ${mode}）跳过。 */
function collectKeys(): string[] {
    const keys = new Set<string>();
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
            const code = fs.readFileSync(full, "utf8");
            // 只匹配纯静态的 key：不含 ${} 插值，且形如 a.b.c
            for (const match of code.matchAll(/\bt\(\s*"([a-zA-Z][\w.]*)"/g)) keys.add(match[1]);
        }
    };
    walk(SRC);
    return [...keys].sort();
}

function resolve(source: unknown, key: string): unknown {
    let node: unknown = source;
    for (const part of key.split(".")) {
        if (!node || typeof node !== "object") return undefined;
        node = (node as Record<string, unknown>)[part];
    }
    return node;
}

const keys = collectKeys();

/** 一个 key 可用，指的是「渲染出来不是 key 本身」：字符串，或用于轮播/列表的字符串数组。 */
function usable(value: unknown): boolean {
    if (typeof value === "string") return value.length > 0;
    // generation.pending 这类是多条轮播文案，t(key, { returnObjects: true }) 取数组。
    if (Array.isArray(value)) return value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
    return false;
}

test("能扫到足够多的 i18n key（防止正则失效后测试变成空转）", () => {
    expect(keys.length).toBeGreaterThan(300);
});

test("每个静态 key 在 zh-CN 里都有文案", () => {
    const missing = keys.filter((key) => !usable(resolve(zhCN, key)));
    expect(missing).toEqual([]);
});

test("每个静态 key 在 en-US 里都有文案", () => {
    const missing = keys.filter((key) => !usable(resolve(enUS, key)));
    expect(missing).toEqual([]);
});

test("中英文案不出现空串（空串会让界面变成空白而不是回落 key）", () => {
    const empty = keys.filter((key) => !usable(resolve(zhCN, key)) || !usable(resolve(enUS, key)));
    expect(empty).toEqual([]);
});

test("automation 段落齐全：面板用到的配置项逐个存在", () => {
    // 显式点名，避免只靠扫描：这几个是最容易在合并时被整段漏掉的。
    const required = [
        "title",
        "subtitle",
        "sourcePlaceholder",
        "sourceRequired",
        "pageCount",
        "segmentation",
        "segmentationHint",
        "grid",
        "style",
        "aspect",
        "textModel",
        "mossSteps",
        "videoSeconds",
        "vquality",
        "videoVariant",
        "generateAudio",
        "start",
        "continue",
        "stop",
    ];
    for (const key of required) {
        expect({ key, zh: usable(resolve(zhCN, `canvas.automation.${key}`)) }).toEqual({ key, zh: true });
    }
    // 11 个阶段都要有中文名，否则进度条会显示 "canvas.automation.stage.xxx"。
    for (const stage of ["idle", "script", "planning", "characters", "scenes", "images", "videoPrompts", "videos", "done", "error", "stopped"]) {
        expect({ stage, zh: usable(resolve(zhCN, `canvas.automation.stage.${stage}`)) }).toEqual({ stage, zh: true });
    }
});
