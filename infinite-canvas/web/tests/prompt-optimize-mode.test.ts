import { expect, test } from 'bun:test';

// 提示词优化端点只认任务类型，跟具体视频工作流无关。
// 这里锁定「任意视频节点都能得到合理任务类型」——包括非 H3 的第三方工作流。
// 曾经入口被 H3 workflowId 白名单卡住，其它视频节点根本没有优化按钮。

const { resolvePromptOptimizeTaskType } = await import('../src/lib/canvas/prompt-optimize-mode');

const base = {
    isH3Reference: false,
    videoMode: undefined as string | undefined,
    isH3Text: false,
    referenceImageCount: 0,
    frameMode: 'first' as const,
    hasVideoReference: false,
    hasAudioReference: false,
};

test('H3 全参考工作流恒为全参考模式', () => {
    expect(resolvePromptOptimizeTaskType({ ...base, isH3Reference: true }).taskType).toBe('全参考模式(Reference to Video)');
});

test('H3 文生视频恒为文生视频，即使有参考图', () => {
    const r = resolvePromptOptimizeTaskType({ ...base, isH3Text: true, referenceImageCount: 3 });
    expect(r.taskType).toBe('文生视频(T2VA)');
    expect(r.isReferenceTask).toBe(false);
});

test('非 H3 工作流按 videoMode=text 判为文生视频', () => {
    // 这是改动的关键：第三方视频工作流没有 H3 的 workflowId，也要能拿到正确类型
    expect(resolvePromptOptimizeTaskType({ ...base, videoMode: 'text', referenceImageCount: 2 }).taskType).toBe('文生视频(T2VA)');
});

test('非 H3 工作流按 videoMode=reference 判为全参考', () => {
    const r = resolvePromptOptimizeTaskType({ ...base, videoMode: 'reference' });
    expect(r.taskType).toBe('全参考模式(Reference to Video)');
    expect(r.isReferenceTask).toBe(true);
});

test('连了参考视频或音频一律按全参考', () => {
    expect(resolvePromptOptimizeTaskType({ ...base, hasVideoReference: true }).taskType).toBe('全参考模式(Reference to Video)');
    expect(resolvePromptOptimizeTaskType({ ...base, hasAudioReference: true }).taskType).toBe('全参考模式(Reference to Video)');
});

test('没有参考图的普通视频节点按文生视频，不会误判成图生视频', () => {
    // 旧逻辑对非 H3 工作流会落到 I2VA，明明没图却说「首帧图生视频」
    expect(resolvePromptOptimizeTaskType({ ...base }).taskType).toBe('文生视频(T2VA)');
});

test('首帧 / 尾帧 / 首尾帧按 frameMode 与参考图数量区分', () => {
    expect(resolvePromptOptimizeTaskType({ ...base, referenceImageCount: 1, frameMode: 'first' }).taskType).toBe('首帧图生视频(I2VA)');
    expect(resolvePromptOptimizeTaskType({ ...base, referenceImageCount: 1, frameMode: 'last' }).taskType).toBe('尾帧图生视频(L2VA)');
    expect(resolvePromptOptimizeTaskType({ ...base, referenceImageCount: 2, frameMode: 'both' }).taskType).toBe('首尾帧视频(FL2VA)');
});

test('frameMode=both 但只有一张图时退回首帧，不谎报首尾帧', () => {
    expect(resolvePromptOptimizeTaskType({ ...base, referenceImageCount: 1, frameMode: 'both' }).taskType).toBe('首帧图生视频(I2VA)');
});

test('只有全参考任务才需要拼参考素材说明', () => {
    expect(resolvePromptOptimizeTaskType({ ...base, referenceImageCount: 2 }).isReferenceTask).toBe(false);
    expect(resolvePromptOptimizeTaskType({ ...base, videoMode: 'reference', referenceImageCount: 2 }).isReferenceTask).toBe(true);
});
