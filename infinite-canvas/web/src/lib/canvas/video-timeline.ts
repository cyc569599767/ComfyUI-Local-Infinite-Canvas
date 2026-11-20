import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * 视频编辑工作台的时间线模型与「画布 → 时间线」的桥接。
 *
 * 放在这里而不是面板里，是为了让「收集哪些片段、按什么顺序排」变成可单测的纯函数：
 * 这部分一旦出错，用户看到的是成片顺序错乱，而不是一个能立刻定位的报错。
 */

export type EditClip = {
    id: string;
    /** 素材地址（画布里的视频节点 URL 或外部链接）。 */
    url: string;
    /**
     * 素材在本地素材库里的键。
     *
     * 画布卡片的 URL 可能是临时的 blob: 或已过期的网关地址，
     * 合并时优先按这个键取回原始文件，取不到再退回 url。
     */
    storageKey?: string;
    label: string;
    /** 该片段在时间线上的起点（秒）。 */
    start: number;
    /** 素材本身的时长（秒），拖拽时用来算尾部空隙。 */
    duration: number;
    /** 入点/出点（相对素材），用来做裁剪。 */
    inPoint: number;
    outPoint: number;
    track: number;
    /** 同轨叠放顺序：数值越大越靠上；拖动落位后置顶。 */
    layer?: number;
    volume: number;
};

export type TimelineMergedVideo = { url: string; storageKey?: string; label: string; duration: number; timelineSignature: string; nodeId?: string };
export type VideoEditorDraft = { version: 1; clips: EditClip[]; merged?: TimelineMergedVideo };
export type PlaybackSegment = { id: string; start: number; duration: number; clip?: EditClip };

export function orderedTimelineClips(clips: EditClip[]) {
    return [...clips].sort((a, b) => a.track - b.track || a.start - b.start);
}
const segmentDuration = (clip: EditClip) => Math.max(0.04, clip.outPoint - Math.max(0, clip.inPoint));

export function clipLayer(clip: EditClip, index: number) {
    return Number.isFinite(clip.layer) ? clip.layer! : index + 1;
}

/** Highest visible track wins. Same-track order matches the drawn stacking order. */
export function timelinePlaybackSegments(clips: EditClip[]): PlaybackSegment[] {
    const indexed = clips.map((clip, index) => ({ clip, index, layer: clipLayer(clip, index) }));
    const boundaries = [...new Set([0, ...clips.flatMap(clip => [clip.start, clip.start + segmentDuration(clip)])])].sort((a, b) => a - b);
    const result: PlaybackSegment[] = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
        const start = boundaries[i], end = boundaries[i + 1];
        if (end - start < 1e-8) continue;
        const winner = indexed.filter(({ clip }) => clip.start <= start + 1e-8 && clip.start + segmentDuration(clip) > start + 1e-8)
            .sort((a, b) => a.clip.track - b.clip.track || b.layer - a.layer || b.index - a.index)[0]?.clip;
        const previous = result.at(-1);
        if (previous && previous.clip === winner) previous.duration = end - previous.start;
        else result.push({ id: `${winner?.id || "gap"}@${start}`, start, duration: end - start, clip: winner });
    }
    return result;
}
export function timelinePlaybackSeconds(clips: EditClip[]) {
    const last = timelinePlaybackSegments(clips).at(-1);
    return last ? last.start + last.duration : 0;
}
export function timelineSignature(clips: EditClip[]) {
    return `overlay-v2:${JSON.stringify(clips.map((clip, index) => [clip.id, clip.storageKey || clip.url, clip.start, clip.track, clipLayer(clip, index), clip.inPoint, clip.outPoint, clip.volume]))}`;
}

