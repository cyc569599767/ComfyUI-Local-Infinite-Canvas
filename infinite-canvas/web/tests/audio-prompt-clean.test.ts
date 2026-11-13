import { afterAll, expect, test } from 'bun:test';

// canvas-node-generation 通过 i18n / localStorage 取标签，先给出最小可用的桩。
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

const { buildNodeGenerationContext } = await import('../src/components/canvas/canvas-node-generation');
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from '../src/types/canvas';

const node = (id: string, type: CanvasNodeType, content = '', extra: Partial<CanvasNodeData['metadata']> = {}): CanvasNodeData => ({
    id,
    type,
    title: id,
    position: { x: 0, y: 0 },
    width: 100,
    height: 100,
    metadata: { content, ...extra },
});

// 文本节点连到音频节点：音频只该用自己填的内容，不该拼接上游文本。
function audioWithUpstreamText() {
    const nodes = [
        node('script', CanvasNodeType.Text, '这是一段上游文本，会被念出来'),
        node('audio', CanvasNodeType.Audio, ''),
    ];
    const connections: CanvasConnection[] = [{ id: 'e1', fromNodeId: 'script', toNodeId: 'audio' }];
    return { nodes, connections };
}

test('音频节点的提示词只保留用户填写的内容，不拼接上游文本和固定标签', () => {
    const { nodes, connections } = audioWithUpstreamText();
    const context = buildNodeGenerationContext('audio', nodes, connections, '你好，很高兴认识你。');
    // 原样返回：没有【文本1】、没有上游那段文字。
    expect(context.prompt).toBe('你好，很高兴认识你。');
    expect(context.prompt).not.toContain('【');
    expect(context.prompt).not.toContain('这是一段上游文本');
});

test('以音频模式生成时同样不拼接上游文本（即使源节点不是音频节点）', () => {
    const { nodes, connections } = audioWithUpstreamText();
    // 从文本节点发起“音频参考”生成：源节点是文本，但本次是音频任务。
    const context = buildNodeGenerationContext('script', nodes, [...connections, { id: 'e2', fromNodeId: 'audio', toNodeId: 'script' }], '今天天气不错。', { audio: true });
    expect(context.prompt).toBe('今天天气不错。');
    expect(context.prompt).not.toContain('【');
});

test('图片与视频仍保留上游文本标签，行为不受音频改动影响', () => {
    const nodes = [node('script', CanvasNodeType.Text, '上游参考段落'), node('image', CanvasNodeType.Image, '')];
    const connections: CanvasConnection[] = [{ id: 'e1', fromNodeId: 'script', toNodeId: 'image' }];
    const context = buildNodeGenerationContext('image', nodes, connections, '画一只猫');
    // 图片需要【文本N】标记来表达“参考文本”语义，这里必须继续拼接。
    expect(context.prompt).toContain('画一只猫');
    expect(context.prompt).toContain('上游参考段落');
    expect(context.prompt).toContain('【');
});

test('音频 composer 的 @令牌不残留分隔符', () => {
    const nodes = [
        node('script', CanvasNodeType.Text, '上游文本'),
        node('audio', CanvasNodeType.Audio, ''),
        node('config', CanvasNodeType.Config, '', { composerContent: '组装中' }),
    ];
    const connections: CanvasConnection[] = [
        { id: 'e1', fromNodeId: 'script', toNodeId: 'config' },
        { id: 'e2', fromNodeId: 'config', toNodeId: 'audio' },
    ];
    // 组装节点按音频模式生成时，project.tsx 会传 { audio: true }。
    const context = buildNodeGenerationContext('config', nodes, connections, '朗读这段：@[node:script]', { audio: true });
    expect(context.prompt).not.toContain('【');
    expect(context.prompt).not.toContain('上游文本');
    // 不能留下“朗读这段：、”这类悬空分隔符。
    expect(context.prompt).not.toMatch(/[、,，]\s*$/);
});
