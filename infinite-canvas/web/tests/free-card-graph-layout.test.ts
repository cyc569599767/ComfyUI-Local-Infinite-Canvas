import { expect, test } from 'bun:test';

// 节点图布局：数据流从左往右。
// 这里锁的是「谁在谁左边」和「连线接到哪一行」——错了整张图就读不懂。

const { GRAPH_COLUMN_GAP, GRAPH_NODE_WIDTH, computeNodeDepths, fitGraphColumns, fitGraphScale, graphInputRowOffset, graphNodeHeight, layoutWorkflowGraph } = await import(
    '../src/lib/canvas/free-card-graph-layout'
);

type Graph = Parameters<typeof layoutWorkflowGraph>[0];

function node(id: string, inputs: string[], output = false) {
    return {
        id,
        title: `n${id}`,
        classType: 'Test',
        mode: 0,
        output,
        inputs: inputs.map((name) => ({ name, kind: 'number' as const, value: 1, options: [], integer: true })),
    };
}

function graph(nodes: ReturnType<typeof node>[], links: Array<{ from: string; to: string; input: string }>): Graph {
    return { nodes, links };
}

test('依赖深度：上游在 0 列，下游逐级右移', () => {
    const depths = computeNodeDepths(
        [node('9', []), node('2', ['model']), node('6', [])],
        [
            { from: '9', to: '2', input: 'model' },
            { from: '2', to: '6', input: 'images' },
        ],
    );
    expect(depths.get('9')).toBe(0);
    expect(depths.get('2')).toBe(1);
    expect(depths.get('6')).toBe(2);
});

test('孤立节点落在第 0 列，不会被挤到右边', () => {
    const depths = computeNodeDepths([node('1', []), node('2', [])], []);
    expect(depths.get('1')).toBe(0);
    expect(depths.get('2')).toBe(0);
});

test('取最深的那条路径：一个节点被多条上游指向时按最长链算', () => {
    // 1 -> 3 和 1 -> 2 -> 3，3 应在第 2 列而不是第 1 列，
    // 否则 2 会和 3 撞在同一列，连线看起来是往回走的。
    const depths = computeNodeDepths(
        [node('1', []), node('2', []), node('3', [])],
        [
            { from: '1', to: '3', input: 'a' },
            { from: '1', to: '2', input: 'b' },
            { from: '2', to: '3', input: 'c' },
        ],
    );
    expect(depths.get('3')).toBe(2);
});

test('环形数据不会死循环，深度有上限', () => {
    const depths = computeNodeDepths(
        [node('1', []), node('2', [])],
        [
            { from: '1', to: '2', input: 'a' },
            { from: '2', to: '1', input: 'b' },
        ],
    );
    // 不要求具体值，只要求算得出来且不无限增长。
    expect(depths.get('1')!).toBeLessThan(2);
    expect(depths.get('2')!).toBeLessThan(2);
});

test('同一列的节点横向对齐，纵向不重叠', () => {
    const layout = layoutWorkflowGraph(
        graph([node('1', ['a', 'b']), node('2', ['c'])], []),
    );
    const [a, b] = layout.nodes;
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(0);
    expect(b.y).toBeGreaterThanOrEqual(a.height);
});

test('列间距恒定，节点宽度一致', () => {
    const layout = layoutWorkflowGraph(
        graph([node('1', []), node('2', ['x'])], [{ from: '1', to: '2', input: 'x' }]),
    );
    const first = layout.nodes.find((item) => item.node.id === '1')!;
    const second = layout.nodes.find((item) => item.node.id === '2')!;
    expect(second.x - first.x).toBe(GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP);
    expect(first.width).toBe(GRAPH_NODE_WIDTH);
});

test('节点高度随可固定输入数量增长', () => {
    const small = graphNodeHeight(node('1', ['a']));
    const big = graphNodeHeight(node('1', ['a', 'b', 'c']));
    expect(big).toBeGreaterThan(small);
});

test('连线接到目标输入所在的那一行，同一对节点的两条线不重合', () => {
    const layout = layoutWorkflowGraph(
        graph(
            [node('1', []), node('2', ['model', 'vae'])],
            [
                { from: '1', to: '2', input: 'model' },
                { from: '1', to: '2', input: 'vae' },
            ],
        ),
    );
    expect(layout.edges).toHaveLength(2);
    const [first, second] = layout.edges;
    expect(first.toPoint.y).not.toBe(second.toPoint.y);
    // 出口相同（同一上游），入口不同（不同输入行）
    expect(first.fromPoint.y).toBe(second.fromPoint.y);
    expect(first.fromPoint.x).toBe(second.fromPoint.x);
});

test('指向不存在节点的连线被丢弃，不会画出悬空的线', () => {
    const layout = layoutWorkflowGraph(
        graph([node('1', [])], [{ from: '1', to: 'missing', input: 'x' }]),
    );
    expect(layout.edges).toEqual([]);
});

test('输入名在图里找不到时，入口回落到标题栏而不是崩溃', () => {
    const n = node('2', ['model']);
    expect(graphInputRowOffset(n, 'nonexistent')).toBeGreaterThan(0);
});

test('空图返回空布局，不产生 0 尺寸的画布', () => {
    const layout = layoutWorkflowGraph(null);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBe(0);
});

test('图比可视区宽时整体缩小，保证一屏能看全', () => {
    // 5 列约 1300px，可视区 800px → 必须缩，否则只看到最左两列
    const scale = fitGraphScale({ width: 1300, height: 300 }, { width: 800, height: 500 });
    expect(scale).toBeLessThan(1);
    expect(scale * 1300).toBeLessThanOrEqual(800);
});

test('图比可视区窄时不放大', () => {
    const scale = fitGraphScale({ width: 300, height: 200 }, { width: 900, height: 500 });
    expect(scale).toBe(1);
});

