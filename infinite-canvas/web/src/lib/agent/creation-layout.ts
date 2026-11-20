import type { CanvasConnection, CanvasNodeData, Position } from "@/types/canvas";
import { creationOutputName } from "./creation-output-names";
import { CREATION_STAGES, expectedStageIds, type CreationStageId } from "./creation-pipeline";

export const CREATION_LAYOUT = { columns: 4, columnGap: 120, rowGap: 120, stageGap: 160, heading: 64, startGap: 180, obstacleGap: 120 } as const;
export type CreationLayoutSection = { stage: CreationStageId; label: string; index: number; x: number; y: number; width: number; height: number; nodes: CanvasNodeData[] };
const dimension = (value: number, fallback: number) => Number.isFinite(value) && value > 0 ? value : fallback;
export function creationProjectFor(node?: CanvasNodeData): string | undefined {
    return node?.metadata?.creationOutput?.projectNodeId || (node?.metadata?.workbenchKind === "agent-creation" ? node.id : undefined);
}

/** 阶段间纵向、阶段内按计划ID横向；旧产物无计划时保持创建顺序，而非按随机ID排序。 */
export function orderedCreationGroups(nodes: CanvasNodeData[], projectNodeId: string) {
    const host = nodes.find((n) => n.id === projectNodeId);
    const plan = host?.metadata?.creationPipeline?.plan;
    return CREATION_STAGES.map((stage, index) => {
        const own = nodes.filter((n) => n.metadata?.creationOutput?.projectNodeId === projectNodeId && n.metadata.creationOutput.stage === stage.id);
        const order = expectedStageIds(stage.id, plan) || [];
        const rank = new Map(order.map((id, i) => [id, i]));
        own.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
        return { ...stage, index, nodes: own };
    });
}

/** 只移动本工作台产物。整体避开无关节点，不改变大小、内容、引用边或生成配置。 */
export function layoutCreationProject(nodes: CanvasNodeData[], connections: CanvasConnection[], projectNodeId: string) {
    const host = nodes.find((n) => n.id === projectNodeId && n.metadata?.workbenchKind === "agent-creation");
    if (!host) return { nodes, connections };
    const groups = orderedCreationGroups(nodes, projectNodeId);
    const products = groups.flatMap((g) => g.nodes);
    const editor = nodes.find((n) => n.id === `${projectNodeId}-editor` && n.metadata?.workbenchKind === "video-editor" && (!n.metadata.creationOutput || n.metadata.creationOutput.projectNodeId === projectNodeId));
    const movable = new Set([...products.map((n) => n.id), ...(editor ? [editor.id] : [])]);
    if (!movable.size) return { nodes, connections };
    const columnWidth = Math.max(420, ...products.map((n) => dimension(n.width, 340)), editor ? dimension(editor.width, 360) : 0);
    const columns = Math.min(CREATION_LAYOUT.columns, Math.max(1, ...groups.map((g) => g.nodes.length)));
    const totalWidth = columns * columnWidth + (columns - 1) * CREATION_LAYOUT.columnGap;
    const positions = new Map<string, Position>();
    let y = host.position.y + dimension(host.height, 220) + CREATION_LAYOUT.startGap;
    for (const group of groups) {
        if (!group.nodes.length) continue;
        y += CREATION_LAYOUT.heading;
        for (let offset = 0; offset < group.nodes.length; offset += CREATION_LAYOUT.columns) {
            const row = group.nodes.slice(offset, offset + CREATION_LAYOUT.columns);
            for (let col = 0; col < row.length; col++) positions.set(row[col].id, { x: col * (columnWidth + CREATION_LAYOUT.columnGap), y });
            y += Math.max(...row.map((n) => dimension(n.height, 240))) + CREATION_LAYOUT.rowGap;
        }
        y += CREATION_LAYOUT.stageGap - CREATION_LAYOUT.rowGap;
    }
    if (editor) {
        positions.set(editor.id, { x: 0, y: y + CREATION_LAYOUT.heading });
        y += CREATION_LAYOUT.heading + editor.height + CREATION_LAYOUT.rowGap;
    }
    const top = host.position.y + host.height + CREATION_LAYOUT.startGap;
    let originX = host.position.x;
    const obstacles = nodes.filter((n) => n.id !== host.id && !movable.has(n.id));
    // 向右移整个产物区，直到不覆盖无关卡片。有限迭代，不能推动别人的节点。
    for (let i = 0; i <= obstacles.length; i++) {
        const hits = obstacles.filter((n) => n.position.x < originX + totalWidth + CREATION_LAYOUT.obstacleGap && n.position.x + n.width > originX - CREATION_LAYOUT.obstacleGap && n.position.y < y + CREATION_LAYOUT.obstacleGap && n.position.y + n.height > top - CREATION_LAYOUT.obstacleGap);
        if (!hits.length) break;
        originX = Math.max(...hits.map((n) => n.position.x + n.width)) + CREATION_LAYOUT.obstacleGap * 2;
    }
    let changed = false;
    const nextNodes = nodes.map((n) => {
        const p = positions.get(n.id);
        if (!p) return n;
        const position = { x: p.x + originX, y: p.y };
        const title = creationOutputName(n, nodes) || n.title;
        if (n.position.x === position.x && n.position.y === position.y && n.title === title) return n;
        changed = true;
        return { ...n, position, title };
    });
    // 流程边是展示关系，不参与生成输入。只重建本功能管理的流程边。
    const retained = connections.filter((c) => c.creationProjectId !== projectNodeId);
    const chain = [host.id, ...products.map((n) => n.id), ...(editor ? [editor.id] : [])];
    const flows: CanvasConnection[] = [];
    for (let i = 1; i < chain.length; i++) {
        const fromNodeId = chain[i - 1], toNodeId = chain[i];
        // 已有用户/素材连接不改语义、不调整顺序，也不重复叠线。
        if (retained.some((c) => c.fromNodeId === fromNodeId && c.toNodeId === toNodeId)) continue;
        flows.push({ id: `creation-flow:${projectNodeId}:${fromNodeId}:${toNodeId}`, fromNodeId, toNodeId, role: "lineage", creationProjectId: projectNodeId });
    }
    const existing = connections.filter((c) => c.creationProjectId === projectNodeId);
    const sameFlows = existing.length === flows.length && existing.every((c, i) => c.id === flows[i].id && c.role === "lineage");
    return { nodes: changed ? nextNodes : nodes, connections: sameFlows ? connections : [...retained, ...flows] };
}

/** 实际位置驱动分区标题，手动拖动后也不把标题留在旧坐标。 */
export function creationLayoutSections(nodes: CanvasNodeData[]): CreationLayoutSection[] {
    return nodes.filter((n) => n.metadata?.workbenchKind === "agent-creation").flatMap((host) => orderedCreationGroups(nodes, host.id).filter((g) => g.nodes.length).map((g) => {
        const x = Math.min(...g.nodes.map((n) => n.position.x));
        const y = Math.min(...g.nodes.map((n) => n.position.y)) - CREATION_LAYOUT.heading;
        return { stage: g.id, label: g.label, index: g.index, x, y, width: Math.max(...g.nodes.map((n) => n.position.x + n.width)) - x, height: Math.max(...g.nodes.map((n) => n.position.y + n.height)) - y, nodes: g.nodes };
    }));
}
