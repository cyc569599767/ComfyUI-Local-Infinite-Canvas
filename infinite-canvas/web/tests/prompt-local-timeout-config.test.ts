import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createJSONStorage } from "zustand/middleware";
import {
    DEFAULT_LOCAL_PROMPT_TIMEOUT_SECONDS,
    MIN_LOCAL_PROMPT_TIMEOUT_SECONDS,
    MAX_LOCAL_PROMPT_TIMEOUT_SECONDS,
    normalizeLocalPromptTimeoutSeconds,
} from "../src/lib/prompt-local-timeout";
import type { AiConfig, PromptCloudApi } from "../src/stores/use-config-store";
import zh from "../src/i18n/locales/zh-CN";
import en from "../src/i18n/locales/en-US";

const values = new Map<string, string>();
const memoryStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
};
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: memoryStorage } });
// Keep the persistence test independent of other suites' browser stubs. No API
// modules, gateway, model processes or real localStorage are used by this suite.
const storeModulePath = "../src/stores/use-config-store.ts?prompt-local-timeout-config-test";
const { CONFIG_STORE_KEY, defaultConfig, useConfigStore } = await import(storeModulePath) as typeof import("../src/stores/use-config-store");
const initialState = useConfigStore.getState();
const originalPersistStorage = useConfigStore.persist.getOptions().storage;
useConfigStore.persist.setOptions({ storage: createJSONStorage(() => memoryStorage) });
beforeEach(() => {
    useConfigStore.setState({ config: structuredClone(defaultConfig) });
    values.clear();
});
afterEach(() => useConfigStore.setState(initialState));
afterAll(() => {
    useConfigStore.persist.setOptions({ storage: originalPersistStorage });
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});
const state = () => useConfigStore.getState();
const profile = (patch: Partial<PromptCloudApi> = {}): PromptCloudApi => ({
    id: "cloud-one", name: "Test cloud", baseUrl: "https://example.test/v1", apiKey: "test-only-key", model: "test-model", ...patch,
});
const reloadConfig = async (config: Partial<AiConfig>) => {
    values.set(CONFIG_STORE_KEY, JSON.stringify({ state: { config }, version: 0 }));
    await useConfigStore.persist.rehydrate();
};

function loadTsx(path: string) {
    return ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function findNodes(root: ts.Node, predicate: (node: ts.Node) => boolean) {
    const nodes: ts.Node[] = [];
    function visit(node: ts.Node) { if (predicate(node)) nodes.push(node); ts.forEachChild(node, visit); }
    visit(root);
    return nodes;
}
function attributeExpression(element: ts.JsxSelfClosingElement, name: string) {
    const attribute = element.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText() === name) as ts.JsxAttribute;
    expect(attribute).toBeDefined();
    expect(ts.isJsxExpression(attribute.initializer!)).toBe(true);
    return (attribute.initializer as ts.JsxExpression).expression!;
}
const preferencesTree = loadTsx("../src/components/layout/app-config-modal.tsx");
const optionsTree = loadTsx("../src/components/canvas/prompt-optimize-options.tsx");
const panelTree = loadTsx("../src/components/canvas/canvas-node-prompt-panel.tsx");
const preferencesField = findNodes(preferencesTree, node => ts.isJsxElement(node)
    && node.openingElement.tagName.getText() === "Form.Item"
    && node.openingElement.attributes.getText().includes('t("config.preferences.promptLocalTimeoutSeconds")'))[0] as ts.JsxElement;
const preferencesInput = findNodes(preferencesField, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "InputNumber")[0] as ts.JsxSelfClosingElement;
const optionsInput = findNodes(optionsTree, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "InputNumber")[0] as ts.JsxSelfClosingElement;
function preferencesChange(value: unknown) {
    // Execute the real JSX handler with just the store and normalizer injected.
    const handler = new Function("updateConfig", "normalizeLocalPromptTimeoutSeconds",
        `return (${attributeExpression(preferencesInput, "onChange").getText()});`)(state().updateConfig, normalizeLocalPromptTimeoutSeconds) as (value: unknown) => void;
    handler(value);
}

const invalidValues: unknown[] = [undefined, null, "", "900", true, false, {}, [], new Number(900), 900n, NaN, Infinity, -Infinity, 29, 1801, 0, -30, 30.5, 600.1];

