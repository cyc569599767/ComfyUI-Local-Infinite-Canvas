import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeDefinition } from "@/types/canvas-plugin";

/** 3D output lives outside metadata.content; use the actual resource field. */
export function hasNodeInteractionContent(node: CanvasNodeData) {
    if (node.type === "model3d") return Boolean(node.metadata?.model3d?.url);
    if (node.type === "stage3d") return Boolean(node.metadata?.stage3d?.scene?.url);
    return Boolean(node.metadata?.content);
}

export function nodeInteractionState(node: CanvasNodeData, definition?: Pick<CanvasNodeDefinition, "interactionToggle" | "forceInteractive">) {
    const toggleEnabled = Boolean(definition?.interactionToggle && hasNodeInteractionContent(node) && !definition.forceInteractive?.(node));
    return { toggleEnabled, contentInteractive: !toggleEnabled || Boolean(node.metadata?.interactive) };
}
