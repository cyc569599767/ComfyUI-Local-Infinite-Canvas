import { expect, test } from 'bun:test';

// 自由卡片曾经只认 image / video，音频工作流被归一成 other，
// 于是 UI 显示「暂不支持在自由卡片中生成」并且生成按钮直接禁用。
// 这里锁定「音频能贯穿归一化、文案、生成类型判断」这条链路。

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
process.on('exit', () => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
});

const { freeCardInfoFromSummary, freeCardOutputLabelKey } = await import('../src/components/canvas/canvas-free-card-panel');
const zh = (await import('../src/i18n/locales/zh-CN')).default as Record<string, any>;
const en = (await import('../src/i18n/locales/en-US')).default as Record<string, any>;

function pick(source: Record<string, any>, path: string): unknown {
    return path.split('.').reduce<any>((acc, key) => (acc == null ? acc : acc[key]), source);
}

const baseSummary = {
    id: 'w1',
    name: 'music3',
    sourceRel: 'audio/music3.json',
    sourceFormat: 'api' as const,
    archived: false,
    archivedAt: null,
    createdAt: '',
    updatedAt: '',
    sourceChanged: false,
    prompt: true,
    imageInputs: 0,
    size: null,
    count: null,
    hasSeed: false,
    seed: null,
    warnings: [],
};

test('音频工作流的 summary 归一化为 audio，而不是 other', () => {
    const info = freeCardInfoFromSummary({ ...baseSummary, outputType: 'audio' } as never);
    expect(info.outputType).toBe('audio');
});

test('图片与视频归一化不受影响', () => {
    expect(freeCardInfoFromSummary({ ...baseSummary, outputType: 'image' } as never).outputType).toBe('image');
    expect(freeCardInfoFromSummary({ ...baseSummary, outputType: 'video' } as never).outputType).toBe('video');
});

test('未知或缺失输出类型仍回落 other', () => {
    expect(freeCardInfoFromSummary({ ...baseSummary, outputType: null } as never).outputType).toBe('other');
});

test('音频类型有自己的文案，不会显示成「其他工作流」', () => {
    expect(pick(zh, freeCardOutputLabelKey('audio'))).toBe('音频工作流');
    expect(pick(en, freeCardOutputLabelKey('audio'))).toBe('Audio workflow');
    expect(freeCardOutputLabelKey('audio')).not.toBe(freeCardOutputLabelKey('other'));
});

test('四种输出类型各自映射到不同文案', () => {
    const keys = (['image', 'video', 'audio', 'other'] as const).map((type) => freeCardOutputLabelKey(type));
    expect(new Set(keys).size).toBe(4);
    for (const key of keys) {
        expect(typeof pick(zh, key)).toBe('string');
        expect(typeof pick(en, key)).toBe('string');
    }
});

test('「其他工作流」的提示不再断言只支持图片/视频', () => {
    expect(pick(zh, 'canvas.freeCard.otherWorkflowHint')).toContain('音频');
    expect(pick(en, 'canvas.freeCard.otherWorkflowHint')).toContain('audio');
});