/** Insert is optional packing; position preserves every other clip and permits overlap. */
export function moveTimelineClip(clips: EditClip[], id: string, targetStart: number, targetTrack: number, mode: "insert" | "position" = "position"): EditClip[] {
    const moving = clips.find(clip => clip.id === id);
    if (!moving) return clips;
    const track = Math.max(0, Math.min(2, Math.round(Number(targetTrack) || 0)));
    let start = Math.max(0, Number.isFinite(targetStart) ? targetStart : 0);
    const others = orderedTimelineClips(clips.filter(clip => clip.id !== id && clip.track === track));
    const updates = new Map<string, EditClip>();
    if (mode === "insert") {
        const index = others.findIndex(clip => start < clip.start + segmentDuration(clip) / 2);
        const ordered = [...others];
        ordered.splice(index < 0 ? ordered.length : index, 0, { ...moving, track });
        const pack = (items: EditClip[]) => { let position = 0; for (const clip of items) { updates.set(clip.id, { ...clip, start: position }); position += segmentDuration(clip); } };
        pack(ordered);
        if (moving.track !== track) pack(orderedTimelineClips(clips.filter(clip => clip.id !== id && clip.track === moving.track)));
    } else {
        const edges = [0, ...others.flatMap(clip => [clip.start + segmentDuration(clip), clip.start - segmentDuration(moving)])].filter(value => value >= 0);
        const snapped = edges.reduce((best, value) => Math.abs(value - start) < Math.abs(best - start) ? value : best, edges[0]);
        start = Math.abs(snapped - start) <= 0.15 ? snapped : Math.round(start * 10) / 10;
        updates.set(id, { ...moving, start, track, layer: Math.max(0, ...clips.map(clipLayer)) + 1 });
    }
    return clips.map(clip => updates.get(clip.id) || clip);
}

/** 画布上一张可被导入时间线的视频卡。 */
export type TimelineSource = {
    /** 节点 id，用于去重。 */
    nodeId: string;
    label: string;
    url: string;
    storageKey?: string;
    /** 素材时长（秒）；探测不到时沿用 fallback。 */
    duration: number;
};

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i;
/** 时长未知时的兜底：视频工作流默认出 5 秒，比塞 0 秒（会被当成空片段）安全。 */
export const FALLBACK_CLIP_SECONDS = 5;

export function isVideoContent(metadata: CanvasNodeData["metadata"]) {
    const content = metadata?.content || "";
    if (!content) return false;
    const mime = String(metadata?.mimeType || "");
    if (mime.startsWith("video/")) return true;
    if (mime && !mime.startsWith("video/")) return false;
    return VIDEO_EXT.test(content);
}

/**
 * 能不能进时间线。
 *
 * 视频节点本身就是「这是视频」的声明，内容地址不一定是 .mp4（可能是 blob: 或网关直链），
 * 所以节点类型优先；其它类型的卡片只有 URL/扩展名明确是视频时才收。
 */
export function isTimelineNode(node: CanvasNodeData) {
    if (node.metadata?.creationOutput?.revisionKind || node.metadata?.creationOutput?.needsRevision) return false;
    if (!node.metadata?.content) return false;
    return node.type === CanvasNodeType.Video || isVideoContent(node.metadata);
}

/** 时长统一按秒；metadata.durationMs 是毫秒，别再乘 1000。 */
export function clipSeconds(metadata: CanvasNodeData["metadata"]) {
    const ms = Number(metadata?.durationMs) || 0;
    if (ms > 0) return ms / 1000;
    return FALLBACK_CLIP_SECONDS;
}

/**
 * 收集画布上的视频卡，按「列优先」排序。
 *
 * 分镜卡通常是竖着一列往下建的，按 (y, x) 排才是用户在画布上看到的顺序；
 * 按创建时间排会让「先建的最后一镜」跑到片头。
 */
export function collectTimelineSources(nodes: CanvasNodeData[], excludeNodeId?: string): TimelineSource[] {
    return nodes
        .filter((node) => node.id !== excludeNodeId)
        .filter(isTimelineNode)
        .slice()
        .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
        .map((node) => ({
            nodeId: node.id,
            label: (node.title || node.metadata?.prompt || "").trim() || "片段",
            url: String(node.metadata?.content || ""),
            storageKey: node.metadata?.storageKey || undefined,
            duration: clipSeconds(node.metadata),
        }));
}

