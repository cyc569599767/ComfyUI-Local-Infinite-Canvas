import { afterAll, expect, test } from 'bun:test';

// 「选择节点」菜单 = 空白处双击弹出的 NodeCreateMenu，它列出所有 showInCreateMenu !== false 的节点定义。
// 这里直接跑注册表，断言菜单里到底会出现哪些类型。
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

const { CanvasNodeType } = await import('../src/types/canvas');
const { registerBuiltinNodes } = await import('../src/components/canvas/nodes/builtin-nodes');
const { listNodeDefinitions } = await import('../src/lib/canvas/node-registry');

registerBuiltinNodes();
const selectable = listNodeDefinitions().filter((def) => def.showInCreateMenu !== false).map((def) => def.type);

test('选择节点菜单不含「音频生成」节点', () => {
    expect(selectable).not.toContain(CanvasNodeType.VoiceDesign);
});

test('选择节点菜单仍保留普通节点与普通音频节点', () => {
    for (const type of [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Config, CanvasNodeType.FreeCard, CanvasNodeType.Group]) {
        expect(selectable).toContain(type);
    }
});

test('音频生成节点仍注册在节点表里，只是不进选择菜单', () => {
    // 隐藏的是入口，不是节点本身：连接点右侧菜单、工具栏、已有画布里的 voice-design 节点都还要能用。
    const all = listNodeDefinitions().map((def) => def.type);
    expect(all).toContain(CanvasNodeType.VoiceDesign);
});
