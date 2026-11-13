import { beforeEach, expect, test } from 'bun:test';

// 「工作流」菜单下的「应用」= 多个工作流组合成的固定功能。
// 这里锁定数据层与布局规划：读取容错、缺失工作流的处理、卡片摆放坐标。

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
        localStorage: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => store.set(k, v),
            removeItem: (k: string) => store.delete(k),
        },
    },
});

const { WORKFLOW_APPS_KEY, planWorkflowAppLayout, readWorkflowApps, writeWorkflowApps } = await import('../src/lib/canvas/workflow-apps');

type App = Parameters<typeof writeWorkflowApps>[0][number];

function makeApp(overrides: Partial<App> = {}): App {
    return {
        id: 'app-1',
        name: '短剧一条龙',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        steps: [
            { workflowId: 'wf-a', column: 0 },
            { workflowId: 'wf-b', column: 1 },
        ],
        ...overrides,
    };
}

beforeEach(() => store.clear());

test('写入后能读回，步骤字段完整', () => {
    expect(writeWorkflowApps([makeApp()])).toBe(true);
    const apps = readWorkflowApps();
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe('短剧一条龙');
    expect(apps[0].steps.map((s) => s.workflowId)).toEqual(['wf-a', 'wf-b']);
});

test('没有数据时返回空数组，不是报错', () => {
    expect(readWorkflowApps()).toEqual([]);
});

test('JSON 损坏时返回空数组，不让整个侧栏崩掉', () => {
    store.set(WORKFLOW_APPS_KEY, '{不是合法 JSON');
    expect(readWorkflowApps()).toEqual([]);
});

test('存储不是数组时返回空数组', () => {
    store.set(WORKFLOW_APPS_KEY, JSON.stringify({ oops: true }));
    expect(readWorkflowApps()).toEqual([]);
});

test('跳过缺 id/名称的坏条目，保留合法项', () => {
    store.set(WORKFLOW_APPS_KEY, JSON.stringify([
        { id: 'ok', name: '正常', steps: [] },
        { id: '', name: '缺 id', steps: [] },
        { id: 'no-name', steps: [] },
        { id: 'bad-step', name: '坏步骤', steps: [{ column: 1 }, { workflowId: 'wf-x', column: 0 }] },
    ]));
    const apps = readWorkflowApps();
    expect(apps.map((a) => a.id)).toEqual(['ok', 'bad-step']);
    // 缺 workflowId 的步骤被丢掉，合法的留下
    expect(apps[1].steps.map((s) => s.workflowId)).toEqual(['wf-x']);
});

test('列号缺省或非法时归到第 0 列', () => {
    store.set(WORKFLOW_APPS_KEY, JSON.stringify([
        { id: 'a', name: 'a', steps: [{ workflowId: 'wf-a' }, { workflowId: 'wf-b', column: -5 }] },
    ]));
    const steps = readWorkflowApps()[0].steps;
    expect(steps.map((s) => s.column)).toEqual([0, 0]);
});

test('布局：列号决定横向位置，同列纵向堆叠', () => {
    const app = makeApp({
        steps: [
            { workflowId: 'wf-a', column: 0 },
            { workflowId: 'wf-b', column: 0 },
            { workflowId: 'wf-c', column: 1 },
        ],
    });
    const { placements, missing } = planWorkflowAppLayout(app, ['wf-a', 'wf-b', 'wf-c'], { columnGap: 400, rowGap: 300 });
    expect(missing).toEqual([]);
    expect(placements.map((p) => [p.x, p.y])).toEqual([
        [0, 0],
        [0, 300],
        [400, 0],
    ]);
});

test('工作流已删除的步骤被跳过，并如实回报缺失项', () => {
    const app = makeApp({
        steps: [
            { workflowId: 'wf-a', column: 0 },
            { workflowId: 'gone-1', column: 1 },
            { workflowId: 'gone-2', column: 2 },
            { workflowId: 'wf-b', column: 3 },
        ],
    });
    const { placements, missing } = planWorkflowAppLayout(app, ['wf-a', 'wf-b'], { columnGap: 400, rowGap: 300 });
    // 缺一个都不能静默：否则用户拿到一条少了一环的链却不知道原因
    expect(missing).toEqual(['gone-1', 'gone-2']);
    expect(placements.map((p) => p.step.workflowId)).toEqual(['wf-a', 'wf-b']);
});

test('同一个缺失工作流只回报一次', () => {
    const app = makeApp({
        steps: [
            { workflowId: 'gone', column: 0 },
            { workflowId: 'gone', column: 1 },
        ],
    });
    expect(planWorkflowAppLayout(app, [], { columnGap: 400, rowGap: 300 }).missing).toEqual(['gone']);
});

test('全部工作流都不存在时没有可摆放项', () => {
    const { placements, missing } = planWorkflowAppLayout(makeApp(), [], { columnGap: 400, rowGap: 300 });
    expect(placements).toEqual([]);
    expect(missing).toEqual(['wf-a', 'wf-b']);
});

test('没有步骤的应用不会产生任何卡片', () => {
    const { placements } = planWorkflowAppLayout(makeApp({ steps: [] }), ['wf-a'], { columnGap: 400, rowGap: 300 });
    expect(placements).toEqual([]);
});

test('显式 row 生效，可把两步摆成并行分支', () => {
    const app = makeApp({
        steps: [
            { workflowId: 'wf-a', column: 0, row: 0 },
            { workflowId: 'wf-b', column: 0, row: 1 },
            { workflowId: 'wf-c', column: 1, row: 0 },
        ],
    });
    const { placements } = planWorkflowAppLayout(app, ['wf-a', 'wf-b', 'wf-c'], { columnGap: 400, rowGap: 300 });
    expect(placements.map((p) => [p.x, p.y])).toEqual([
        [0, 0],
        [0, 300],
        [400, 0],
    ]);
});

test('存储不可用时不崩溃，写入返回 false', () => {
    const original = (globalThis as any).window;
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { get localStorage() { throw new Error('denied'); } },
    });
    try {
        expect(readWorkflowApps()).toEqual([]);
        expect(writeWorkflowApps([makeApp()])).toBe(false);
    } finally {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: original });
    }
});

test('配额写满时写入返回 false，调用方可提示用户', () => {
    const original = (globalThis as any).window;
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            localStorage: {
                getItem: () => null,
                setItem: () => { throw new Error('QuotaExceededError'); },
                removeItem: () => {},
            },
        },
    });
    try {
        expect(writeWorkflowApps([makeApp()])).toBe(false);
    } finally {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: original });
    }
});