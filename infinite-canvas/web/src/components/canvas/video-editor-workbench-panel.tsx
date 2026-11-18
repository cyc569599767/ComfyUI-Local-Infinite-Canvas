import { useCallback, useMemo, useRef, useState } from "react";
import { App, Button, Empty, Input, InputNumber, Modal, Select, Tag } from "antd";
import { Film, GripVertical, Import, Pause, Play, Plus, Scissors, Trash2, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";

/**
 * 视频编辑工作台。
 *
 * 结构对应参考实现的四要素：素材导入 → 播放器 → 参数面板 → 多轨时间线。
 * 定位是「独立剪辑台」：不生成内容，只把已经生成好的片段按时间线组织起来。
 *
 * 剪辑数据只存在节点 metadata 里（不落网关）：时间线是纯本地的编排结果，
 * 导出时生成一份指令给画布/网关，避免多一份需要同步的服务端状态。
 */

export type EditClip = {
    id: string;
    /** 素材地址（画布里的视频节点 URL 或外部链接）。 */
    url: string;
    label: string;
    /** 该片段在时间线上的起点（秒）。 */
    start: number;
    /** 素材本身的时长（秒），拖拽时用来算尾部空隙。 */
    duration: number;
    /** 入点/出点（相对素材），用来做裁剪。 */
    inPoint: number;
    outPoint: number;
    track: number;
    volume: number;
};

type Props = {
    open: boolean;
    nodeTitle?: string;
    onClose: () => void;
    /** 把整理好的时间线交回画布（导出/合并）。 */
    onExportTimeline?: (clips: EditClip[], totalSeconds: number) => Promise<void>;
};

const uid = () => `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const TRACK_COUNT = 3;
const PX_PER_SECOND = 60;

export function VideoEditorWorkbenchPanel({ open, nodeTitle, onClose, onExportTimeline }: Props) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const { message } = App.useApp();

    const [clips, setClips] = useState<EditClip[]>([]);
    const [activeId, setActiveId] = useState("");
    const [playhead, setPlayhead] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [importUrl, setImportUrl] = useState("");
    const [importLabel, setImportLabel] = useState("");
    const [importDuration, setImportDuration] = useState(5);
    const [exporting, setExporting] = useState(false);
    const playTimer = useRef<number | null>(null);

    const totalSeconds = useMemo(
        () => clips.reduce((max, clip) => Math.max(max, clip.start + Math.max(0, clip.outPoint - clip.inPoint)), 0),
        [clips],
    );

    const active = clips.find((clip) => clip.id === activeId) || null;

    const patchClip = useCallback((id: string, patch: Partial<EditClip>) => {
        setClips((prev) => prev.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip)));
    }, []);

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
        setClips((prev) => [...prev, clip]);
        setActiveId(clip.id);
        setImportUrl("");
        setImportLabel("");
    };

    const togglePlay = () => {
        if (playing) {
            if (playTimer.current) window.clearInterval(playTimer.current);
            playTimer.current = null;
            setPlaying(false);
            return;
        }
        if (totalSeconds <= 0) return;
        setPlaying(true);
        playTimer.current = window.setInterval(() => {
            setPlayhead((current) => {
                const next = current + 0.1;
                if (next >= totalSeconds) {
                    if (playTimer.current) window.clearInterval(playTimer.current);
                    playTimer.current = null;
                    setPlaying(false);
                    return totalSeconds;
                }
                return next;
            });
        }, 100);
    };

    const exportTimeline = async () => {
        if (!clips.length) {
            message.warning(t("canvas.videoEditor.needClips"));
            return;
        }
        setExporting(true);
        try {
            // 按轨道排序后交给画布：合并顺序必须确定，否则同样素材导出两次结果不同。
            const ordered = [...clips].sort((a, b) => (a.track - b.track) || (a.start - b.start));
            await onExportTimeline?.(ordered, totalSeconds);
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setExporting(false);
        }
    };

    const currentClip = clips.find(
        (clip) => playhead >= clip.start && playhead < clip.start + Math.max(0, clip.outPoint - clip.inPoint),
    );

    return (
        <Modal
            open={open}
            onCancel={onClose}
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
            <div className="flex max-h-[80vh] flex-col gap-3 overflow-hidden" style={{ color: theme.node.text }}>
                <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
                    {/* 左：素材导入 + 参数面板 */}
                    <div className="flex w-64 shrink-0 flex-col gap-2">
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
                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => { setClips((prev) => prev.filter((clip) => clip.id !== active.id)); setActiveId(""); }}>
                                        {t("canvas.videoEditor.remove")}
                                    </Button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* 右：播放器 + 多轨时间线 */}
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <div className="flex items-center gap-2 rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                            <Button size="small" icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={togglePlay} disabled={!totalSeconds}>
                                {playing ? t("canvas.videoEditor.pause") : t("canvas.videoEditor.play")}
                            </Button>
                            <span className="font-mono text-xs" style={{ color: theme.node.muted }}>
                                {playhead.toFixed(1)} / {totalSeconds.toFixed(1)}s
                            </span>
                            <div className="flex-1" />
                            <span className="truncate text-xs" style={{ color: theme.node.muted }}>
                                {currentClip ? currentClip.label : t("canvas.videoEditor.noFrame")}
                            </span>
                        </div>

                        <div className="min-h-0 flex-1 overflow-auto rounded-lg border p-2 thin-scrollbar" style={{ borderColor: theme.node.stroke }}>
                            {!clips.length ? (
                                <div className="flex h-40 items-center justify-center">
                                    <Empty description={t("canvas.videoEditor.noClips")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                                </div>
                            ) : (
                                <div style={{ width: Math.max(600, totalSeconds * PX_PER_SECOND + 120) }}>
                                    {/* 时间刻度 */}
                                    <div className="relative mb-1 h-4 border-b" style={{ borderColor: theme.node.stroke }}>
                                        {Array.from({ length: Math.ceil(totalSeconds) + 1 }, (_, second) => (
                                            <span key={second} className="absolute top-0 font-mono text-[10px]" style={{ left: second * PX_PER_SECOND, color: theme.node.muted }}>
                                                {second}s
                                            </span>
                                        ))}
                                    </div>
                                    {Array.from({ length: TRACK_COUNT }, (_, track) => (
                                        <div key={track} className="relative mb-1 h-9 rounded" style={{ background: `${theme.node.text}06`, border: `1px solid ${theme.node.stroke}` }}>
                                            <span className="absolute -left-0 top-1 text-[10px]" style={{ color: theme.node.muted }}>
                                                {t("canvas.videoEditor.trackN", { n: track + 1 })}
                                            </span>
                                            {clips
                                                .filter((clip) => clip.track === track)
                                                .map((clip) => {
                                                    const width = Math.max(24, (clip.outPoint - clip.inPoint) * PX_PER_SECOND);
                                                    const isActive = clip.id === activeId;
                                                    return (
                                                        <div
                                                            key={clip.id}
                                                            className="absolute top-1 flex h-7 cursor-pointer items-center gap-1 overflow-hidden rounded px-1.5 text-[11px]"
                                                            style={{
                                                                left: 24 + clip.start * PX_PER_SECOND,
                                                                width,
                                                                background: isActive ? "rgba(59,130,246,.85)" : "rgba(99,102,241,.55)",
                                                                color: "#fff",
                                                            }}
                                                            onClick={() => setActiveId(clip.id)}
                                                            title={`${clip.label} ${clip.inPoint.toFixed(1)}–${clip.outPoint.toFixed(1)}s`}
                                                        >
                                                            <GripVertical className="size-3 shrink-0 opacity-70" />
                                                            <span className="truncate">{clip.label}</span>
                                                        </div>
                                                    );
                                                })}
                                        </div>
                                    ))}
                                    {/* 播放头 */}
                                    <div className="relative h-0">
                                        <div
                                            className="absolute -top-[999px] w-px"
                                            style={{ left: 24 + playhead * PX_PER_SECOND, height: 999, background: "#ef4444" }}
                                        />
                                    </div>
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
                                icon={<Scissors className="size-3.5" />}
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
        </Modal>
    );
}