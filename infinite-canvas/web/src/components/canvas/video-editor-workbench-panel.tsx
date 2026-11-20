import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { App, Button, Empty, Input, InputNumber, Modal, Segmented, Select, Tag, Tooltip } from "antd";
import { Download, Film, GripVertical, Import, Plus, RefreshCw, Trash2, Volume2 } from "lucide-react";
import { VideoEditorPreview } from "@/components/canvas/video-editor-preview";
import { useTranslation } from "react-i18next";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import {
    appendMissingSources,
    buildTimelineFromSources,
    timelineSeconds,
    timelinePlaybackSeconds,
    clipLayer,
    moveTimelineClip,
    type VideoEditorDraft,
    type TimelineMergedVideo,
    type EditClip,
    type TimelineSource,
} from "@/lib/canvas/video-timeline";

/**
 * 视频编辑工作台。
 *
 * 结构对应参考实现的四要素：素材导入 → 播放器 → 参数面板 → 多轨时间线。
 * 定位是「独立剪辑台」：不生成内容，只把已经生成好的片段按时间线组织起来。
 *
 * 剪辑数据只存在节点 metadata 里（不落网关）：时间线是纯本地的编排结果，
 * 导出时生成一份指令给画布/网关，避免多一份需要同步的服务端状态。
 */

export type { EditClip };

type Props = {
    open: boolean;
    nodeTitle?: string;
    onClose: () => void;
    /**
     * 画布上可导入的视频卡。
     *
     * 由宿主在打开面板时算好（见 collectTimelineSources）：面板本身不读画布，
     * 这样「哪些卡能进时间线」的规则只有一份，也方便单测。
     */
    availableSources?: TimelineSource[];
    /** 把整理好的时间线交回画布（导出/合并）。 */
    initialDraft?: VideoEditorDraft;
    onTimelineChange?: (clips: EditClip[]) => void;
    /** 成片由宿主持久化，关闭面板后再开仍可预览。 */
    onExportTimeline?: (clips: EditClip[], totalSeconds: number) => Promise<TimelineMergedVideo | void>;
};