/**
 * 把素材按顺序串成一条时间线。
 *
 * 只在轨道 0 上首尾相接：这条时间线的语义就是「成片的播放顺序」，
 * 多轨留给用户自己手动调整，自动导入不该擅自叠轨。
 */
export function buildTimelineFromSources(sources: TimelineSource[], startAt = 0): EditClip[] {
    let cursor = Math.max(0, Number(startAt) || 0);
    return sources.map((source, index) => {
        const duration = Math.max(0.5, Number(source.duration) || FALLBACK_CLIP_SECONDS);
        const clip: EditClip = {
            id: `clip-${source.nodeId}-${index}`,
            url: source.url,
            storageKey: source.storageKey,
            label: source.label,
            start: cursor,
            duration,
            inPoint: 0,
            outPoint: duration,
            track: 0,
            volume: 1,
        };
        cursor += duration;
        return clip;
    });
}

/** 时间线总长：取所有片段末尾的最大值，而不是各段时长相加（多轨会重叠）。 */
export function timelineSeconds(clips: EditClip[]) {
    return clips.reduce((max, clip) => Math.max(max, clip.start + Math.max(0, clip.outPoint - clip.inPoint)), 0);
}

/**
 * 追加导入：只补时间线上还没有的素材（按 URL 去重）。
 *
 * 用户手改过入点/出点后再次「同步画布」不应该把改动冲掉，
 * 所以这里只追加新增的卡，已存在的一律不动。
 */
export function appendMissingSources(clips: EditClip[], sources: TimelineSource[]) {
    const identity = (item: { url: string; storageKey?: string }) => item.storageKey || item.url;
    const existing = new Set(clips.map(identity));
    const missing = sources.filter((source) => source.url && !existing.has(identity(source)));
    if (!missing.length) return { clips, added: 0 };
    const offset = timelineSeconds(clips);
    return { clips: [...clips, ...buildTimelineFromSources(missing, offset)], added: missing.length };
}

/**
 * 导出用的合并描述。
 *
 * 同一 URL 只上传一次（同一素材被裁成两段时很常见），clips.source 指回上传序号；
 * 原数组顺序保留作同轨同层的最后决胜；track/layer 显式表达画面优先级。
 */
export type MergePayload = {
    clips: Array<{ source: number; inPoint: number; outPoint: number; duration: number; start: number; track: number; layer?: number; volume: number }>;
    sources: Array<{ name: string; url: string; storageKey?: string; type: string }>;
    totalSeconds: number;
};

export function buildMergePayload(clips: EditClip[]): MergePayload {
    const sources: MergePayload["sources"] = [];
    // 去重键取 storageKey 优先：同一素材的 URL 可能因为解析时机不同而不一致
    // （一次是 blob:，一次是网关地址），key 才是稳定的身份。
    const identity = (clip: EditClip) => clip.storageKey || clip.url;
    const indexByKey = new Map<string, number>();
    const payloadClips = clips.map((clip, index) => {
        const key = identity(clip);
        let source = indexByKey.get(key);
        if (source === undefined) {
            source = sources.length;
            indexByKey.set(key, source);
            sources.push({ name: `clip_${source + 1}.mp4`, url: clip.url, storageKey: clip.storageKey, type: "video/mp4" });
        }
        return {
            source,
            inPoint: Math.max(0, clip.inPoint),
            // 出点不能小于入点，否则网关那边 trim 出来是空片段。
            outPoint: Math.max(Math.max(0, clip.inPoint) + 0.04, clip.outPoint),
            duration: Math.max(0.04, clip.duration),
            start: Math.max(0, clip.start),
            track: Math.max(0, clip.track),
            layer: clipLayer(clip, index),
            volume: Math.max(0, Math.min(2, Number(clip.volume) || 0)),
        };
    });
    return { clips: payloadClips, sources, totalSeconds: timelinePlaybackSeconds(clips) };
}