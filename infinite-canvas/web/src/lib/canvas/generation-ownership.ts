import type { CanvasNodeData } from "@/types/canvas";

export type CanvasGenerationRequest = {
    targetNodeId: string;
    // Provenance only: sharing a source does not share status or cancellation.
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

export function ownsGeneration(request: CanvasGenerationRequest, nodeId: string) {
    return request.targetNodeId === nodeId || request.runningNodeId === nodeId;
}

export function hasNodeGeneration(requests: Iterable<CanvasGenerationRequest>, nodeId: string) {
    return [...requests].some((request) => !request.controller.signal.aborted && ownsGeneration(request, nodeId));
}

export function generationRequestsToStop(requests: Iterable<CanvasGenerationRequest>, nodeId: string) {
    const all = [...requests];
    const controllers = new Set(all.filter((request) => ownsGeneration(request, nodeId)).map((request) => request.controller));
    // Config/free-card parent and child may share a controller. Clean up the
    // whole request, never independent siblings that merely share an origin.
    return all.filter((request) => controllers.has(request.controller));
}

export function planImageGeneration(source: CanvasNodeData | undefined, originNodeId: string, overwrite: boolean, createId: () => string) {
    const isImage = source?.type === "image";
    const reuseImageNode = isImage && (overwrite || !source.metadata?.content);
    const targetNodeId = reuseImageNode ? originNodeId : createId();
    const detached = isImage && !reuseImageNode;
    return { targetNodeId, reuseImageNode, detached, runningNodeId: detached ? targetNodeId : originNodeId };
}
