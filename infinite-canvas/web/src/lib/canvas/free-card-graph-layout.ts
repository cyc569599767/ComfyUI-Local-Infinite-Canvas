/**
 * 把简化节点图排成一张「像 ComfyUI 那样」的图。
 *
 * 为什么自动布局而不是用原始坐标：网关拿到的是转换后的 API 工作流（`{id: {class_type, inputs}}`），
 * 里面根本没有 `pos`/`size`——只有 UI 格式才有，而卡片两种格式都支持。为两种格式写两套布局，
 * 用户看到的样子会随工作流格式变化，反而更难理解。
 *
 * 自动布局只保证一件事：**数据流从左往右**。上游在左、下游在右，同列是互不相干的分支。
 * 这正是用户判断「这个参数影响什么」所需要的信息，原始坐标里的空白和对齐对判断没有帮助。
 */
import type { FreeWorkflowGraph, FreeWorkflowGraphNode } from "@/services/api/free-workflow";

export const GRAPH_NODE_WIDTH = 190;
/** 标题 + classType 占的高度。 */
export const GRAPH_HEADER_HEIGHT = 46;
/** 每个可固定输入的行走高度。 */
export const GRAPH_ROW_HEIGHT = 20;
/** 节点底部留白。 */
const GRAPH_NODE_PAD = 8;
export const GRAPH_COLUMN_GAP = 76;
const GRAPH_ROW_GAP = 18;

export type PlacedNode = {
    node: FreeWorkflowGraphNode;
    x: number;
    y: number;
    width: number;
    height: number;
    /** 第几列，从 0 开始。 */
    depth: number;
};

export type PlacedEdge = {
    id: string;
    from: string;
    to: string;
    input: string;
    /** SVG 用的路径。 */
    path: string;
    fromPoint: { x: number; y: number };
    toPoint: { x: number; y: number };
};

export type WorkflowGraphLayout = {
    nodes: PlacedNode[];
    edges: PlacedEdge[];
    width: number;
    height: number;
};

/** 节点高度随可固定输入的数量增长，没有输入时留一行放提示。 */
export function graphNodeHeight(node: FreeWorkflowGraphNode) {
    const rows = Math.max(1, node.inputs.length);
    return GRAPH_HEADER_HEIGHT + rows * GRAPH_ROW_HEIGHT + GRAPH_NODE_PAD;
}

/** 某个输入行的中心 y（相对节点顶部），连线要接到这里。 */
export function graphInputRowOffset(node: FreeWorkflowGraphNode, inputName: string) {
    const index = node.inputs.findIndex((item) => item.name === inputName);
    if (index < 0) return GRAPH_HEADER_HEIGHT / 2;
    return GRAPH_HEADER_HEIGHT + index * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
}

/**
 * 计算每个节点的列号（依赖深度）。
 *
 * 用「松弛到稳定」而不是拓扑排序：ComfyUI 正常不会出现环，但坏数据或用户手改的 JSON 里可能有。
 * 迭代次数以节点数为上限，环里的节点会停在某个深度而不是无限增长，图仍然画得出来。
 */
export function computeNodeDepths(nodes: FreeWorkflowGraphNode[], links: FreeWorkflowGraph["links"]) {
    const depth = new Map<string, number>(nodes.map((node) => [node.id, 0]));
    const limit = nodes.length;
    for (let round = 0; round < limit; round += 1) {
        let changed = false;
        for (const link of links || []) {
            if (!depth.has(link.from) || !depth.has(link.to)) continue;
            const next = (depth.get(link.from) ?? 0) + 1;
            if (next > (depth.get(link.to) ?? 0) && next < limit) {
                depth.set(link.to, next);
                changed = true;
            }
        }
        if (!changed) break;
    }
    return depth;
}

