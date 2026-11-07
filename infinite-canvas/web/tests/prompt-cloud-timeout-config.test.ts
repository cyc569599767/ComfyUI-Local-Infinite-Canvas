import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createJSONStorage } from "zustand/middleware";
import {
    DEFAULT_PROMPT_CLOUD_TIMEOUT_SECONDS,
    MIN_PROMPT_CLOUD_TIMEOUT_SECONDS,
    MAX_PROMPT_CLOUD_TIMEOUT_SECONDS,
    normalizePromptCloudTimeoutSeconds,
} from "../src/lib/prompt-cloud-timeout";
import type { AiConfig, PromptCloudApi } from "../src/stores/use-config-store";

const values = new Map<string, string>();
const memoryStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
};
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage });
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: memoryStorage } });
// A distinct module instance prevents other tests' browser stubs from disabling
// persist during the store's initial import.
const storeModulePath = "../src/stores/use-config-store.ts?prompt-cloud-timeout-config-test";
const { CONFIG_STORE_KEY, defaultConfig, normalizePromptCloudApis, normalizePromptCloudConfig, useConfigStore } = await import(storeModulePath) as typeof import("../src/stores/use-config-store");
const initialState = useConfigStore.getState();
const originalPersistStorage = useConfigStore.persist.getOptions().storage;
// Explicitly bind our storage even when another test has already imported the store.
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

const profile = (patch: Partial<PromptCloudApi> = {}): PromptCloudApi => ({
    id: "cloud-one", name: "Test cloud", baseUrl: "https://example.test/v1", apiKey: "test-only-key", model: "test-model", ...patch,
});
const config = (patch: Partial<AiConfig> = {}): AiConfig => ({ ...structuredClone(defaultConfig), ...patch });
const state = () => useConfigStore.getState();