const uid = () => `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const TRACK_COUNT = 3;
const PX_PER_SECOND = 60;

export function VideoEditorWorkbenchPanel({ open, nodeTitle, onClose, availableSources = [], initialDraft, onTimelineChange, onExportTimeline }: Props) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const { message } = App.useApp();

    const [clips, setClips] = useState<EditClip[]>(() => initialDraft?.clips || buildTimelineFromSources(availableSources));
    const [activeId, setActiveId] = useState(() => initialDraft?.clips[0]?.id || "");
    const [playhead, setPlayhead] = useState(0);
    const [selectionVersion, setSelectionVersion] = useState(0);
    const selectClip = (id: string) => { setActiveId(id); setSelectionVersion(value => value + 1); };
    const [seekRequest, setSeekRequest] = useState<{ time: number; nonce: number }>();
    const [dragMode, setDragMode] = useState<"insert" | "position">("position");
    const [zoom, setZoom] = useState(PX_PER_SECOND);
    const [dragPreview, setDragPreview] = useState<{ id: string; x: number; y: number; width: number; start: number; track: number | null } | null>(null);
    const draggedId = dragPreview?.id || "";
    const scrollRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ pointer: number; id: string; x: number; y: number; grab: number; grabY: number; width: number; original: EditClip[]; current: EditClip[]; moved: boolean; valid: boolean; mode: "insert" | "position" } | null>(null);
    const clipsRef = useRef(clips);
    clipsRef.current = clips;
    const persistRef = useRef(onTimelineChange);
    persistRef.current = onTimelineChange;
    const [importUrl, setImportUrl] = useState("");
    const [importLabel, setImportLabel] = useState("");
    const [importDuration, setImportDuration] = useState(5);
    const [exporting, setExporting] = useState(false);
    const exportLock = useRef(false);
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    // Initial seeding is a saved draft too, including intentionally empty edits.
    useEffect(() => { persistRef.current?.(clipsRef.current); }, []);
    const commitClips = useCallback((next: EditClip[]) => {
        clipsRef.current = next;
        setClips(next);
        persistRef.current?.(next);
    }, []);
    const timelineExtent = useMemo(() => timelineSeconds(clips), [clips]);
    const totalSeconds = useMemo(() => timelinePlaybackSeconds(clips), [clips]);

    const active = clips.find((clip) => clip.id === activeId) || null;
    const pendingSources = useMemo(() => {
        const identity = (item: { url: string; storageKey?: string }) => item.storageKey || item.url;
        const existing = new Set(clips.map(identity));
        return availableSources.filter((source) => source.url && !existing.has(identity(source)));
    }, [availableSources, clips]);

    // Draft changes are committed by edit handlers, never by playback ticks.

    const importFromCanvas = () => {
        const result = appendMissingSources(clips, availableSources);
        if (!result.added) {
            message.info(t("canvas.videoEditor.nothingToImport"));
            return;
        }
        commitClips(result.clips);
        message.success(t("canvas.videoEditor.importedCount", { count: result.added }));
    };

    const patchClip = useCallback((id: string, patch: Partial<EditClip>) => {
        const current = clipsRef.current;
        if (patch.start !== undefined || patch.track !== undefined) {
            const clip = current.find(item => item.id === id);
            if (clip) commitClips(moveTimelineClip(current, id, patch.start ?? clip.start, patch.track ?? clip.track, "position"));
        } else commitClips(current.map(clip => clip.id === id ? { ...clip, ...patch } : clip));
    }, [commitClips]);

    const addClip = () => {
        const url = importUrl.trim();
        if (!url) {
            message.warning(t("canvas.videoEditor.needUrl"));
            return;
        }
        const duration = Math.max(0.5, Number(importDuration) || 5);
        // 新片段追加在最短的那条轨道末尾，避免互相压住。
        const trackLoad = Array.from({ length: TRACK_COUNT }, (_, track) =>
            clips.filter((clip) => clip.track === track).reduce((end, clip) => Math.max(end, clip.start + (clip.outPoint - clip.inPoint)), 0),
        );
        const track = trackLoad.indexOf(Math.min(...trackLoad));
        const start = trackLoad[track];
        const clip: EditClip = {
            id: uid(), url, label: importLabel.trim() || url.split("/").pop() || t("canvas.videoEditor.unnamed"),
            start, duration, inPoint: 0, outPoint: duration, track, volume: 1,
        };
        commitClips([...clipsRef.current, clip]);
        selectClip(clip.id);
        setImportUrl("");
        setImportLabel("");
    };

    const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, clip: EditClip) => {
        if (event.button !== 0 || exporting) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.focus();
        selectClip(clip.id);
        const box = event.currentTarget.getBoundingClientRect();
        dragRef.current = { pointer: event.pointerId, id: clip.id, x: event.clientX, y: event.clientY, grab: event.clientX - box.left, grabY: event.clientY - box.top, width: box.width, original: clipsRef.current, current: clipsRef.current, moved: false, valid: true, mode: dragMode };
        contentRef.current?.setPointerCapture(event.pointerId);
    };
    const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        const content = contentRef.current;
        const scroll = scrollRef.current;
        if (!drag || drag.pointer !== event.pointerId || !content || !scroll) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
        drag.moved = true;
        const scrollBox = scroll.getBoundingClientRect();
        const insideX = event.clientX >= scrollBox.left && event.clientX <= scrollBox.right;
        if (insideX && event.clientX > scrollBox.right - 48) scroll.scrollLeft += 18;
        else if (insideX && event.clientX < scrollBox.left + 48) scroll.scrollLeft -= 18;
        const rect = content.getBoundingClientRect();
        const start = Math.max(0, (event.clientX - rect.left - 36 - drag.grab) / zoom);
        const rows = [...content.querySelectorAll<HTMLElement>("[data-timeline-track]")];
        const target = insideX ? rows.find(row => { const box = row.getBoundingClientRect(); return event.clientY >= box.top && event.clientY <= box.bottom; }) : undefined;
        const track = target ? Number(target.dataset.timelineTrack) : null;
        drag.valid = track !== null;
        if (track !== null) drag.current = moveTimelineClip(drag.original, drag.id, start, track, drag.mode);
        const placed = drag.current.find(clip => clip.id === drag.id)!;
        setDragPreview({ id: drag.id, x: event.clientX - drag.grab, y: event.clientY - drag.grabY, width: drag.width, start: placed.start, track });
    };
    const endDrag = (cancel = false) => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null; setDragPreview(null);
        if (!cancel && drag.moved && drag.valid) commitClips(drag.current);
        if (contentRef.current?.hasPointerCapture(drag.pointer)) contentRef.current.releasePointerCapture(drag.pointer);
    };
    useEffect(() => {
        const cancel = (event: KeyboardEvent) => {
            const drag = dragRef.current;
            if (event.key !== "Escape" || !drag) return;
            event.preventDefault(); event.stopImmediatePropagation();
            dragRef.current = null; setDragPreview(null);
            if (contentRef.current?.hasPointerCapture(drag.pointer)) contentRef.current.releasePointerCapture(drag.pointer);
        };
        const blur = () => { const drag = dragRef.current; if (!drag) return; dragRef.current = null; setDragPreview(null); if (contentRef.current?.hasPointerCapture(drag.pointer)) contentRef.current.releasePointerCapture(drag.pointer); };
        window.addEventListener("keydown", cancel, true);
        window.addEventListener("blur", blur);
        return () => { window.removeEventListener("keydown", cancel, true); window.removeEventListener("blur", blur); };
    }, []);
    const seekTimeline = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!contentRef.current || dragRef.current || exporting) return;
        const time = Math.max(0, Math.min(totalSeconds, (event.clientX - contentRef.current.getBoundingClientRect().left - 36) / zoom));
        setPlayhead(time); setSeekRequest({ time, nonce: Date.now() });
    };

    const exportTimeline = async () => {
        if (!clips.length) {
            message.warning(t("canvas.videoEditor.needClips"));
            return;
        }
        if (exportLock.current) return;
        exportLock.current = true;
        setExporting(true);
        try {
            await onExportTimeline?.(clips, totalSeconds);
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : String(cause));
        } finally {
            exportLock.current = false;
            if (mounted.current) setExporting(false);
        }
    };

    return (
        <Modal
            open={open}
            closable={!exporting}
            maskClosable={!exporting}
            keyboard={!exporting}
            onCancel={() => { endDrag(true); onClose(); }}
            footer={null}
            width="94vw"
            centered
            destroyOnHidden
            transitionName=""
            maskTransitionName=""
            title={
                <span className="flex items-center gap-2">
                    <Film className="size-4" />
                    {t("canvas.workbench.videoEditor")}
                    {nodeTitle ? <Tag color="cyan">{nodeTitle}</Tag> : null}
                </span>
            }
        >
            <div data-video-editor className="flex h-[79vh] min-h-0 flex-col gap-3 overflow-auto" style={{ color: theme.node.text }}>
                <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
                    {/* 左：素材导入 + 参数面板 */}
                    <div className="flex w-full shrink-0 flex-col gap-2 md:w-64 md:overflow-auto" style={{ pointerEvents: exporting ? "none" : undefined, opacity: exporting ? 0.6 : 1 }}>
                        <div className="rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
                                <Film className="size-3.5" />
                                {t("canvas.videoEditor.canvasSources")}
                                <span className="text-[10px]" style={{ color: theme.node.muted }}>{availableSources.length}</span>
                                <div className="flex-1" />
                                <Tooltip title={t("canvas.videoEditor.syncCanvasHint")}>
                                    <Button size="small" type="text" icon={<RefreshCw className="size-3.5" />} onClick={importFromCanvas} disabled={!pendingSources.length} />
                                </Tooltip>
                            </div>
                            {!availableSources.length ? (
                                <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                                    {t("canvas.videoEditor.noCanvasSources")}
                                </div>
                            ) : (
                                <div className="max-h-32 overflow-auto thin-scrollbar">
                                    {availableSources.map((source) => {
                                        const used = !pendingSources.some((item) => item.nodeId === source.nodeId);
                                        return (
                                            <div key={source.nodeId} className="flex items-center gap-1 py-0.5 text-[11px]">
                                                <button type="button" className="truncate text-left hover:underline" style={{ color: used ? theme.node.muted : theme.node.text }} title={`预览：${source.label}`} onClick={() => {
                                                    const existing = clips.find(clip => (source.storageKey && clip.storageKey === source.storageKey) || clip.url === source.url);
                                                    if (existing) selectClip(existing.id);
                                                    else { const added = buildTimelineFromSources([source], timelineSeconds(clips)); commitClips([...clipsRef.current, ...added]); setActiveId(added[0].id); }
                                                }}>
                                                    {source.label}
                                                </button>
                                                <span className="shrink-0 font-mono text-[10px]" style={{ color: theme.node.muted }}>{source.duration.toFixed(1)}s</span>
                                                <div className="flex-1" />
                                                {used ? (
                                                    <span className="shrink-0 text-[10px]" style={{ color: theme.node.muted }}>{t("canvas.videoEditor.inTimeline")}</span>
                                                ) : (
                                                    <Button
                                                        size="small"
                                                        type="link"
                                                        className="!h-4 !px-1 text-[11px]"
                                                        onClick={() => {
                                                            const next = buildTimelineFromSources([source], timelineSeconds(clips));
                                                            commitClips([...clipsRef.current, ...next]);
                                                        }}
                                                    >
                                                        {t("canvas.videoEditor.importOne")}
                                                    </Button>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                        <div className="rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
                                <Import className="size-3.5" />
                                {t("canvas.videoEditor.import")}
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <Input size="small" value={importUrl} placeholder={t("canvas.videoEditor.urlPlaceholder")} onChange={(event) => setImportUrl(event.target.value)} />
                                <Input size="small" value={importLabel} placeholder={t("canvas.videoEditor.labelPlaceholder")} onChange={(event) => setImportLabel(event.target.value)} />
                                <div className="flex items-center gap-1.5">
                                    <InputNumber size="small" min={0.5} max={3600} value={importDuration} onChange={(value) => setImportDuration(Number(value) || 5)} className="flex-1" addonAfter="s" />
                                    <Button size="small" icon={<Plus className="size-3.5" />} onClick={addClip}>
                                        {t("canvas.videoEditor.add")}
                                    </Button>
                                </div>
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 overflow-auto rounded-lg border p-2 thin-scrollbar" style={{ borderColor: theme.node.stroke }}>
                            <div className="mb-1.5 text-xs font-medium">{t("canvas.videoEditor.params")}</div>
                            {!active ? (
                                <div className="text-xs" style={{ color: theme.node.muted }}>
                                    {t("canvas.videoEditor.selectClip")}
                                </div>
                            ) : (
                                <div className="flex flex-col gap-2 text-xs">
                                    <label className="flex flex-col gap-1">
                                        <span style={{ color: theme.node.muted }}>{t("canvas.videoEditor.name")}</span>
                                        <Input size="small" value={active.label} onChange={(event) => patchClip(active.id, { label: event.target.value })} />
                                    </label>
                                    <div className="flex gap-1.5">
                                        <label className="flex flex-1 flex-col gap-1">
                                            <span style={{ color: theme.node.muted }}>{t("canvas.videoEditor.inPoint")}</span>
                                            <InputNumber
                                                size="small"
                                                min={0}
                                                max={active.duration}
                                                step={0.1}
                                                value={active.inPoint}
                                                onChange={(value) => {
                                                    const next = Math.max(0, Math.min(Number(value) || 0, active.outPoint - 0.1));
                                                    patchClip(active.id, { inPoint: next });
                                                }}
                                                className="w-full"
                                            />
                                        </label>
                                        <label className="flex flex-1 flex-col gap-1">
                                            <span style={{ color: theme.node.muted }}>{t("canvas.videoEditor.outPoint")}</span>
                                            <InputNumber
                                                size="small"
                                                min={0}
                                                max={active.duration}
                                                step={0.1}
                                                value={active.outPoint}
                                                onChange={(value) => {
                                                    const next = Math.min(active.duration, Math.max(Number(value) || 0, active.inPoint + 0.1));
                                                    patchClip(active.id, { outPoint: next });
                                                }}
                                                className="w-full"
                                            />
                                        </label>
                                    </div>
                                    <div className="flex gap-1.5">
                                        <label className="flex flex-1 flex-col gap-1">
                                            <span style={{ color: theme.node.muted }}>{t("canvas.videoEditor.start")}</span>
                                            <InputNumber size="small" min={0} step={0.1} value={active.start} onChange={(value) => patchClip(active.id, { start: Math.max(0, Number(value) || 0) })} className="w-full" />
                                        </label>
                                        <label className="flex flex-1 flex-col gap-1">
                                            <span style={{ color: theme.node.muted }}>{t("canvas.videoEditor.track")}</span>
                                            <Select
                                                size="small"
                                                value={active.track}
                                                options={Array.from({ length: TRACK_COUNT }, (_, index) => ({ value: index, label: t("canvas.videoEditor.trackN", { n: index + 1 }) }))}
                                                onChange={(value) => patchClip(active.id, { track: value })}
                                                className="w-full"
                                            />
                                        </label>
                                    </div>
                                    <label className="flex flex-col gap-1">
                                        <span className="flex items-center gap-1" style={{ color: theme.node.muted }}>
                                            <Volume2 className="size-3" />
                                            {t("canvas.videoEditor.volume")}
                                        </span>
                                        <InputNumber size="small" min={0} max={2} step={0.1} value={active.volume} onChange={(value) => patchClip(active.id, { volume: Number(value) || 0 })} className="w-full" />
                                    </label>
                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => { commitClips(clipsRef.current.filter((clip) => clip.id !== active.id)); setActiveId(""); }}>
                                        {t("canvas.videoEditor.remove")}
                                    </Button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* 右：播放器 + 多轨时间线 */}
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <VideoEditorPreview clips={clips} activeId={activeId} selectionVersion={selectionVersion} seekRequest={seekRequest} onTimelineTime={setPlayhead} />
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            <Segmented size="small" value={dragMode} disabled={exporting} onChange={value => setDragMode(value as "insert" | "position")} options={[{ label: "自由定位", value: "position" }, { label: "拖拽排序", value: "insert" }]} />
                            <span style={{ color: theme.node.muted }}>{dragMode === "insert" ? "拖动片段插入新顺序，上下拖动换轨" : "拖动设置起始位置，允许重叠；松开鼠标落轨"}</span>
                            <div className="flex-1" />
                            <Select size="small" aria-label="时间轴缩放" value={zoom} onChange={setZoom} options={[{value:20,label:"缩放 1/3"},{value:40,label:"缩放 2/3"},{value:60,label:"缩放 1×"},{value:100,label:"缩放 1.7×"}]} />
                        </div>

                        <div ref={scrollRef} data-timeline-scroll className="min-h-[200px] flex-1 overflow-auto rounded-lg border p-2 thin-scrollbar" style={{ borderColor: theme.node.stroke }}>
                            {!clips.length ? (
                                <div className="flex h-40 items-center justify-center">
                                    <Empty description={t("canvas.videoEditor.noClips")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                                </div>
                            ) : (
                                <div ref={contentRef} onPointerMove={moveDrag} onPointerUp={event => { if (event.button === 0) { if (dragRef.current?.moved) moveDrag(event); endDrag(); } }} onPointerCancel={() => endDrag(true)} onLostPointerCapture={() => endDrag(true)} className="relative" style={{ width: Math.max(600, timelineExtent * zoom + 180) }}>
                                    {/* 时间刻度：零点与片段、播放头共用 36px 轨道标签边距。 */}
                                    <div data-timeline-ruler onPointerDown={event => seekTimeline(event)} className="relative mb-1 h-5 cursor-crosshair border-b" style={{ borderColor: theme.node.stroke }}>
                                        {Array.from({ length: Math.ceil(timelineExtent / (zoom < 40 ? 5 : 1)) + 1 }, (_, index) => index * (zoom < 40 ? 5 : 1)).map(second => (
                                            <span key={second} className="absolute top-0 font-mono text-[10px]" style={{ left: 36 + second * zoom, color: theme.node.muted }}>
                                                {second}s
                                            </span>
                                        ))}
                                    </div>
                                    {Array.from({ length: TRACK_COUNT }, (_, track) => (
                                        <div key={track} data-timeline-track={track} onPointerDown={event => seekTimeline(event)} className="relative mb-1 h-12 rounded" style={{ background: dragPreview?.track === track ? "rgba(37,99,235,.12)" : theme.node.panel, border: `1px solid ${dragPreview?.track === track ? "#2563eb" : theme.node.stroke}` }}>
                                            <span className="absolute -left-0 top-1 text-[10px]" style={{ color: theme.node.muted }}>
                                                {t("canvas.videoEditor.trackN", { n: track + 1 })}{track === 0 ? " · 上" : track === TRACK_COUNT - 1 ? " · 下" : ""}
                                            </span>
                                            {clips
                                                .filter((clip) => clip.track === track)
                                                .map((clip) => {
                                                    const width = Math.max(8, (clip.outPoint - clip.inPoint) * zoom);
                                                    const isActive = clip.id === activeId;
                                                    return (
                                                        <div
                                                            key={clip.id}
                                                            data-edit-clip={clip.id}
                                                            data-clip-start={clip.start}
                                                            data-clip-track={clip.track}
                                                            role="button"
                                                            tabIndex={exporting ? -1 : 0}
                                                            aria-label={`镜头：${clip.label}`}
                                                            aria-pressed={isActive}
                                                            className="absolute top-1 flex h-9 touch-none select-none items-center gap-1 overflow-hidden rounded px-1.5 text-[11px] outline-offset-2"
                                                            style={{
                                                                left: 36 + clip.start * zoom,
                                                                width,
                                                                cursor: draggedId === clip.id ? "grabbing" : "grab",
                                                                zIndex: [...clips].sort((a, b) => clipLayer(a, clips.indexOf(a)) - clipLayer(b, clips.indexOf(b)) || clips.indexOf(a) - clips.indexOf(b)).indexOf(clip) + 1,
                                                                opacity: draggedId === clip.id ? 0.2 : 1,
                                                                background: isActive ? "#2563eb" : "#6366b8",
                                                                boxShadow: draggedId === clip.id ? "0 3px 10px #0004" : undefined,
                                                                color: "#fff",
                                                            }}
                                                            onPointerDown={event => beginDrag(event, clip)}
                                                            onKeyDown={event => {
                                                                if (event.key === "Escape" && dragRef.current) { event.preventDefault(); event.stopPropagation(); endDrag(true); return; }
                                                                if (exporting) return;
                                                                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectClip(clip.id); }
                                                                if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                                                                    event.preventDefault(); selectClip(clip.id);
                                                                    const step = event.shiftKey ? 1 : 0.1;
                                                                    commitClips(moveTimelineClip(clipsRef.current, clip.id, clip.start + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), clip.track + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0), "position"));
                                                                }
                                                            }}
                                                            title={`${clip.label} ${clip.inPoint.toFixed(1)}–${clip.outPoint.toFixed(1)}s`}
                                                        >
                                                            <GripVertical className="size-3 shrink-0 opacity-70" />
                                                            <span className="truncate">{clip.label}</span>
                                                        </div>
                                                    );
                                                })}
                                            {dragPreview?.track === track && <div data-drop-target data-drop-start={dragPreview.start} className="pointer-events-none absolute top-1 z-[200] h-9 rounded border-2 border-dashed border-blue-600 bg-blue-500/10" style={{ left: 36 + dragPreview.start * zoom, width: dragPreview.width }} />}
                                        </div>
                                    ))}
                                    {/* 播放头 */}
                                    <div data-timeline-playhead className="pointer-events-none absolute inset-y-0 z-[300] w-px" style={{ left: 36 + playhead * zoom, background: "#ef4444" }} />
                                </div>
                            )}
                        </div>

                        <div className="flex items-center gap-2">
                            <span className="text-xs" style={{ color: theme.node.muted }}>
                                {t("canvas.videoEditor.summary", { count: clips.length, seconds: totalSeconds.toFixed(1) })}
                            </span>
                            <div className="flex-1" />
                            <Button
                                size="small"
                                type="primary"
                                icon={<Download className="size-3.5" />}
                                loading={exporting}
                                disabled={!clips.length || !onExportTimeline}
                                onClick={exportTimeline}
                            >
                                {t("canvas.videoEditor.export")}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
            {dragPreview && createPortal(<div data-drag-ghost className="pointer-events-none fixed z-[10000] flex h-9 items-center gap-1 rounded border border-blue-300 bg-blue-600 px-2 text-[11px] text-white shadow-xl" style={{ left: dragPreview.x, top: dragPreview.y, width: dragPreview.width }}>
                <GripVertical className="size-3 shrink-0" /><span className="truncate">{clips.find(clip => clip.id === dragPreview.id)?.label}</span>
                <div className="absolute -top-6 left-0 whitespace-nowrap rounded bg-blue-700 px-2 py-1 text-[10px]">{dragPreview.track === null ? "移到轨道内松开；当前松开将取消" : `轨道 ${dragPreview.track + 1} · ${dragPreview.start.toFixed(2)}s · 松开落位`}</div>
            </div>, document.body)}
        </Modal>
    );
}