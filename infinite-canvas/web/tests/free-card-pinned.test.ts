import { expect, test } from 'bun:test';

// 固定配置项：从工作流图里挑参数放到卡片上。
// 这里锁的是「绑定与图数据如何对齐」——错一位的表现是卡片上少了控件或改了没生效。

const { buildCustomValues, customKey, mergePinned, mergeTextInputs } = await import('../src/lib/canvas/free-card-pinned');

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

// ── 显示位置（卡片 / 生成设置） ──

const { bindingSurface, splitBySurface } = await import('../src/lib/canvas/free-card-pinned');

test('旧数据没有 surface 时落在卡片上，和加字段之前一致', () => {
    const merged = mergePinned([{ node: '2', input: 'steps', label: '步数' }], graph());
    expect(merged[0].surface).toBe('card');
    // 不认识的值也不该让这条绑定消失，回落到卡片。
    expect(bindingSurface({ surface: 'nonsense' })).toBe('card');
});

test('surface 从绑定读回，不会在合并时丢掉', () => {
    const merged = mergePinned([{ node: '2', input: 'steps', label: '步数', surface: 'settings' }], graph());
    expect(merged[0].surface).toBe('settings');
});

test('按显示位置分组且保持原有顺序', () => {
    const merged = mergePinned(
        [
            { node: '2', input: 'steps', label: 'a' },
            { node: '2', input: 'cfg', label: 'b', surface: 'settings' },
            { node: '2', input: 'sampler_name', label: 'c' },
            { node: '2', input: 'positive', label: 'd', surface: 'settings' },
        ],
        graph(),
    );
    const { card, settings } = splitBySurface(merged);
    expect(card.map((item) => item.label)).toEqual(['a', 'c']);
    expect(settings.map((item) => item.label)).toEqual(['b', 'd']);
});

test('两边都为空时不产生多余分组', () => {
    const { card, settings } = splitBySurface([]);
    expect(card).toEqual([]);
    expect(settings).toEqual([]);
});

// ── 弹窗里的多列排布 ──

const { PINNED_GRID_COLUMNS, pinnedColumnSpan, reorderPinned } = await import('../src/lib/canvas/free-card-pinned');

test('文本类独占整行，其余按半宽并排', () => {
    // 半宽的文本框连一行提示词都看不全。
    expect(pinnedColumnSpan({ kind: 'text' })).toBe(PINNED_GRID_COLUMNS);
    expect(pinnedColumnSpan({ kind: 'number' })).toBe(1);
    expect(pinnedColumnSpan({ kind: 'combo' })).toBe(1);
    expect(pinnedColumnSpan({ kind: 'boolean' })).toBe(1);
});

test('两列时一组数字正好排满一行', () => {
    const spans = [{ kind: 'number' as const }, { kind: 'number' as const }].map(pinnedColumnSpan);
    expect(spans.reduce((a, b) => a + b, 0)).toBe(PINNED_GRID_COLUMNS);
});

test('长 combo 也独占整行，避免模型文件名被截断', () => {
    expect(pinnedColumnSpan({ kind: 'combo', value: 'short', options: ['a-very-long-model-file-name-that-is-hard-to-read.safetensors'] })).toBe(PINNED_GRID_COLUMNS);
    expect(pinnedColumnSpan({ kind: 'combo', value: 'short', options: ['euler', 'normal'] })).toBe(1);
});

test('排序只改变同一显示区域，保留另一组在原槽位和值', () => {
    const pinned = mergePinned([
        { node: '2', input: 'steps', label: 'card-a' },
        { node: '2', input: 'cfg', label: 'settings-a', surface: 'settings' },
        { node: '2', input: 'sampler_name', label: 'card-b' },
        { node: '2', input: 'positive', label: 'settings-b', surface: 'settings' },
    ], graph());
    const original = [...pinned];
    const moved = reorderPinned(pinned, customKey({ node: '2', input: 'sampler_name' }), customKey({ node: '2', input: 'steps' }), 'before');
    expect(moved.map((item) => item.label)).toEqual(['card-b', 'settings-a', 'card-a', 'settings-b']);
    expect(moved[1]).toBe(original[1]);
    expect(moved[3]).toBe(original[3]);
    expect(pinned.map((item) => item.label)).toEqual(['card-a', 'settings-a', 'card-b', 'settings-b']);
});

