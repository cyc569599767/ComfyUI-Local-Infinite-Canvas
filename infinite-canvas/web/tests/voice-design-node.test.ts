import { afterAll, expect, test } from 'bun:test';

// NODE_SPECS 的标题走 i18n，i18n 初始化会读 localStorage，这里给个最小桩。
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

const { CanvasNodeType, isAudioNodeType } = await import('../src/types/canvas');
const { NODE_SPECS } = await import('../src/constant/canvas');
const { createCanvasNode } = await import('../src/lib/canvas/canvas-node-factory');

test('音色设计节点被识别为音频类节点', () => {
    expect(isAudioNodeType(CanvasNodeType.VoiceDesign)).toBe(true);
    expect(isAudioNodeType(CanvasNodeType.Audio)).toBe(true);
    // 其它类型不受影响
    expect(isAudioNodeType(CanvasNodeType.Image)).toBe(false);
    expect(isAudioNodeType(CanvasNodeType.Text)).toBe(false);
    expect(isAudioNodeType(CanvasNodeType.Video)).toBe(false);
    expect(isAudioNodeType(undefined)).toBe(false);
    expect(isAudioNodeType(null)).toBe(false);
});

test('音色设计节点默认锁定 voice-design 模式，与音频节点同尺寸', () => {
    const spec = NODE_SPECS[CanvasNodeType.VoiceDesign];
    expect(spec.metadata.audioMode).toBe('voice-design');
    // 「功能复制空音频节点」：尺寸与空音频节点一致
    expect(spec.width).toBe(NODE_SPECS[CanvasNodeType.Audio].width);
    expect(spec.height).toBe(NODE_SPECS[CanvasNodeType.Audio].height);
    // 空节点：无内容、待生成
    expect(spec.metadata.content).toBe('');
    expect(spec.metadata.status).toBe('idle');
});

test('普通音频节点不预设模式，仍由用户选择', () => {
    expect(NODE_SPECS[CanvasNodeType.Audio].metadata.audioMode).toBeUndefined();
});

test('创建音色设计节点时带上 voice-design 模式', () => {
    const node = createCanvasNode(CanvasNodeType.VoiceDesign, { x: 0, y: 0 });
    expect(node.type).toBe(CanvasNodeType.VoiceDesign);
    expect(node.metadata.audioMode).toBe('voice-design');
    expect(isAudioNodeType(node.type)).toBe(true);
});
