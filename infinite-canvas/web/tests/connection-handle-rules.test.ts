import { beforeEach, expect, test } from 'bun:test';

// 左侧输入点（handleType = "target"）只能接到别的节点的输出点上。
// 这条规则分布在两处：normalizeConnection 决定「能否连」，渲染层决定「有没有右侧圆点」，
// 两边必须一致，否则会出现「看得见圆点却连不上」或反之。

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

const { CanvasNodeType } = await import('../src/types/canvas');
const { registerBuiltinNodes } = await import('../src/components/canvas/nodes/builtin-nodes');
const { hasOutputHandle, normalizeConnection, getConnectionTargetAnchor } = await import('../src/lib/canvas/canvas-node-geometry');

registerBuiltinNodes();

function node(id: string, type: string) {
    return { id, type, position: { x: 0, y: 0 }, width: 240, height: 120 } as never;
}

beforeEach(() => {
    // 每个用例前确认节点表已就绪（其它测试文件可能重置过）。
    registerBuiltinNodes();
});

test('左侧输入点不能接到没有输出点的节点', () => {
    const nodes = [node('img', CanvasNodeType.Image), node('card', CanvasNodeType.FreeCard), node('g', CanvasNodeType.Group)];
    // 从 img 的左侧拖到自由卡片：卡片没有输出点，无法作为上游
    expect(normalizeConnection('img', 'card', nodes, 'target')).toBeNull();
    // 分组不是节点，永远不能连
    expect(normalizeConnection('img', 'g', nodes, 'target')).toBeNull();
});

test('配置节点作为落点仍然允许连接，但方向是「对方 → 配置节点」', () => {
    // 配置节点没有输出点，但它是下游接收方，不受「落点必须有输出点」的限制。
    const nodes = [node('img', CanvasNodeType.Image), node('cfg', CanvasNodeType.Config)];
    expect(normalizeConnection('img', 'cfg', nodes, 'target')).toEqual({ fromNodeId: 'img', toNodeId: 'cfg' });
});

test('左侧输入点能接到有输出点的节点，方向为该节点 → 当前节点', () => {
    const nodes = [node('img', CanvasNodeType.Image), node('text', CanvasNodeType.Text)];
    expect(normalizeConnection('img', 'text', nodes, 'target')).toEqual({ fromNodeId: 'text', toNodeId: 'img' });
});

test('右侧输出点拖到没有输出点的节点仍然允许', () => {
    const nodes = [node('img', CanvasNodeType.Image), node('cfg', CanvasNodeType.Config)];
    // 从 img 右侧拖到 config：config 是下游，它不需要输出点
    expect(normalizeConnection('img', 'cfg', nodes, 'source')).toEqual({ fromNodeId: 'img', toNodeId: 'cfg' });
});

test('配置节点从左侧拖出仍按原有规则反转方向', () => {
    const nodes = [node('cfg', CanvasNodeType.Config), node('img', CanvasNodeType.Image)];
    // 配置节点自身不产出内容，从它的左侧拖出时把落点当成上游
    expect(normalizeConnection('cfg', 'img', nodes, 'target')).toEqual({ fromNodeId: 'img', toNodeId: 'cfg' });
});

test('拖到分组或自己身上一律拒绝', () => {
    const nodes = [node('img', CanvasNodeType.Image), node('g', CanvasNodeType.Group)];
    expect(normalizeConnection('img', 'g', nodes, 'target')).toBeNull();
    expect(normalizeConnection('img', 'g', nodes, 'source')).toBeNull();
    expect(normalizeConnection('img', 'img', nodes, 'target')).toBeNull();
});

test('hasOutputHandle 与渲染规则一致：只有配置节点分组和显式关闭的没有', () => {
    expect(hasOutputHandle({ type: CanvasNodeType.Image } as never)).toBe(true);
    expect(hasOutputHandle({ type: CanvasNodeType.Text } as never)).toBe(true);
    expect(hasOutputHandle({ type: CanvasNodeType.Audio } as never)).toBe(true);
    expect(hasOutputHandle({ type: CanvasNodeType.VoiceDesign } as never)).toBe(true);
    expect(hasOutputHandle({ type: CanvasNodeType.Config } as never)).toBe(false);
    expect(hasOutputHandle({ type: CanvasNodeType.Group } as never)).toBe(false);
    expect(hasOutputHandle({ type: CanvasNodeType.FreeCard } as never)).toBe(false);
});

test('落点锚点：从左侧拖出时看对方右侧，从右侧拖出时看对方左侧', () => {
    const target = node('n', CanvasNodeType.Image);
    expect(getConnectionTargetAnchor(target, { nodeId: 'n', handleType: 'target' } as never).x).toBe(240);
    expect(getConnectionTargetAnchor(target, { nodeId: 'n', handleType: 'source' } as never).x).toBe(0);
});

test('自定义插件节点默认有输出点', () => {
    // 未注册的类型走 ?? true，插件节点不会因为漏配 hasSourceHandle 就没法当上游
    expect(hasOutputHandle({ type: 'plugin-custom-node' } as never)).toBe(true);
});
