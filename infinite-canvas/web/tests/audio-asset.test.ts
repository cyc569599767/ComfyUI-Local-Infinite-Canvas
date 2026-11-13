import { expect, test } from 'bun:test';

// 资产 store 依赖 localStorage / localforage，这里只验证类型与数据形状，不触达持久化。
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

const { assetCoverUrl } = await import('../src/stores/use-asset-store');

test('音频资产可作为独立 kind 存在，不误用图片封面逻辑', () => {
    const asset = {
        id: 'a1',
        kind: 'audio' as const,
        title: '画布音频',
        coverUrl: '',
        tags: [],
        createdAt: '',
        updatedAt: '',
        data: { url: 'blob:audio', storageKey: 'audio:1', bytes: 1024, mimeType: 'audio/flac', durationMs: 2000 },
    };
    // 音频没有 dataUrl，封面逻辑不应把它当图片处理。
    expect(assetCoverUrl(asset as never)).toBe('');
    expect(asset.data.url).toBe('blob:audio');
});

test('图片资产仍走 preview 封面逻辑', () => {
    const asset = {
        id: 'i1',
        kind: 'image' as const,
        title: 'img',
        coverUrl: '',
        tags: [],
        createdAt: '',
        updatedAt: '',
        data: { dataUrl: 'data:image/png;base64,AAA', width: 10, height: 10, bytes: 3, mimeType: 'image/png' },
    };
    // 无 storageKey 时回落到 dataUrl 本身。
    expect(assetCoverUrl(asset as never)).toBe('data:image/png;base64,AAA');
});