test('排序支持 before/after，并拒绝跨区域、自己、缺失目标且无效操作保持引用', () => {
    const pinned = mergePinned([
        { node: '2', input: 'steps', label: 'a' },
        { node: '2', input: 'cfg', label: 'b' },
        { node: '2', input: 'sampler_name', label: 'settings', surface: 'settings' },
    ], graph());
    const key = (input: string) => customKey({ node: '2', input });
    expect(reorderPinned(pinned, key('steps'), key('cfg'), 'after').map((item) => item.label)).toEqual(['b', 'a', 'settings']);
    expect(reorderPinned(pinned, key('cfg'), key('steps'), 'before').map((item) => item.label)).toEqual(['b', 'a', 'settings']);
    expect(reorderPinned(pinned, key('steps'), key('sampler_name'))).toBe(pinned);
    expect(reorderPinned(pinned, key('steps'), key('steps'))).toBe(pinned);
    expect(reorderPinned(pinned, key('steps'), key('missing'))).toBe(pinned);
});

test('取消固定的自动文本刷新后不重新出现，再次拖入可恢复', async () => {
    const { savePinnedLayout } = await import('../src/lib/canvas/free-card-pinned');
    const original = mergeTextInputs([], textInputs(), graph());
    const removed = original.filter((item) => item.node !== '4');
    const saved = savePinnedLayout(removed, original, []);
    expect(saved.find((item) => item.node === '4')?.unpinned).toBe(true);
    const reloaded = mergeTextInputs(mergePinned(saved, graph()), textInputs(), graph(), '', saved);
    expect(reloaded.map((item) => item.node)).toEqual(['3', '7']);
    const again = savePinnedLayout([...reloaded, original[1]], reloaded, saved);
    expect(again.find((item) => item.node === '4')?.unpinned).not.toBe(true);
    expect(mergeTextInputs(mergePinned(again, graph()), textInputs(), graph(), '', again).map((item) => item.node)).toEqual(['3', '7', '4']);
    expect(original).toHaveLength(3);
});

test('删除普通参数不留假固定项，后续排序仍保留文本的取消记录', async () => {
    const { savePinnedLayout } = await import('../src/lib/canvas/free-card-pinned');
    const current = mergeTextInputs(mergePinned([{ node: '2', input: 'steps', label: '步数' }], graph()), textInputs(), graph());
    const saved = savePinnedLayout(current.filter((item) => item.node !== '2' && item.node !== '4'), current, []);
    expect(saved.some((item) => item.node === '2')).toBe(false);
    const visible = mergeTextInputs(mergePinned(saved, graph()), textInputs(), graph(), '', saved);
    const reordered = savePinnedLayout([...visible].reverse(), visible, saved);
    expect(reordered.find((item) => item.node === '4')?.unpinned).toBe(true);
});

test('拖拽只接受本面板当前拖动项，外部/过期/损坏的数据不允许删除', async () => {
    const { resolvePinnedDrag } = await import('../src/lib/canvas/free-card-pinned');
    const items = mergeTextInputs([], textInputs());
    const key = customKey(items[1]);
    const raw = JSON.stringify({ node: '4', input: 'text' });
    expect(resolvePinnedDrag(items, raw, key)).toBe(items[1]);
    expect(resolvePinnedDrag(items, raw, null)).toBeNull();
    expect(resolvePinnedDrag(items, raw, customKey(items[0]))).toBeNull();
    expect(resolvePinnedDrag(items.filter((item) => item.node !== '4'), raw, key)).toBeNull();
    for (const value of ['', '1', 'null', '{bad', '{"node":4,"input":"text"}']) expect(resolvePinnedDrag(items, value, key)).toBeNull();
});

// —— 自动检测的文本输入并入固定列表 ——
// 文本输入原本只按探测顺序渲染，用户不能调顺序也不能挪进「生成设置」。
// 并入后它们和手动固定的配置项共用一个列表，但执行时仍走各自的通道。

function textInputs() {
    return [
        { node: '3', input: 'text', label: '正向提示词', default: 'a cat', role: 'positive' },
        { node: '4', input: 'text', label: '负向提示词', default: 'ugly', role: 'negative' },
        { node: '7', input: 'text', label: '风格描述', default: 'oil', role: 'unknown' },
    ];
}

test('文本输入并入固定列表，排在手动固定项之后', () => {
    const pinned = mergePinned([{ node: '2', input: 'steps', label: '步数' }], graph());
    const merged = mergeTextInputs(pinned, textInputs(), graph(), '3\u0000text', []);
    const labels = merged.map((item) => item.label);
    // 主提示词被排除，其余两个文本输入追加在后面，不打乱用户已有的布局。
    expect(labels).toEqual(['步数', '负向提示词', '风格描述']);
    expect(merged.filter((item) => item.text).map((item) => item.input)).toEqual(['text', 'text']);
});