test("local timeout accepts only numbers that are integers in the inclusive 30–1800 range", () => {
    expect([DEFAULT_LOCAL_PROMPT_TIMEOUT_SECONDS, MIN_LOCAL_PROMPT_TIMEOUT_SECONDS, MAX_LOCAL_PROMPT_TIMEOUT_SECONDS]).toEqual([600, 30, 1800]);
    for (const value of [30, 31, 600, 900, 1200, 1800]) expect(normalizeLocalPromptTimeoutSeconds(value)).toBe(value);
    for (const value of invalidValues) expect(normalizeLocalPromptTimeoutSeconds(value)).toBe(600);
});

test("defaults and legacy configs without the local field use 600, independent of cloud settings", async () => {
    expect(defaultConfig.promptLocalTimeoutSeconds).toBe(600);
    for (const config of [{}, { promptCloudTimeoutSeconds: 1200 }, { promptCloudApis: [profile({ promptTimeoutSeconds: 1800 })] }]) {
        await reloadConfig(config);
        expect(state().config.promptLocalTimeoutSeconds).toBe(600);
    }
});

test("local setting saves, reloads and resets independently through the real preference handler", async () => {
    for (const value of [30, 900, 1800]) {
        preferencesChange(value);
        expect(state().config.promptLocalTimeoutSeconds).toBe(value);
        const saved = values.get(CONFIG_STORE_KEY)!;
        expect(JSON.parse(saved).state.config.promptLocalTimeoutSeconds).toBe(value);
        useConfigStore.setState({ config: structuredClone(defaultConfig) });
        values.set(CONFIG_STORE_KEY, saved);
        await useConfigStore.persist.rehydrate();
        expect(state().config.promptLocalTimeoutSeconds).toBe(value);
    }
    preferencesChange(null);
    expect(state().config.promptLocalTimeoutSeconds).toBe(600);
    await useConfigStore.persist.rehydrate();
    expect(state().config.promptLocalTimeoutSeconds).toBe(600);
});

test("invalid input resets to 600 without coercion, and malformed persisted fields also normalize", async () => {
    for (const value of invalidValues) {
        preferencesChange(900);
        preferencesChange(value);
        expect(state().config.promptLocalTimeoutSeconds).toBe(600);
    }
    for (const value of [undefined, null, "900", true, false, {}, [], 29, 1801, 0, 30.5]) {
        await reloadConfig({ promptLocalTimeoutSeconds: value } as Partial<AiConfig>);
        expect(state().config.promptLocalTimeoutSeconds).toBe(600);
    }
});

test("local edits never overwrite per-API cloud timeouts, active profile or secrets", async () => {
    const first = state().addPromptCloudApi(profile({ promptTimeoutSeconds: 1200, rememberKey: true }));
    const second = state().addPromptCloudApi(profile({ promptTimeoutSeconds: 1500, rememberKey: false }));
    const originalCloud = structuredClone(state().config.promptCloudApis);
    preferencesChange(900);
    expect(state().config.promptCloudApis).toEqual(originalCloud);
    expect(state().config.promptCloudApiId).toBe(first);
    expect(state().config.promptCloudTimeoutSeconds).toBe(1200);
    state().selectPromptCloudApi(second);
    expect(state().config.promptLocalTimeoutSeconds).toBe(900);
    expect(state().config.promptCloudTimeoutSeconds).toBe(1500);
    state().updatePromptCloudApi(second, { promptTimeoutSeconds: 1800 });
    expect(state().config.promptLocalTimeoutSeconds).toBe(900);
    const saved = JSON.parse(values.get(CONFIG_STORE_KEY)!).state.config as AiConfig;
    expect(saved.promptLocalTimeoutSeconds).toBe(900);
    expect(saved.promptCloudApis?.map(api => api.promptTimeoutSeconds)).toEqual([1200, 1800]);
    expect(saved.promptCloudApis?.map(api => api.apiKey)).toEqual(["test-only-key", ""]);
    await useConfigStore.persist.rehydrate();
    expect(state().config.promptLocalTimeoutSeconds).toBe(900);
    expect(state().config.promptCloudTimeoutSeconds).toBe(1800);
    state().removePromptCloudApi(second);
    state().removePromptCloudApi(first);
    expect(state().config.promptCloudTimeoutSeconds).toBe(600);
    expect(state().config.promptLocalTimeoutSeconds).toBe(900);
});

