import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { layoutCreationProject } from "@/lib/agent/creation-layout";
import { applyCreationRevision, type CreationRevisionAction } from "@/lib/agent/creation-revision";
import { getNodeSpec, isRegisteredNodeType } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type ViewportTransform } from "@/types/canvas";

export type CanvasAgentOp =
    | { type: "revise_creation"; projectNodeId: string; revision: CreationRevisionAction }
    | { type: "layout_creation"; projectNodeId: string }
    | { type: "add_node"; id?: string; nodeType?: CanvasNodeTypeId; title?: string; position?: { x: number; y: number }; x?: number; y?: number; width?: number; height?: number; metadata?: CanvasNodeMetadata }
    | { type: "update_node"; id: string; patch?: Partial<CanvasNodeData>; metadata?: CanvasNodeMetadata }
    | { type: "delete_node"; id?: string; ids?: string[]; nodeType?: CanvasNodeTypeId }
    | { type: "delete_connections"; id?: string; ids?: string[]; all?: boolean }
    | { type: "connect_nodes"; id?: string; fromNodeId: string; toNodeId: string; role?: "lineage" }
    | { type: "set_viewport"; viewport: ViewportTransform }
    | { type: "select_nodes"; ids: string[] }
    | { type: "run_generation"; nodeId: string; mode?: "text" | "image" | "video" | "audio"; prompt?: string };

export type CanvasAgentSnapshot = {
    projectId: string;
    title: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: string[];
    viewport: ViewportTransform;
};

/**
 * 嵌套配置要合并，不能整体替换。
 *
 * Agent 更新工作台时常只回传自己知道的那几个字段（比如 status 和 progress），
 * 浅合并会把 idea、conversationId、createVideos 一起抹掉，项目就跟丢了会话。
 */
function mergeNodeMetadata(base: CanvasNodeMetadata | undefined, ...patches: Array<CanvasNodeMetadata | undefined>): CanvasNodeMetadata {
    let next: CanvasNodeMetadata = { ...base };
    for (const patch of patches) {
        if (!patch) continue;
        const agentCreation = patch.agentCreation ? { ...next.agentCreation, ...patch.agentCreation } : next.agentCreation;
        next = { ...next, ...patch, ...(agentCreation ? { agentCreation } : {}) };
    }
    return next;
}

export function summarizeCanvasAgentOps(ops?: CanvasAgentOp[]) {
    const counts = (Array.isArray(ops) ? ops : []).reduce<Record<string, number>>((acc, op) => {
        if (!op?.type) return acc;
        acc[op.type] = (acc[op.type] || 0) + 1;
        return acc;
    }, {});
    return Object.entries(counts)
        .map(([type, count]) => `${opLabel(type)} ${count}`)
        .join("，");
}

export function applyCanvasAgentOps(snapshot: CanvasAgentSnapshot, ops?: CanvasAgentOp[]) {
    let nodes = snapshot.nodes;
    let connections = snapshot.connections;
    let selectedNodeIds = snapshot.selectedNodeIds;
    let viewport = snapshot.viewport;

    (Array.isArray(ops) ? ops : []).forEach((op, index) => {
        if (!op?.type) return;
        if (op.type === "revise_creation") {
            const revised = applyCreationRevision({ ...snapshot, nodes, connections, selectedNodeIds, viewport }, op.projectNodeId, op.revision);
            nodes = revised.nodes; connections = revised.connections;
        }
        if (op.type === "add_node") {
            const nodeType = op.nodeType && isRegisteredNodeType(op.nodeType) ? op.nodeType : CanvasNodeType.Text;
            const spec = getNodeSpec(nodeType);
            const node: CanvasNodeData = {
                id: op.id || `${nodeType}-${Date.now()}-${index}`,
                type: nodeType,
                title: op.title || spec.title,
                position: op.position || { x: op.x ?? index * 36, y: op.y ?? index * 36 },
                width: op.width || spec.width,
                height: op.height || spec.height,
                metadata: { ...spec.metadata, ...op.metadata },
            };
            nodes = [...nodes, node];
            selectedNodeIds = [node.id];
        }
        if (op.type === "update_node") {
            if (!op.id) return;
            nodes = nodes.map((node) => (node.id === op.id ? { ...node, ...op.patch, metadata: mergeNodeMetadata(node.metadata, op.patch?.metadata, op.metadata) } : node));
        }
        if (op.type === "delete_node") {
            const ids = new Set(op.ids || (op.id ? [op.id] : op.nodeType ? nodes.filter((node) => node.type === op.nodeType).map((node) => node.id) : []));
            nodes = nodes.filter((node) => !ids.has(node.id));
            connections = connections.filter((conn) => !ids.has(conn.fromNodeId) && !ids.has(conn.toNodeId));
            selectedNodeIds = selectedNodeIds.filter((id) => !ids.has(id));
        }
        if (op.type === "delete_connections") {
            const ids = new Set(op.ids || (op.id ? [op.id] : []));
            connections = op.all ? [] : connections.filter((conn) => !ids.has(conn.id));
        }
        if (op.type === "connect_nodes") {
            if (!op.fromNodeId || !op.toNodeId) return;
            const exists = connections.some((conn) => conn.fromNodeId === op.fromNodeId && conn.toNodeId === op.toNodeId);
            const hasNodes = nodes.some((node) => node.id === op.fromNodeId) && nodes.some((node) => node.id === op.toNodeId);
            if (exists && hasNodes && op.role !== "lineage" && connections.some((c) => c.fromNodeId === op.fromNodeId && c.toNodeId === op.toNodeId && c.role === "lineage")) {
                // 展示边升级为真正参考时按本次提交顺序追加，保持Picture编号顺序。
                connections = [...connections.filter((c) => c.fromNodeId !== op.fromNodeId || c.toNodeId !== op.toNodeId), { id: op.id || nanoid(), fromNodeId: op.fromNodeId, toNodeId: op.toNodeId }];
            }
            if (!exists && hasNodes) connections = [...connections, { id: op.id || nanoid(), fromNodeId: op.fromNodeId, toNodeId: op.toNodeId, ...(op.role === "lineage" ? { role: "lineage" as const } : {}) }];
        }
        if (op.type === "set_viewport" && op.viewport) viewport = op.viewport;
        if (op.type === "select_nodes") selectedNodeIds = (op.ids || []).filter((id) => nodes.some((node) => node.id === id));
    });

    // 内部布局操作不暴露给普通模型工具。对整批最终节点排布，跨批位置不会从原点重置。
    for (const op of ops || []) {
        if (op.type !== "layout_creation") continue;
        const layout = layoutCreationProject(nodes, connections, op.projectNodeId);
        nodes = layout.nodes; connections = layout.connections;
    }
    return { ...snapshot, nodes, connections, selectedNodeIds, viewport };
}

function opLabel(type: string) {
    return i18n.t(`canvas.agentOps.${type}`, { defaultValue: type });
}
