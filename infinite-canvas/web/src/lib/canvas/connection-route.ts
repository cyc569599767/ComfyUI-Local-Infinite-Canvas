import type { CanvasNodeData } from "@/types/canvas";

export type ConnectionBounds = { left: number; top: number; right: number; bottom: number };
export type ConnectionRoute = { d: string; bounds: ConnectionBounds };

/** Original direct Bezier, drawn below cards. Never detour or change endpoints. */
export function buildConnectionRoute(from: CanvasNodeData, to: CanvasNodeData): ConnectionRoute {
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
    const control1X = startX + curvature;
    const control2X = endX - curvature;
    return {
        d: `M ${startX} ${startY} C ${control1X} ${startY}, ${control2X} ${endY}, ${endX} ${endY}`,
        // The control-point hull conservatively encloses forward/backward curves.
        bounds: {
            left: Math.min(startX, control1X, control2X, endX),
            top: Math.min(startY, endY),
            right: Math.max(startX, control1X, control2X, endX),
            bottom: Math.max(startY, endY),
        },
    };
}

export function connectionIntersectsView(bounds: ConnectionBounds, view: ConnectionBounds, scale = 1) {
    // Inclusive boundaries keep horizontal/vertical lines with zero-area bounds.
    // Stroke and hit area stay screen-sized, so culling padding must do so too.
    const pad = 16 / Math.max(0.05, scale);
    return bounds.right + pad >= view.left && bounds.left - pad <= view.right && bounds.bottom + pad >= view.top && bounds.top - pad <= view.bottom;
}

/** A viewport-sized SVG with world-coordinate viewBox: no fixed 0..10000 surface.
 * Moving its origin and viewBox together preserves node/port alignment, even for
 * negative coordinates and distant nodes, without a huge GPU-promoted SVG layer.
 */
export function connectionLayerGeometry(view: ConnectionBounds) {
    const width = Math.max(1, view.right - view.left);
    const height = Math.max(1, view.bottom - view.top);
    return { left: view.left, top: view.top, width, height, viewBox: `${view.left} ${view.top} ${width} ${height}` };
}
