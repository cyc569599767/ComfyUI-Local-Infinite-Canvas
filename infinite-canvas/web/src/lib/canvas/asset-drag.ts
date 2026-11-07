import type { Asset } from "@/stores/use-asset-store";
import type { Position } from "@/types/canvas";

// Transfer only an ID. Resolve media from our current catalog on drop, never
// trust arbitrary URLs/content or embedded asset JSON supplied by another page.
export const CANVAS_ASSET_MIME = "application/x-infinite-canvas-asset";
export function encodeCanvasAssetDrag(assetId: string): string {
    return JSON.stringify({ version: 1, assetId });
}
export function decodeCanvasAssetDrag(raw: string): string | null {
    if (!raw || raw.length > 2048) return null;
    try {
        const value = JSON.parse(raw);
        return value?.version === 1 && typeof value.assetId === "string" && value.assetId.length > 0 && value.assetId.length <= 256
            ? value.assetId : null;
    } catch { return null; }
}
export function resolveDraggedAsset(raw: string, assets: readonly Asset[]): Asset | null {
    const id = decodeCanvasAssetDrag(raw);
    return id ? assets.find(asset => asset.id === id) || null : null;
}
export function assetDropPosition(client: Position, bounds: { left: number; top: number }, viewport: { x: number; y: number; k: number }): Position {
    return { x: (client.x - bounds.left - viewport.x) / viewport.k, y: (client.y - bounds.top - viewport.y) / viewport.k };
}
