import { useId, type MouseEvent as ReactMouseEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";
import type { ConnectionRoute } from "@/lib/canvas/connection-route";

export function ConnectionPath({
    connection,
    route,
    active,
    onSelect,
    onContextMenu,
}: {
    connection: CanvasConnection;
    route: ConnectionRoute;
    active: boolean;
    onSelect: () => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const arrowId = useId();
    const pathD = route.d;
    const isCreationLineage = route.creation && connection.role === "lineage";
    const stroke = active ? theme.node.activeStroke : route.creation && !isCreationLineage ? theme.node.text : theme.node.muted;
    const strokeOpacity = active ? 1 : isCreationLineage ? 0.55 : 0.9;

    return (
        <g data-connection-from={connection.fromNodeId} data-connection-to={connection.toNodeId}>
            {route.creation ? <>
                <title>{isCreationLineage ? "创作流程：按阶段与产物顺序流转，仅展示流程，不作为生成参考。" : "真实参考：源节点向箭头指向的目标节点提供生成参考。"}</title>
                <defs>
                    <marker id={arrowId} viewBox="0 0 12 12" refX="20" refY="6" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto">
                        <path d="M 1 1 L 10 6 L 1 11" fill="none" stroke={stroke} strokeWidth="1.5" strokeOpacity={strokeOpacity} strokeLinecap="round" strokeLinejoin="round" />
                    </marker>
                </defs>
            </> : null}
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                vectorEffect="non-scaling-stroke"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect();
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event);
                }}
            />
            <path
                data-connection-visible={connection.id}
                d={pathD}
                stroke={stroke}
                strokeWidth={active ? 3 : isCreationLineage ? 1.5 : 2}
                strokeOpacity={strokeOpacity}
                strokeDasharray={isCreationLineage ? "6 6" : undefined}
                markerEnd={route.creation ? `url(#${arrowId})` : undefined}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
                fill="none"
                style={{ filter: active ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none" }}
            />
        </g>
    );
}

export function ActiveConnectionPath({ node, handle, mouseWorld, target }: { node?: CanvasNodeData; handle: ConnectionHandle; mouseWorld: Position; target?: CanvasNodeData }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!node) return null;

    const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
    const startY = handle.handleType === "source" ? node.position.y + node.height / 2 : mouseWorld.y;
    const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
    const endY = handle.handleType === "source" ? mouseWorld.y : node.position.y + node.height / 2;
    const snappedStartX = handle.handleType === "target" && target ? target.position.x + target.width : startX;
    const snappedStartY = handle.handleType === "target" && target ? target.position.y + target.height / 2 : startY;
    const snappedEndX = handle.handleType === "source" && target ? target.position.x : endX;
    const snappedEndY = handle.handleType === "source" && target ? target.position.y + target.height / 2 : endY;
    const distance = Math.abs(snappedEndX - snappedStartX);
    const pathD = `M ${snappedStartX} ${snappedStartY} C ${snappedStartX + distance * 0.5} ${snappedStartY}, ${snappedEndX - distance * 0.5} ${snappedEndY}, ${snappedEndX} ${snappedEndY}`;

    return <path d={pathD} stroke={theme.node.activeStroke} strokeWidth="2" vectorEffect="non-scaling-stroke" fill="none" strokeDasharray="5,5" />;
}
