import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

type ResourceKind = Exclude<NodeGenerationInput["type"], "group">;

/** New generations are siblings of the original result, not inputs derived from it.
 * Consume the same resolved input order as generation (including group members).
 * Legacy image cards may only have stored reference URLs: recover a live node
 * when there is an exact match, never manufacture a link to the previous result.
 */
export function buildGeneratedNodeConnections(
    sourceNodeId: string,
    targetNodeId: string,
    inputs: NodeGenerationInput[],
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    createId: () => string,
    options: { referenceUrls?: string[]; kinds?: ResourceKind[] } = {},
): CanvasConnection[] {
    if (sourceNodeId === targetNodeId) return [];
    const available = new Set(nodes.map(node => node.id));
    const seen = new Set(connections.filter(edge => edge.toNodeId === targetNodeId && edge.role !== "lineage").map(edge => edge.fromNodeId));
    const result: CanvasConnection[] = [];
    const add = (id: string) => {
        if (!available.has(id) || id === sourceNodeId || id === targetNodeId || seen.has(id)) return;
        seen.add(id);
        result.push({ id: createId(), fromNodeId: id, toNodeId: targetNodeId });
    };
    // Match the stored-before-live image-reference order used by regeneration.
    for (const url of options.referenceUrls || []) {
        if (!url) continue;
        const candidate = nodes.find(node => node.id !== sourceNodeId && node.id !== targetNodeId && node.type === "image" &&
            [node.metadata?.storageKey, node.metadata?.content, ...(node.metadata?.images || []).flatMap(image => [image.storageKey, image.content])].includes(url));
        if (candidate && (!options.kinds || options.kinds.includes("image"))) add(candidate.id);
    }
    for (const input of inputs.flatMap(input => input.type === "group" ? input.children : [input])) {
        if (!options.kinds || options.kinds.includes(input.type)) add(input.nodeId);
    }
    return result;
}
