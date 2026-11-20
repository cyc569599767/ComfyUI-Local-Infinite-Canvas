import { expect, test } from 'bun:test';

import { buildAgentCreationTask, type AgentCreationSeed } from '../src/lib/agent/agent-creation-task';

const base: AgentCreationSeed = {
    seedId: 'seed-1',
    projectNodeId: 'wb-1',
    projectTitle: '灯塔',
    idea: '一个守塔人和一场风暴。',
    style: '电影感',
    aspectRatio: '16:9',
    targetSeconds: 90,
    createImages: true,
    createVideos: true,
    continueExisting: false,
    progress: '',
};

test('新项目先写蓝图，再建分镜', () => {
    const task = buildAgentCreationTask(base, base.idea);
    expect(task).toContain('wb-1');
    expect(task).toContain('灯塔');
    expect(task).toContain('故事蓝图');
    expect(task).toContain('90 秒');
    expect(task).toContain('16:9');
    expect(task).toContain('电影感');
    expect(task).not.toContain('这是续跑');
    expect(task).toContain('核验通过后自动进入下一阶段');
});

test('开了视频就必须逐镜出片，并建 video-editor 工作台卡收尾', () => {
    const task = buildAgentCreationTask(base, base.idea);
    expect(task).toContain('run_generation（mode=video）');
    // 收尾要落到 video-editor 工作台卡上，并说明打开它就能自动铺时间线、一键出片。
    expect(task).toContain('video-editor 工作台卡');
    expect(task).toContain('自动铺成时间线');
    expect(task).toContain('一键合成成片');
    // 不能冒充已经合成成片。
    expect(task).toContain('不要声称已经合成成片');
});

test('关掉图片就不该出现建图与出图指令', () => {
    const task = buildAgentCreationTask({ ...base, createImages: false, createVideos: false }, base.idea);
    expect(task).not.toContain('mode=image');
    expect(task).not.toContain('mode=video');
    expect(task).toContain('不建图片卡');
    expect(task).toContain('本次不做视频');
});

test('续跑要跳过已完成产物并带上上次进度', () => {
    const task = buildAgentCreationTask({ ...base, continueExisting: true, progress: '已完成蓝图与 3 个分镜' }, base.idea);
    expect(task).toContain('续跑');
    expect(task).toContain('已完成蓝图与 3 个分镜');
    expect(task).toContain('不要重做');
    // 续跑不该重新要求从零写蓝图。
    expect(task).not.toContain('然后写故事蓝图');
});

test('更新工作台时只写要改的字段，避免抹掉项目配置', () => {
    const task = buildAgentCreationTask(base, base.idea);
    expect(task).toContain('metadata.agentCreation');
    expect(task).toContain('只写你要改的字段');
    expect(task).toContain('conversationId');
});