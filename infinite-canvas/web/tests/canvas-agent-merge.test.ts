import { afterAll, expect, test } from 'bun:test';

// canvas-agent-ops 会经由 node-registry 拉到 i18n，而 i18n 在模块顶层读 localStorage。
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
});

const { applyCanvasAgentOps } = await import('../src/lib/canvas/canvas-agent-ops');
const { CanvasNodeType } = await import('../src/types/canvas');

function snapshot(nodes: Array<Record<string, unknown>>) {
    return {
        projectId: 'p1',
        title: '画布',
        nodes: nodes as never,
        connections: [],
        selectedNodeIds: [],
        viewport: { x: 0, y: 0, scale: 1 },
    };
}

test('Agent 只回传部分项目字段时，不抹掉会话与开关', () => {
    // 踩过：update_node 对 metadata 做浅合并，Agent 报告进度时只写
    // { agentCreation: { status, progress } }，会把 conversationId / createVideos 一起清空，
    // 工作台随后再也找不到自己的对话。
    const before = snapshot([
        {
            id: 'wb-1',
            type: CanvasNodeType.Workbench,
            title: '项目',
            position: { x: 0, y: 0 },
            width: 360,
            height: 240,
            metadata: {
                workbenchKind: 'agent-creation',
                agentCreation: {
                    idea: '一个关于灯塔的故事',
                    style: '电影感',
                    aspectRatio: '16:9',
                    targetSeconds: 60,
                    createImages: true,
                    createVideos: true,
                    status: 'running',
                    progress: '正在写蓝图',
                    conversationId: 'conv-1',
                },
            },
        },
    ]);
    const next = applyCanvasAgentOps(before, [
        { type: 'update_node', id: 'wb-1', metadata: { agentCreation: { status: 'ready', progress: '已完成 6 镜' } } as never },
    ]);
    const project = next.nodes[0].metadata?.agentCreation;
    expect(project?.status).toBe('ready');
    expect(project?.progress).toBe('已完成 6 镜');
    expect(project?.conversationId).toBe('conv-1');
    expect(project?.idea).toBe('一个关于灯塔的故事');
    expect(project?.createVideos).toBe(true);
    expect(next.nodes[0].metadata?.workbenchKind).toBe('agent-creation');
});

test('Agent 可以显式关掉某个开关', () => {
    // 合并不能变成「永远保留旧值」：Agent 明确写 false 时必须生效。
    const before = snapshot([
        {
            id: 'wb-2',
            type: CanvasNodeType.Workbench,
            title: '项目',
            position: { x: 0, y: 0 },
            width: 360,
            height: 240,
            metadata: { workbenchKind: 'agent-creation', agentCreation: { idea: 'x', createVideos: true, conversationId: 'conv-2' } },
        },
    ]);
    const next = applyCanvasAgentOps(before, [
        { type: 'update_node', id: 'wb-2', metadata: { agentCreation: { createVideos: false } } as never },
    ]);
    expect(next.nodes[0].metadata?.agentCreation?.createVideos).toBe(false);
    expect(next.nodes[0].metadata?.agentCreation?.conversationId).toBe('conv-2');
});

test('普通卡片正文仍然整段覆盖', () => {
    // 只有嵌套项目配置需要合并；文本卡正文是整段替换的语义。
    const before = snapshot([
        {
            id: 'txt-1',
            type: CanvasNodeType.Text,
            title: '蓝图',
            position: { x: 0, y: 0 },
            width: 320,
            height: 200,
            metadata: { content: '旧正文' },
        },
    ]);
    const next = applyCanvasAgentOps(before, [{ type: 'update_node', id: 'txt-1', metadata: { content: '新正文' } as never }]);
    expect(next.nodes[0].metadata?.content).toBe('新正文');
});