// Execute the real config-file functions with injected file-save/store boundaries,
// without mocking modules globally, importing browser services, or making requests.
const fileSource = ts.createSourceFile("config-file.ts", readFileSync(new URL("../src/services/config-file.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const fileFunctions = fileSource.statements.filter(node => ts.isFunctionDeclaration(node)
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(fileSource) === "SECRET_KEY")));
const fileCode = fileFunctions.map(node => node.getText(fileSource).replace(/^export /, "")).join("\n");
let savedBlob: Blob | undefined;
const promptSources = { sources: [], schedule: { intervalMinutes: 30, lastFetchedAt: "" } };
const fileApi = new Function("saveAs", "i18n", "normalizePromptCloudConfig", "useConfigStore", "usePromptSourceStore",
    ts.transpileModule(fileCode, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
        + "\nreturn { exportAppConfig, importAppConfig };")(
    (blob: Blob) => { savedBlob = blob; }, { t: (key: string) => key }, normalizePromptCloudConfig, useConfigStore,
    { getState: () => promptSources, setState: () => {} },
) as { exportAppConfig: () => void; importAppConfig: (file: File) => Promise<void> };
const importConfig = (next: AiConfig, secretsStripped = false) => fileApi.importAppConfig(new File([JSON.stringify({
    app: "infinite-canvas", version: 1, config: next, webdav: initialState.webdav, promptSources, secretsStripped,
})], "test-config.json"));

const uiTree = ts.createSourceFile("app-config-modal.tsx", readFileSync(new URL("../src/components/layout/app-config-modal.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findUi(predicate: (node: ts.Node) => boolean): ts.Node[] {
    const matches: ts.Node[] = [];
    function visit(node: ts.Node) { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); }
    visit(uiTree);
    return matches;
}

test("timeout accepts only integer seconds in the inclusive range; every invalid value defaults without coercion or clamping", () => {
    expect([DEFAULT_PROMPT_CLOUD_TIMEOUT_SECONDS, MIN_PROMPT_CLOUD_TIMEOUT_SECONDS, MAX_PROMPT_CLOUD_TIMEOUT_SECONDS]).toEqual([600, 30, 1800]);
    for (const value of [30, 31, 600, 1200, 1800]) expect(normalizePromptCloudTimeoutSeconds(value)).toBe(value);
    for (const value of [undefined, null, "", "900", true, false, {}, [], NaN, Infinity, -Infinity, 29, 1801, 0, -30, 30.5, 600.1]) {
        expect(normalizePromptCloudTimeoutSeconds(value)).toBe(600);
    }
});

test("defaults, old profile lists and legacy single-cloud configs normalize to 600 seconds", () => {
    expect(defaultConfig.promptCloudTimeoutSeconds).toBe(600);
    expect(normalizePromptCloudConfig(config()).promptCloudTimeoutSeconds).toBe(600);
    const oldList = normalizePromptCloudConfig(config({ promptCloudApis: [profile()] }));
    expect(oldList.promptCloudApis?.[0].promptTimeoutSeconds).toBe(600);
    expect(oldList.promptCloudTimeoutSeconds).toBe(600);
    for (const timeout of [undefined, 1200, 1801]) {
        const migrated = normalizePromptCloudConfig(config({ promptCloudBaseUrl: "https://legacy.test", promptCloudModel: "old", promptCloudTimeoutSeconds: timeout }));
        expect(migrated.promptCloudApis).toHaveLength(1);
        expect(migrated.promptCloudApis?.[0].promptTimeoutSeconds).toBe(timeout === 1200 ? 1200 : 600);
        expect(migrated.promptCloudTimeoutSeconds).toBe(timeout === 1200 ? 1200 : 600);
    }
});

test("profile normalization retains per-profile values and replaces invalid persisted values", () => {
    const normalized = normalizePromptCloudApis([profile({ promptTimeoutSeconds: 30 }), profile({ id: "two", promptTimeoutSeconds: 1800 }), profile({ id: "bad", promptTimeoutSeconds: 4.5 })]);
    expect(normalized.map(api => api.promptTimeoutSeconds)).toEqual([30, 1800, 600]);
    const selected = normalizePromptCloudConfig(config({ promptCloudApis: normalized, promptCloudApiId: "two", promptCloudTimeoutSeconds: 900 }));
    expect(selected.promptCloudTimeoutSeconds).toBe(1800);
    expect(normalizePromptCloudConfig({ ...selected, promptCloudApiId: "missing" }).promptCloudTimeoutSeconds).toBe(30);
});

test("add, edit, switch and remove preserve isolated profile timeouts and the selected mirror", () => {
    const first = state().addPromptCloudApi(profile({ promptTimeoutSeconds: 900 }));
    const second = state().addPromptCloudApi(profile({ promptTimeoutSeconds: 1500 }));
    expect(state().config.promptCloudApiId).toBe(first);
    expect(state().config.promptCloudTimeoutSeconds).toBe(900);
    state().updatePromptCloudApi(second, { promptTimeoutSeconds: 1800 });
    expect(state().config.promptCloudTimeoutSeconds).toBe(900);
    state().selectPromptCloudApi(second);
    expect(state().config.promptCloudTimeoutSeconds).toBe(1800);
    state().updatePromptCloudApi(second, { name: "Renamed", rememberKey: false, apiKey: "rotated-key" });
    expect(state().config.promptCloudTimeoutSeconds).toBe(1800);
    state().selectPromptCloudApi(first);
    expect(state().config.promptCloudTimeoutSeconds).toBe(900);
    state().selectPromptCloudApi("unknown");
    expect(state().config.promptCloudApiId).toBe(first);
    state().removePromptCloudApi(first);
    expect(state().config.promptCloudApiId).toBe(second);
    expect(state().config.promptCloudTimeoutSeconds).toBe(1800);
    state().removePromptCloudApi(second);
    expect(state().config.promptCloudTimeoutSeconds).toBe(600);
    expect(state().config.promptCloudApis).toEqual([]);
});

test("adding defaults and updating invalid or cleared timeout use 600; unrelated edits retain it", () => {
    const id = state().addPromptCloudApi(profile());
    expect(state().config.promptCloudTimeoutSeconds).toBe(600);
    for (const value of [1801, 29, 900.5, NaN, undefined]) {
        state().updatePromptCloudApi(id, { promptTimeoutSeconds: 1200 });
        state().updatePromptCloudApi(id, { promptTimeoutSeconds: value });
        expect(state().config.promptCloudTimeoutSeconds).toBe(600);
        expect(state().config.promptCloudApis?.[0].promptTimeoutSeconds).toBe(600);
    }
});

test("persisted key redaction and rehydration preserve both profile timeouts and active mirror", async () => {
    const first = state().addPromptCloudApi(profile({ promptTimeoutSeconds: 900, rememberKey: true }));
    const second = state().addPromptCloudApi(profile({ promptTimeoutSeconds: 1500, rememberKey: false }));
    state().selectPromptCloudApi(second);
    const saved = values.get(CONFIG_STORE_KEY)!;
    const persisted = JSON.parse(saved).state.config;
    expect(persisted.promptCloudApis.map((api: PromptCloudApi) => api.promptTimeoutSeconds)).toEqual([900, 1500]);
    expect(persisted.promptCloudApis.map((api: PromptCloudApi) => api.apiKey)).toEqual(["test-only-key", ""]);
    expect(persisted.promptCloudApiKey).toBe("");
    expect(persisted.promptCloudTimeoutSeconds).toBe(1500);
    expect(state().config.promptCloudApiKey).toBe("test-only-key");
    useConfigStore.setState({ config: config() });
    values.set(CONFIG_STORE_KEY, saved);
    await useConfigStore.persist.rehydrate();
    expect(state().config.promptCloudTimeoutSeconds).toBe(1500);
    state().selectPromptCloudApi(first);
    expect(state().config.promptCloudTimeoutSeconds).toBe(900);
});

test("persist merge normalizes old configs, explicit malformed mirrors and legacy timeout fields", async () => {
    const cases: Array<[Partial<AiConfig>, number]> = [
        [{ promptCloudApis: [profile()], promptCloudTimeoutSeconds: 42 }, 600],
        [{ promptCloudApis: [profile({ promptTimeoutSeconds: 900 })], promptCloudTimeoutSeconds: 1801 }, 900],
        [{ promptCloudBaseUrl: "https://legacy.test", promptCloudModel: "model", promptCloudTimeoutSeconds: 1200 }, 1200],
        [{ promptCloudBaseUrl: "https://legacy.test", promptCloudModel: "model" }, 600],
    ];
    for (const [old, expected] of cases) {
        values.set(CONFIG_STORE_KEY, JSON.stringify({ state: { config: old }, version: 0 }));
        await useConfigStore.persist.rehydrate();
        expect(state().config.promptCloudTimeoutSeconds).toBe(expected);
        expect(state().config.promptCloudApis?.[0].promptTimeoutSeconds).toBe(expected);
    }
});

test("config export strips secrets but retains timeout; import restores timeout and existing keys", async () => {
    const id = state().addPromptCloudApi(profile({ promptTimeoutSeconds: 1500, rememberKey: false }));
    fileApi.exportAppConfig();
    const exported = JSON.parse(await savedBlob!.text());
    expect(exported.version).toBe(1);
    expect(exported.config.promptCloudApis[0].apiKey).toBe("");
    expect(exported.config.promptCloudApiKey).toBe("");
    expect(exported.config.promptCloudApis[0].promptTimeoutSeconds).toBe(1500);
    expect(exported.config.promptCloudTimeoutSeconds).toBe(1500);
    state().updatePromptCloudApi(id, { promptTimeoutSeconds: 30 });
    await fileApi.importAppConfig(new File([JSON.stringify(exported)], "roundtrip.json"));
    expect(state().config.promptCloudTimeoutSeconds).toBe(1500);
    expect(state().config.promptCloudApis?.[0].promptTimeoutSeconds).toBe(1500);
    expect(state().config.promptCloudApiKey).toBe("test-only-key");
});

test("import accepts old version-1 configs and retains each profile's own timeout on selection", async () => {
    await importConfig(config({ promptCloudApis: [profile(), profile({ id: "two", promptTimeoutSeconds: 1800 })], promptCloudApiId: "two" }));
    expect(state().config.promptCloudTimeoutSeconds).toBe(1800);
    state().selectPromptCloudApi("cloud-one");
    expect(state().config.promptCloudTimeoutSeconds).toBe(600);
    await importConfig(config({ promptCloudBaseUrl: "https://legacy.test", promptCloudModel: "old", promptCloudTimeoutSeconds: 1200 }));
    expect(state().config.promptCloudTimeoutSeconds).toBe(1200);
});

test("cloud editor repopulates existing and new timeouts without leaking the previous profile", () => {
    const declaration = findUi(node => ts.isVariableDeclaration(node) && node.name.getText(uiTree) === "openCloudApiEditor")[0] as ts.VariableDeclaration;
    let filled: Partial<PromptCloudApi> = {};
    const openEditor = new Function("setEditingCloudApiId", "resetCloudModelFetch", "cloudApiForm", "setCloudApiEditorOpen", "normalizePromptCloudTimeoutSeconds", "DEFAULT_PROMPT_CLOUD_TIMEOUT_SECONDS",
        ts.transpileModule(`const openEditor = ${declaration.initializer!.getText(uiTree)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "return openEditor;")(
        () => {}, () => {}, { setFieldsValue: (value: Partial<PromptCloudApi>) => { filled = value; } }, () => {}, normalizePromptCloudTimeoutSeconds, DEFAULT_PROMPT_CLOUD_TIMEOUT_SECONDS,
    ) as (api?: PromptCloudApi) => void;
    openEditor(profile({ promptTimeoutSeconds: 1500 }));
    expect(filled.promptTimeoutSeconds).toBe(1500);
    openEditor();
    expect(filled.promptTimeoutSeconds).toBe(600);
    openEditor(profile());
    expect(filled.promptTimeoutSeconds).toBe(600);
});

test("cloud timeout form field enforces integer range and both locales describe its limited scope", async () => {
    const field = findUi(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(uiTree) === "Form.Item"
        && node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(uiTree) === "name" && attribute.initializer?.getText(uiTree) === '"promptTimeoutSeconds"'))[0] as ts.JsxElement;
    expect(field).toBeDefined();
    const text = field.getText(uiTree);
    for (const expected of ['type: "integer"', 'required: true', 'min: MIN_PROMPT_CLOUD_TIMEOUT_SECONDS', 'max: MAX_PROMPT_CLOUD_TIMEOUT_SECONDS', 'initialValue={DEFAULT_PROMPT_CLOUD_TIMEOUT_SECONDS}', '<InputNumber', 'precision={0}']) expect(text).toContain(expected);
    const zh = (await import("../src/i18n/locales/zh-CN")).default.config.cloudApi;
    const en = (await import("../src/i18n/locales/en-US")).default.config.cloudApi;
    expect(zh.promptTimeoutSeconds).toBe("提示词请求超时（秒）");
    for (const token of ["600", "30", "1800", "H3", "Agent"]) {
        expect(zh.promptTimeoutHint).toContain(token);
        expect(en.promptTimeoutHint).toContain(token);
    }
    expect(zh.promptTimeoutHint).toContain("服务商自身");
    expect(en.promptTimeoutHint).toContain("provider's own");
});