test("preferences and local options expose the same integer field and normalized values", () => {
    expect(preferencesField).toBeDefined();
    expect(preferencesField.getText()).toContain('extra={t("config.preferences.promptLocalTimeoutHint")}');
    for (const input of [preferencesInput, optionsInput]) {
        expect(attributeExpression(input, "min").getText()).toBe("MIN_LOCAL_PROMPT_TIMEOUT_SECONDS");
        expect(attributeExpression(input, "max").getText()).toBe("MAX_LOCAL_PROMPT_TIMEOUT_SECONDS");
        expect(attributeExpression(input, "precision").getText()).toBe("0");
        expect(attributeExpression(input, "step").getText()).toBe("1");
        expect(attributeExpression(input, "aria-label").getText()).toBe('t("config.preferences.promptLocalTimeoutSeconds")');
    }
    expect(attributeExpression(preferencesInput, "value").getText()).toBe("normalizeLocalPromptTimeoutSeconds(config.promptLocalTimeoutSeconds)");
    expect(attributeExpression(optionsInput, "value").getText()).toBe("normalizeLocalPromptTimeoutSeconds(localTimeoutSeconds)");
});

test("options show the field only for local engines with a setter; optional props preserve existing callers", () => {
    const props = findNodes(optionsTree, node => ts.isTypeAliasDeclaration(node) && node.name.text === "PromptOptimizeOptionsProps")[0] as ts.TypeAliasDeclaration;
    const members = (props.type as ts.TypeLiteralNode).members;
    for (const name of ["localTimeoutSeconds", "onLocalTimeoutChange"]) {
        const member = members.find(node => node.name?.getText() === name) as ts.PropertySignature;
        expect(member.questionToken).toBeDefined();
    }
    expect(optionsTree.getText()).toContain("localTimeoutSeconds = DEFAULT_LOCAL_PROMPT_TIMEOUT_SECONDS");
    let ancestor: ts.Node = optionsInput.parent;
    while (!ts.isConditionalExpression(ancestor)) ancestor = ancestor.parent;
    const condition = (ancestor as ts.ConditionalExpression).condition.getText();
    const shown = new Function("engine", "onLocalTimeoutChange", `return Boolean(${condition});`);
    expect(shown("local", () => {})).toBe(true);
    expect(shown("cloud", () => {})).toBe(false);
    expect(shown("local", undefined)).toBe(false);
    let selected = 0;
    const change = new Function("onLocalTimeoutChange", "normalizeLocalPromptTimeoutSeconds",
        `return (${attributeExpression(optionsInput, "onChange").getText()});`)((value: number) => { selected = value; }, normalizeLocalPromptTimeoutSeconds) as (value: unknown) => void;
    for (const value of [30, 900, 1800]) { change(value); expect(selected).toBe(value); }
    for (const value of invalidValues) { change(value); expect(selected).toBe(600); }
});

test("node options share global config, and KVMem startup budget is passed separately", () => {
    const options = findNodes(panelTree, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "PromptOptimizeOptions")[0] as ts.JsxSelfClosingElement;
    expect(attributeExpression(options, "localTimeoutSeconds").getText()).toBe("normalizeLocalPromptTimeoutSeconds(config.promptLocalTimeoutSeconds)");
    expect(attributeExpression(options, "onLocalTimeoutChange").getText()).toBe('(value) => updateConfig("promptLocalTimeoutSeconds", value)');
    expect(panelTree.getText()).toContain('startupTimeoutMs: captionEngine === "kvmem" ? capabilities?.captionStartupTimeoutMs : undefined');
});

test("both locales explain the shared local scope, per-API cloud independence and separate KVMem startup", () => {
    expect(zh.config.preferences.promptLocalTimeoutSeconds).toBe("本地提示词请求超时（秒）");
    expect(en.config.preferences.promptLocalTimeoutSeconds).toBe("Local prompt request timeout (seconds)");
    for (const locale of [zh, en]) {
        const hint = locale.config.preferences.promptLocalTimeoutHint;
        for (const token of ["600", "30", "1800", "H3", "API", "KVMem"]) expect(hint).toContain(token);
    }
    for (const token of ["生图本地", "本地图片反推", "共享", "云端", "独立", "启动时间另计"]) expect(zh.config.preferences.promptLocalTimeoutHint).toContain(token);
    for (const token of ["local image-generation", "local image-to-prompt", "Shared", "Cloud", "independently", "startup time is counted separately"]) expect(en.config.preferences.promptLocalTimeoutHint).toContain(token);
});