test('用户排过的顺序优先于探测顺序', () => {
    // 「风格描述」被用户拖到了最前面，刷新后必须保持。
    const saved = [
        { node: '7', input: 'text', label: '风格描述', surface: 'card' as const },
        { node: '2', input: 'steps', label: '步数', surface: 'card' as const },
    ];
    const pinned = mergePinned(saved, graph());
    const merged = mergeTextInputs(pinned, textInputs(), graph(), '3\u0000text', saved);
    // 「风格描述」在 graph 里查不到（夹具只有节点 2/9），mergePinned 会丢掉它，
    // 所以顺序必须从 saved 恢复——这正是 graph 拉取失败时的真实情形。
    expect(merged.map((item) => item.label)).toEqual(['风格描述', '步数', '负向提示词']);
});

test('文本项的显示位置从已保存的绑定里恢复', () => {
    const saved = [{ node: '4', input: 'text', label: '负向提示词', surface: 'settings' as const }];
    const merged = mergeTextInputs(mergePinned(saved, graph()), textInputs(), graph(), '3\u0000text', saved);
    const negative = merged.find((item) => item.node === '4');
    expect(negative?.surface).toBe('settings');
    // 没保存过的默认放卡片上。
    expect(merged.find((item) => item.node === '7')?.surface).toBe('card');
});

test('文本输入不会被当成配置值提交，避免两条通道都写同一个输入', () => {
    const pinned = mergePinned([{ node: '2', input: 'steps', label: '步数' }], graph());
    const merged = mergeTextInputs(pinned, textInputs(), graph(), '3\u0000text', []);
    const values = buildCustomValues(merged, {});
    // 只有 steps 走 values；两个文本项走 texts，不能混进来。
    expect(values.map((item) => `${item.node}.${item.input}`)).toEqual(['2.steps']);
});

test('主文本也进入可排序列表，已固定的主文本仍被标为文本且只出现一次', () => {
    const withTexts = graph()!;
    withTexts.nodes.push({ id: '3', title: 'Prompt', classType: 'CLIPTextEncode', mode: 0, output: false, inputs: [
        { name: 'text', kind: 'text', value: 'a cat', options: [], integer: false },
    ] });
    const saved: Binding[] = [{ node: '3', input: 'text', label: '主文本', surface: 'settings' }];
    const merged = mergeTextInputs(mergePinned(saved, withTexts), textInputs(), withTexts, '', saved);
    expect(merged.filter((item) => item.node === '3')).toHaveLength(1);
    expect(merged[0].text).toBe(true);
    expect(merged[0].surface).toBe('settings');
    expect(buildCustomValues(merged, { ['3\u0000text']: 'stale' })).toEqual([]);
});

test('归档和生成使用同一快照：从重新拉取的原始 pinned 构建时文本也不能混进 values', async () => {
    const { buildFreeCardSnapshot } = await import('../src/lib/canvas/free-card-pinned');
    const withTexts = graph()!;
    for (const text of textInputs()) withTexts.nodes.push({
        id: text.node, title: text.label, classType: 'CLIPTextEncode', mode: 0, output: false,
        inputs: [{ name: text.input, kind: 'text', value: text.default, options: [], integer: false }],
    });
    // 和组件重新拉 graph 后一致：mergePinned 的结果还没有 text 标记。
    const rawPinned = mergePinned([
        { node: '2', input: 'steps', label: '步数' },
        ...textInputs().map(({ node, input, label }) => ({ node, input, label })),
    ], withTexts);
    const snapshot = buildFreeCardSnapshot({
        pinned: rawPinned, textInputs: textInputs(), prompt: 'a dog',
        textValues: { '4:text': '' },
        customValues: { ['2\u0000steps']: 8, ['3\u0000text']: 'old prompt', ['4\u0000text']: 'old negative', ['7\u0000text']: 'watercolor' },
    });
    expect(snapshot.texts).toEqual([
        { node: '3', input: 'text', value: 'a dog' },
        { node: '4', input: 'text', value: '' },
        { node: '7', input: 'text', value: 'watercolor' },
    ]);
    expect(snapshot.values).toEqual([
        { node: '2', input: 'steps', value: 8 },
    ]);
});

test('归档快照保留未修改文本的默认值以及只有手动配置没有文本的工作流', async () => {
    const { buildFreeCardSnapshot } = await import('../src/lib/canvas/free-card-pinned');
    const snapshot = buildFreeCardSnapshot({ pinned: [], textInputs: textInputs(), prompt: '', textValues: {}, customValues: {} });
    expect(snapshot.texts.map((item) => item.value)).toEqual(['', 'ugly', 'oil']);
    expect(buildFreeCardSnapshot({
        pinned: mergePinned([{ node: '2', input: 'steps', label: '步数' }], graph()),
        textInputs: [], prompt: '', textValues: {}, customValues: {},
    })).toEqual({ texts: [], values: [{ node: '2', input: 'steps', value: 20 }] });
});