test('极端宽图有缩放下限，不会缩成一片糊字', () => {
    const scale = fitGraphScale({ width: 10000, height: 300 }, { width: 800, height: 500 }, { minScale: 0.55 });
    expect(scale).toBe(0.55);
});

test('可视区还没测量出来时按 1 处理，不闪一帧缩小', () => {
    expect(fitGraphScale({ width: 1300, height: 300 }, { width: 0, height: 0 })).toBe(1);
});

test('轻微超宽时只收窄间距，节点宽度不动（字不变小）', () => {
    // 3 列默认 3*190+2*76 = 722px；给 680px 视口，只需把间距压到约 47px
    const g = fitGraphColumns(3, 680);
    expect(g.nodeWidth).toBe(GRAPH_NODE_WIDTH);
    expect(g.columnGap).toBeLessThan(GRAPH_COLUMN_GAP);
    expect(3 * g.nodeWidth + 2 * g.columnGap).toBeLessThanOrEqual(680);
});

test('列太多时压低节点宽度，但停在可读下限', () => {
    // 5 列即使零间距也要 5*190 = 950px，600px 视口必然要压宽度
    const g = fitGraphColumns(5, 600);
    expect(g.nodeWidth).toBeLessThan(GRAPH_NODE_WIDTH);
    // 下限优先于「塞得下」：宁可超出后靠整体缩放兜底，也不给一片读不了的糊字。
    expect(g.nodeWidth).toBeGreaterThanOrEqual(150);
});

test('压到可读下限仍超宽时，交给整体缩放兜底', () => {
    // 这是两段式：先尽量收，收不动就用 scale 让整张图缩进视口。
    const g = fitGraphColumns(5, 600);
    const totalWidth = 5 * g.nodeWidth + 4 * g.columnGap;
    const scale = fitGraphScale({ width: totalWidth, height: 300 }, { width: 600, height: 400 });
    expect(scale).toBeLessThan(1);
    expect(totalWidth * scale).toBeLessThanOrEqual(600);
});

test('列少时不动间距', () => {
    const g = fitGraphColumns(2, 1200);
    expect(g.columnGap).toBe(GRAPH_COLUMN_GAP);
    expect(g.nodeWidth).toBe(GRAPH_NODE_WIDTH);
});

test('间距收到下限仍放不下，才压节点宽度但不低于可读下限', () => {
    const g = fitGraphColumns(12, 500);
    expect(g.columnGap).toBe(28);
    expect(g.nodeWidth).toBeGreaterThanOrEqual(150);
});

test('单列不产生负数间距', () => {
    const g = fitGraphColumns(1, 300);
    expect(g.columnGap).toBeGreaterThan(0);
});

test('可视区没测量时用默认尺寸，不闪', () => {
    const g = fitGraphColumns(5, 0);
    expect(g.columnGap).toBe(GRAPH_COLUMN_GAP);
    expect(g.nodeWidth).toBe(GRAPH_NODE_WIDTH);
});

// ── 视图变换（滚轮缩放 / 中键平移） ──
// 这里错了的表现很隐蔽：图能显示，但缩放时光标下的位置慢慢漂移，用起来「说不清哪里不对」。

const { MAX_VIEW_SCALE, MIN_VIEW_SCALE, centerGraphView, clampViewScale, zoomViewAt } = await import(
    '../src/lib/canvas/free-card-graph-layout'
);

/** 世界坐标 → 屏幕坐标。和 CSS 的 translate(x,y) scale(s) 一致。 */
function toScreen(view: { scale: number; x: number; y: number }, world: { x: number; y: number }) {
    return { x: world.x * view.scale + view.x, y: world.y * view.scale + view.y };
}

test('缩放锚点不动：光标下的内容保持在光标位置', () => {
    const view = { scale: 1, x: 0, y: 0 };
    const cursor = { x: 300, y: 200 };
    const world = { x: 300, y: 200 };
    const next = zoomViewAt(view, cursor, 2);
    const screen = toScreen(next, world);
    expect(screen.x).toBeCloseTo(cursor.x, 6);
    expect(screen.y).toBeCloseTo(cursor.y, 6);
});

test('已有平移/缩放时锚点仍然不动', () => {
    const view = { scale: 1.7, x: -140, y: 60 };
    const cursor = { x: 250, y: 90 };
    // 反推光标下的世界坐标，缩放后必须回到同一屏幕点。
    const world = { x: (cursor.x - view.x) / view.scale, y: (cursor.y - view.y) / view.scale };
    const next = zoomViewAt(view, cursor, 2.4);
    const screen = toScreen(next, world);
    expect(screen.x).toBeCloseTo(cursor.x, 6);
    expect(screen.y).toBeCloseTo(cursor.y, 6);
});

test('缩放被夹在上下限内', () => {
    expect(clampViewScale(99)).toBe(MAX_VIEW_SCALE);
    expect(clampViewScale(0.001)).toBe(MIN_VIEW_SCALE);
    expect(clampViewScale(Number.NaN)).toBe(1);
    // 触到上限后继续放大不再移动内容，避免越滚越偏。
    const view = { scale: MAX_VIEW_SCALE, x: 10, y: 10 };
    expect(zoomViewAt(view, { x: 100, y: 100 }, 99)).toEqual(view);
});

test('内容比视口小时的居中偏移是正的，大于视口时不推出左上角', () => {
    const small = centerGraphView({ width: 200, height: 100 }, { width: 600, height: 400 }, 1);
    expect(small.x).toBe(200);
    expect(small.y).toBe(150);
    const large = centerGraphView({ width: 2000, height: 2000 }, { width: 600, height: 400 }, 1);
    expect(large.x).toBe(0);
    expect(large.y).toBe(0);
});
