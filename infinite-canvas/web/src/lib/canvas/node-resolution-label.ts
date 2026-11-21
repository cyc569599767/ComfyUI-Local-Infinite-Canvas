// 卡片标题后的分辨率标签。
//
// 图片/视频卡片原先只能看画面比例猜分辨率，要确认「出的是 1080p 还是 720p」
// 得点开详情。这里提供一个纯函数，把元数据换算成 "1920 × 1080" 这样的标签，
// 由 canvas-node 渲染在标题右侧（灰色小字）。
import type { CanvasNodeData } from "../../types/canvas";

/** 取用于展示的分辨率：优先素材真实尺寸，缺值时回落到卡片渲染尺寸。 */
export function resolveNodeResolution(node: Pick<CanvasNodeData, "width" | "height"> & { metadata?: { naturalWidth?: number; naturalHeight?: number } }): { width: number; height: number } | null {
    const naturalWidth = Math.round(Number(node.metadata?.naturalWidth) || 0);
    const naturalHeight = Math.round(Number(node.metadata?.naturalHeight) || 0);
    // 两者都有效才用真实尺寸：只拿到一半时（例如视频还没触发 loadedmetadata）
    // 用真实宽配渲染高会得出错误的宽高比。
    if (naturalWidth > 0 && naturalHeight > 0) return { width: naturalWidth, height: naturalHeight };

    const width = Math.round(Number(node.width) || 0);
    const height = Math.round(Number(node.height) || 0);
    if (width > 0 && height > 0) return { width, height };
    return null;
}

/** 格式化成 "1920 × 1080"。用 × 而不是 x：中文界面里 x 容易和变量名混淆。 */
export function formatResolutionLabel(node: Pick<CanvasNodeData, "width" | "height"> & { metadata?: { naturalWidth?: number; naturalHeight?: number } }): string | null {
    const size = resolveNodeResolution(node);
    if (!size) return null;
    return `${size.width} × ${size.height}`;
}
