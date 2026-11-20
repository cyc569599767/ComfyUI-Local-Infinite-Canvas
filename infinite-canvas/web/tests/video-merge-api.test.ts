import { afterAll, expect, test } from 'bun:test';
import type { AiConfig } from '../src/stores/use-config-store';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    },
});

const { defaultConfig } = await import('../src/stores/use-config-store');
const { createVideoMergeTask } = await import('../src/services/api/video');

const requests: FormData[] = [];
const paths: string[] = [];
const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
        paths.push(new URL(req.url).pathname);
        requests.push(await req.formData());
        return Response.json({ id: 'merge-task', object: 'video', status: 'queued' });
    },
});
afterAll(() => {
    server.stop(true);
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
});

const config: AiConfig = {
    ...defaultConfig,
    channels: [
        {
            id: 'local-gateway',
            name: '本地网关',
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            apiKey: 'local',
            apiFormat: 'openai',
            models: [{ name: 'video-h3-t2v', capability: 'video' }],
        },
    ],
    model: 'local-gateway::video-h3-t2v',
    videoModel: 'local-gateway::video-h3-t2v',
};

const clip = { source: 0, inPoint: 0, outPoint: 1, duration: 2, start: 0, track: 0, volume: 1 };
const source = { name: 'clip_1.mp4', url: 'data:video/mp4;base64,AAAAHGZ0eXBpc29t', type: 'video/mp4' };

test('合并请求打到 /videos/merge 并带上时间线', async () => {
    const before = requests.length;
    const task = await createVideoMergeTask(config, { clips: [clip], sources: [source], totalSeconds: 1 });
    expect(requests.length).toBe(before + 1);
    expect(paths.at(-1)).toBe('/v1/videos/merge');
    const body = requests.at(-1)!;
    expect(body.get('timeline')).toBe(JSON.stringify([clip]));
    expect(body.get('total_seconds')).toBe('1');
    const file = body.get('videos');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('clip_1.mp4');
    // 轮询要靠 model 解回同一个通道，这里必须保留通道编码。
    expect(task).toEqual({ id: 'merge-task', provider: 'openai', model: 'local-gateway::video-h3-t2v' });
});

test('多段片段按顺序上传，重复素材只传一次', async () => {
    const before = requests.length;
    await createVideoMergeTask(config, {
        clips: [clip, { ...clip, source: 0, start: 1 }],
        sources: [source],
        totalSeconds: 2,
    });
    const body = requests[before]!;
    // 一个源文件对应两段时间线片段，只应该有一个 videos part。
    expect(body.getAll('videos').length).toBe(1);
    expect(JSON.parse(String(body.get('timeline'))).length).toBe(2);
});

test('素材异步读取逆序完成时仍按来源索引上传', async () => {
    const fetchOriginal = globalThis.fetch;
    let releaseFirst!: () => void;
    const firstWait = new Promise<void>(resolve => { releaseFirst = resolve; });
    const finished: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://fixture.invalid/slow.mp4') {
            await firstWait; finished.push('slow'); return new Response('source-A', { headers: { 'content-type': 'video/mp4' } });
        }
        if (url === 'https://fixture.invalid/fast.mp4') {
            finished.push('fast'); releaseFirst(); return new Response('source-B', { headers: { 'content-type': 'video/mp4' } });
        }
        return fetchOriginal(input, init);
    }) as typeof fetch;
    try {
        await createVideoMergeTask(config, { clips: [clip, { ...clip, source: 1 }], sources: [
            { ...source, name: 'A.mp4', url: 'https://fixture.invalid/slow.mp4' },
            { ...source, name: 'B.mp4', url: 'https://fixture.invalid/fast.mp4' },
        ] });
        expect(finished).toEqual(['fast', 'slow']);
        const files = requests.at(-1)!.getAll('videos') as File[];
        expect(files.map(file => file.name)).toEqual(['A.mp4', 'B.mp4']);
        expect(await Promise.all(files.map(file => file.text()))).toEqual(['source-A', 'source-B']);
    } finally { globalThis.fetch = fetchOriginal; }
});

test('空片段列表直接拒绝，不发请求', async () => {
    const before = requests.length;
    await expect(createVideoMergeTask(config, { clips: [], sources: [source] })).rejects.toThrow();
    expect(requests.length).toBe(before);
});

test('缺少可用模型时给出明确错误', async () => {
    await expect(
        createVideoMergeTask({ ...config, model: '', videoModel: '' }, { clips: [clip], sources: [source] }),
    ).rejects.toThrow();
});
