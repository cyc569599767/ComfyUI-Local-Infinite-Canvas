// 详情弹窗的分辨率展示。
//
// 图片可能来自批次的某一项（primaryImage 有自己尺寸），也可能是卡片本身的
// naturalWidth/Height；视频要等 loadedmetadata 才有真实尺寸。这里统一收敛成
// 一个「当前正在看的这张」的尺寸，供标题栏显示。

export type DetailMediaSize = { width: number; height: number };

type SizeSource = {
    naturalWidth?: number;
    naturalHeight?: number;
};

/**
 * 取当前预览媒体的真实尺寸。
 *
 * - 优先用传进来的 primary（批次里具体那张图）
 * - 再回落到节点级 metadata
 * - 两者都不全时返回 null（宁可不显示，也不显示一半配一半的错误比例）
 */
export function resolveDetailMediaSize(primary: SizeSource | undefined | null, fallback: SizeSource | undefined | null): DetailMediaSize | null {
    const fromPrimary = normalize(primary);
    if (fromPrimary) return fromPrimary;
    return normalize(fallback);
}

function normalize(source: SizeSource | undefined | null): DetailMediaSize | null {
    const width = Math.round(Number(source?.naturalWidth) || 0);
    const height = Math.round(Number(source?.naturalHeight) || 0);
    // 两者都有效才算，否则宽高比会算错
    if (width > 0 && height > 0) return { width, height };
    return null;
}

/** 格式化为 "1920 × 1080"；没有尺寸时返回 null，调用方据此不渲染。 */
export function formatDetailMediaSize(size: DetailMediaSize | null): string | null {
    if (!size) return null;
    return `${size.width} × ${size.height}`;
}

/** 视频/图片在弹窗里请求全屏时用的元素类型（图片用 img，视频用 video）。 */
export function fullscreenTargetTag(nodeType: string | undefined, isVideoType: string): "video" | "img" {
    return nodeType === isVideoType ? "video" : "img";
}
