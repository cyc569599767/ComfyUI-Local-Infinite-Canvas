import type { CanvasConnection, CanvasNodeData, Position } from "@/types/canvas";
import { creationProjectFor } from "@/lib/agent/creation-layout";

export type ConnectionBounds = { left: number; top: number; right: number; bottom: number };
export type ConnectionRoute = { d: string; bounds: ConnectionBounds; creation?: boolean; points?: Position[] };

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

/** 只给同一创作项目的边走通道；普通画布保持原贝塞尔路径。 */
export function buildCreationConnectionRoute(from: CanvasNodeData, to: CanvasNodeData, connection: CanvasConnection, nodes: CanvasNodeData[]): ConnectionRoute {
    const project = connection.creationProjectId || creationProjectFor(from);
    if (!project || (creationProjectFor(to) !== project && to.id !== `${project}-editor`)) return buildConnectionRoute(from, to);
    const own = nodes.filter((n) => creationProjectFor(n) === project || n.id === `${project}-editor`);
    const start = { x: from.position.x + from.width, y: from.position.y + from.height / 2 };
    const end = { x: to.position.x, y: to.position.y + to.height / 2 };
    const padding = 24;
    const finish = (points: Position[]): ConnectionRoute => ({
        d: points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" "), points, creation: true,
        bounds: { left: Math.min(...points.map((p) => p.x)), right: Math.max(...points.map((p) => p.x)), top: Math.min(...points.map((p) => p.y)), bottom: Math.max(...points.map((p) => p.y)) },
    });
    const horizontalClear = (a: Position, b: Position) => !nodes.some((n) => n.id !== from.id && n.id !== to.id && n.position.x < Math.max(a.x, b.x) && n.position.x + n.width > Math.min(a.x, b.x) && a.y > n.position.y - padding && a.y < n.position.y + n.height + padding);
    if (Math.abs(start.y - end.y) < 1 && start.x < end.x && horizontalClear(start, end)) return finish([start, end]);
    // 同一行的相邻卡片高度可能不同，仍只在两卡间隙内转折，不绕整段流程。
    if (Math.abs(from.position.y - to.position.y) < 1 && end.x - start.x > 48) {
        const midX = (start.x + end.x) / 2;
        const a = { x: midX, y: start.y }, b = { x: midX, y: end.y };
        const verticalClear = !nodes.some((n) => n.id !== from.id && n.id !== to.id && n.position.x - padding < midX && n.position.x + n.width + padding > midX && n.position.y < Math.max(a.y, b.y) && n.position.y + n.height > Math.min(a.y, b.y));
        if (horizontalClear(start, a) && horizontalClear(b, end) && verticalClear) return finish([start, a, b, end]);
    }
    const fromRow = own.filter((n) => n.position.y < from.position.y + from.height && n.position.y + n.height > from.position.y);
    const toRow = own.filter((n) => n.position.y < to.position.y + to.height && n.position.y + n.height > to.position.y);
    const gapY = Math.max(...fromRow.map((n) => n.position.y + n.height)) + 50;
    const approachY = Math.min(...toRow.map((n) => n.position.y)) - 42;
    const sourceIndex = Math.max(0, own.findIndex((n) => n.id === from.id));
    const lane = connection.role === "lineage" ? 0 : 1 + sourceIndex;
    let leftLane = Math.min(...own.map((n) => n.position.x)) - 70 - lane * 9;
    // 通道的竖线不能穿过画布上其他卡片。
    const low = Math.min(gapY, approachY), high = Math.max(gapY, approachY);
    for (let i = 0; i < nodes.length; i++) {
        const hits = nodes.filter((n) => n.position.x - padding < leftLane && n.position.x + n.width + padding > leftLane && n.position.y < high && n.position.y + n.height > low);
        if (!hits.length) break;
        leftLane = Math.min(...hits.map((n) => n.position.x)) - 60;
    }
    const exit = { x: start.x + 32, y: start.y };
    const enter = { x: end.x - 32, y: end.y };
    const offsetY = Math.min(lane * 2, 16);
    return finish([start, exit, { x: exit.x, y: gapY + offsetY }, { x: leftLane, y: gapY + offsetY }, { x: leftLane, y: approachY - offsetY }, { x: enter.x, y: approachY - offsetY }, enter, end]);
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