function edgePath(from: { x: number; y: number }, to: { x: number; y: number }) {
    // 三次贝塞尔：从上游右缘水平出发、到下游左缘水平进入，和 ComfyUI 的连线观感一致。
    const dx = Math.max(36, Math.abs(to.x - from.x) / 2);
    return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

export function layoutWorkflowGraph(
    graph: FreeWorkflowGraph | null,
    /** 列间距可调：列数多的时候收窄间距，比把整张图缩小更可读（字不会跟着变小）。 */
    options: { columnGap?: number; nodeWidth?: number } = {},
): WorkflowGraphLayout {
    const columnGap = options.columnGap ?? GRAPH_COLUMN_GAP;
    const nodeWidth = options.nodeWidth ?? GRAPH_NODE_WIDTH;
    const nodes = graph?.nodes || [];
    const links = graph?.links || [];
    if (!nodes.length) return { nodes: [], edges: [], width: 0, height: 0 };

    const depths = computeNodeDepths(nodes, links);

    // 按列分组，列内保持网关给的顺序（它已按节点 id 排过，结果是稳定的）。
    const columns = new Map<number, FreeWorkflowGraphNode[]>();
    for (const node of nodes) {
        const depth = depths.get(node.id) ?? 0;
        if (!columns.has(depth)) columns.set(depth, []);
        columns.get(depth)!.push(node);
    }

    const placed = new Map<string, PlacedNode>();
    const placedNodes: PlacedNode[] = [];
    let maxRight = 0;
    let maxBottom = 0;

    for (const depth of [...columns.keys()].sort((a, b) => a - b)) {
        const x = depth * (nodeWidth + columnGap);
        let y = 0;
        for (const node of columns.get(depth) || []) {
            const height = graphNodeHeight(node);
            const item: PlacedNode = { node, x, y, width: nodeWidth, height, depth };
            placed.set(node.id, item);
            placedNodes.push(item);
            maxRight = Math.max(maxRight, x + nodeWidth);
            maxBottom = Math.max(maxBottom, y + height);
            y += height + GRAPH_ROW_GAP;
        }
    }

    const edges: PlacedEdge[] = [];
    for (const [index, link] of links.entries()) {
        const from = placed.get(link.from);
        const to = placed.get(link.to);
        if (!from || !to) continue;
        // 出口统一取上游节点右侧的垂直中点：ComfyUI 里输出槽就在那附近，
        // 而且一个节点可能有多个下游，出口位置不随下游变化才不会看起来乱。
        const fromPoint = { x: from.x + from.width, y: from.y + from.height / 2 };
        // 入口接到目标输入所在那一行——同一对节点间有多条连线时，这是唯一能区分它们的办法。
        const toPoint = { x: to.x, y: to.y + graphInputRowOffset(to.node, link.input) };
        edges.push({
            id: `${link.from}->${link.to}:${link.input}:${index}`,
            from: link.from,
            to: link.to,
            input: link.input,
            path: edgePath(fromPoint, toPoint),
            fromPoint,
            toPoint,
        });
    }

    return { nodes: placedNodes, edges, width: maxRight, height: maxBottom };
}

/**
 * 算出把整张图塞进可视区需要的缩放比。
 *
 * 只缩不放（上限 1）：图小的时候放大只会让字变得很大、显得廉价；图大的时候必须缩，
 * 否则用户只看到最左边两列，会以为工作流就这么点东西——「一眼看懂数据流」是这个界面的全部意义。
 *
 * 设下限是为了避免极端情况下缩到不可读。超过下限就交给滚动，宁可看不全也不给一片糊字。
 */
export function fitGraphScale(
    layout: { width: number; height: number },
    viewport: { width: number; height: number },
    { padding = 16, minScale = 0.55 } = {},
): number {
    if (!layout.width || !viewport.width) return 1;
    const availableWidth = Math.max(0, viewport.width - padding * 2);
    const availableHeight = viewport.height > 0 ? Math.max(0, viewport.height - padding * 2) : Number.POSITIVE_INFINITY;
    // 两个方向都算，取更小的那个：只按宽度算的话，宽而扁的图会被无谓地缩小，
    // 字跟着变小，而垂直方向明明还有大片空白。
    const scale = Math.min(availableWidth / layout.width, availableHeight / layout.height);
    return Math.min(1, Math.max(minScale, scale));
}

/**
 * 按列数挑一组能塞进可视宽度的排版参数。
 *
 * 优先收窄列间距而不是缩小整张图：缩图会让节点里的字跟着变小，而这里要读的正是字。
 * 间距收到下限仍放不下，才退回到整体缩放（由调用方处理）。
 */
export function fitGraphColumns(
    columnCount: number,
    viewportWidth: number,
    { padding = 16, minColumnGap = 28, minNodeWidth = 150 } = {},
) {
    const available = Math.max(0, viewportWidth - padding * 2);
    if (!columnCount || !available) return { columnGap: GRAPH_COLUMN_GAP, nodeWidth: GRAPH_NODE_WIDTH };
    // 先试默认尺寸，放得下就不动。
    const needed = (width: number, gap: number) => columnCount * width + (columnCount - 1) * gap;
    if (needed(GRAPH_NODE_WIDTH, GRAPH_COLUMN_GAP) <= available) return { columnGap: GRAPH_COLUMN_GAP, nodeWidth: GRAPH_NODE_WIDTH };
    // 收窄间距，节点宽度保持——字的大小只取决于节点宽度。
    const gapForDefaultWidth = columnCount > 1 ? (available - columnCount * GRAPH_NODE_WIDTH) / (columnCount - 1) : GRAPH_COLUMN_GAP;
    if (gapForDefaultWidth >= minColumnGap) return { columnGap: Math.floor(gapForDefaultWidth), nodeWidth: GRAPH_NODE_WIDTH };
    // 间距到底了还不够，才压节点宽度，但停在可读下限。
    const widthForMinGap = columnCount > 0 ? (available - (columnCount - 1) * minColumnGap) / columnCount : GRAPH_NODE_WIDTH;
    return { columnGap: minColumnGap, nodeWidth: Math.max(minNodeWidth, Math.floor(widthForMinGap)) };
}
