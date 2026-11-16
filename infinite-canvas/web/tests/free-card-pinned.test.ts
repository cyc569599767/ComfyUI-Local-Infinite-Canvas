import { expect, test } from 'bun:test';

// 固定配置项：从工作流图里挑参数放到卡片上。
// 这里锁的是「绑定与图数据如何对齐」——错一位的表现是卡片上少了控件或改了没生效。

const { buildCustomValues, customKey, mergePinned } = await import('../src/lib/canvas/free-card-pinned');

type Graph = Parameters<typeof mergePinned>[1];
type Binding = Parameters<typeof mergePinned>[0][number];

function graph(): Graph {
    return {
        nodes: [
            { id: '2', title: 'Sampler', classType: 'KSampler', mode: 0, output: false, inputs: [
                { name: 'steps', kind: 'number', value: 20, options: [], integer: true },
                { name: 'cfg', kind: 'number', value: 7.5, options: [], integer: false },
                { name: 'sampler_name', kind: 'combo', value: 'euler', options: ['euler', 'dpmpp_2m'], integer: false },
                { name: 'positive', kind: 'text', value: 'a cat', options: [], integer: false },
            ] },
            { id: '9', title: 'Load Checkpoint', classType: 'CheckpointLoaderSimple', mode: 0, output: false, inputs: [
                { name: 'ckpt_name', kind: 'combo', value: 'model.safetensors', options: ['model.safetensors'], integer: false },
            ] },
        ],
        links: [{ from: '9', to: '2', input: 'model' }],
    };
}

test('合并时用条目上的名字，类型和选项从图里取', () => {
    const bindings: Binding[] = [{ node: '2', input: 'steps', label: '采样步数' }];
    const merged = mergePinned(bindings, graph());
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe('采样步数');
    expect(merged[0].kind).toBe('number');
    expect(merged[0].integer).toBe(true);
    expect(merged[0].value).toBe(20);
});

test('combo 带出选项，前端才能给下拉', () => {
    const merged = mergePinned([{ node: '2', input: 'sampler_name', label: '采样器' }], graph());
    expect(merged[0].kind).toBe('combo');
    expect(merged[0].options).toEqual(['euler', 'dpmpp_2m']);
});

test('图里找不到的绑定被丢弃：输入已不存在或被连线占用', () => {
    // 工作流改过之后，原来固定的 ckpt 可能已经不在可写列表里。
    const merged = mergePinned([
        { node: '2', input: 'steps', label: '保留' },
        { node: '9', input: 'nonexistent', label: '输入已消失' },
        { node: '404', input: 'steps', label: '节点已消失' },
    ], graph());
    expect(merged.map((item) => item.input)).toEqual(['steps']);
});

test('图为空时不会渲染出半成品控件', () => {
    expect(mergePinned([{ node: '2', input: 'steps', label: 'x' }], null)).toEqual([]);
});

test('值没改过时提交工作流原值，等于没写', () => {
    const pinned = mergePinned([
        { node: '2', input: 'steps', label: '步数' },
        { node: '2', input: 'cfg', label: 'cfg' },
    ], graph());
    // 用户只动了 steps
    const values = buildCustomValues(pinned, { [customKey({ node: '2', input: 'steps' })]: 8 });
    expect(values).toEqual([
        { node: '2', input: 'steps', value: 8 },
        { node: '2', input: 'cfg', value: 7.5 },
    ]);
});

test('文本被清空时提交空串：用户就是想清掉', () => {
    const pinned = mergePinned([{ node: '2', input: 'positive', label: '提示词' }], graph());
    const values = buildCustomValues(pinned, { [customKey({ node: '2', input: 'positive' })]: '' });
    // 回落到原值会让用户以为控件坏了：他删了内容，生成却还带着旧文本。
    expect(values).toEqual([{ node: '2', input: 'positive', value: '' }]);
});

test('数字清空时跳过，避免把空串写进 INT/FLOAT 字段', () => {
    const pinned = mergePinned([{ node: '2', input: 'steps', label: '步数' }], graph());
    const values = buildCustomValues(pinned, { [customKey({ node: '2', input: 'steps' })]: '' });
    expect(values).toEqual([]);
});

test('没有固定项时不提交任何值', () => {
    expect(buildCustomValues([], {})).toEqual([]);
});
