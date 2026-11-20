import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Segmented, Slider } from "antd";
import { Maximize, Pause, Play, RotateCcw } from "lucide-react";
import { resolveMediaUrl } from "@/services/file-storage";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { timelinePlaybackSegments, timelineSignature, type EditClip } from "@/lib/canvas/video-timeline";

type Mode = "clip" | "timeline";
type Props = {
    clips: EditClip[];
    activeId: string;
    selectionVersion?: number;
    seekRequest?: { time: number; nonce: number };
    onTimelineTime: (time: number) => void;
};

/** Media is the playback clock. Only deliberate black gaps use elapsed wall time. */
export function VideoEditorPreview({ clips, activeId, selectionVersion, seekRequest, onTimelineTime }: Props) {
    const theme = useCanvasTheme();
    const [mode, setMode] = useState<Mode>("clip");
    const [cursor, setCursor] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [error, setError] = useState("");
    const [resolved, setResolved] = useState({ key: "", url: "" });
    const [seekVersion, setSeekVersion] = useState(0);
    const gainRef = useRef<{ context: AudioContext; source: MediaElementAudioSourceNode; gain: GainNode; video: HTMLVideoElement } | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const playingRef = useRef(false);
    const cursorRef = useRef(0);
    const pendingSeek = useRef(false);
    const active = clips.find(clip => clip.id === activeId) || clips[0];
    const segments = useMemo(() => timelinePlaybackSegments(clips), [clips]);
    const timelineLength = segments.at(-1) ? segments.at(-1)!.start + segments.at(-1)!.duration : 0;
    const clipLength = active ? Math.max(0.04, active.outPoint - active.inPoint) : 0;
    const duration = mode === "clip" ? clipLength : timelineLength;
    const segment = mode === "timeline" ? segments.find(item => cursor >= item.start && cursor < item.start + item.duration) || (cursor >= timelineLength ? segments.at(-1) : undefined) : undefined;
    const source = mode === "clip" ? active : segment?.clip;
    const sourceKey = source ? `${mode}:${mode === "timeline" ? segment?.id : active?.id}:${source.storageKey || source.url}` : "";
    const mediaUrl = resolved.key === sourceKey ? resolved.url : "";
    const gap = mode === "timeline" && Boolean(segment && !segment.clip);
    const signature = useMemo(() => timelineSignature(clips), [clips]);
    const latest = useRef({ mode, active, segment, sourceKey, duration, gap, mediaUrl });
    latest.current = { mode, active, segment, sourceKey, duration, gap, mediaUrl };

    const pause = useCallback(() => {
        playingRef.current = false;
        setPlaying(false);
        videoRef.current?.pause();
    }, []);
    const moveCursor = useCallback((time: number) => { cursorRef.current = time; setCursor(time); }, []);
    const seek = useCallback((time: number) => {
        pendingSeek.current = true;
        moveCursor(Math.max(0, Math.min(time, latest.current.duration)));
        setSeekVersion(value => value + 1);
    }, [moveCursor]);
    const switchMode = (value: Mode) => { pause(); setMode(value); moveCursor(0); setError(""); setSeekVersion(value => value + 1); };

    useEffect(() => { pause(); setMode("clip"); moveCursor(0); setError(""); setSeekVersion(value => value + 1); }, [activeId, selectionVersion, pause, moveCursor]);
    // Edits invalidate the old playback cursor.
    useEffect(() => { pause(); moveCursor(0); setSeekVersion(value => value + 1); }, [signature, pause, moveCursor]);
    useEffect(() => {
        if (!seekRequest) return;
        pause(); setMode("timeline"); moveCursor(Math.max(0, Math.min(seekRequest.time, timelineLength))); setSeekVersion(value => value + 1);
    }, [seekRequest, timelineLength, pause, moveCursor]);
    useEffect(() => {
        if (mode === "clip" && active) onTimelineTime(active.start + cursor);
        else if (mode === "timeline") onTimelineTime(cursor);
    }, [mode, active?.start, cursor, segment, onTimelineTime]);

    useEffect(() => {
        let canceled = false;
        setError("");
        if (!source) { setResolved({ key: sourceKey, url: "" }); return; }
        void resolveMediaUrl(source.storageKey, source.url).then(url => {
            if (!canceled) {
                setResolved({ key: sourceKey, url });
                if (!url) { setError("素材不可用，请从画布重新导入。"); pause(); }
            }
        }).catch(() => { if (!canceled) { setError("读取素材失败，请检查本地素材库或视频地址。"); pause(); } });
        return () => { canceled = true; };
        // Shared storage URLs belong to file-storage, not to this player.
    }, [sourceKey, source?.storageKey, source?.url, pause]);

    const startMedia = useCallback(() => {
        const video = videoRef.current;
        if (!video || !latest.current.mediaUrl || !playingRef.current) return;
        const current = latest.current.mode === "clip" ? latest.current.active : latest.current.segment?.clip;
        const volume = Math.max(0, Math.min(2, current?.volume ?? 1));
        // Boost above 100% only for locally stored blobs; remote videos may lack
        // audio CORS permission. Normal volume never needs a WebAudio graph.
        if (volume > 1 && video.src.startsWith("blob:") && typeof AudioContext !== "undefined") {
            try {
                if (gainRef.current?.video !== video) {
                    void gainRef.current?.context.close();
                    const context = new AudioContext();
                    const source = context.createMediaElementSource(video);
                    const gain = context.createGain(); source.connect(gain); gain.connect(context.destination);
                    gainRef.current = { context, source, gain, video };
                }
                gainRef.current.gain.gain.value = volume;
                video.volume = 1;
                void gainRef.current.context.resume().catch(() => {});
            } catch { video.volume = 1; }
        }
        const sourceAtPlay = latest.current.sourceKey;
        void video.play().catch(cause => {
            if (cause?.name === "AbortError" || !playingRef.current || sourceAtPlay !== latest.current.sourceKey) return;
            setError(cause?.name === "NotAllowedError" ? "浏览器阻止了自动续播，请再次点击播放。" : "视频无法播放，请检查素材格式或地址。");
            pause();
        });
    }, [pause]);
    const syncMedia = useCallback(() => {
        const video = videoRef.current;
        if (!video || video.readyState < 1) return;
        const state = latest.current;
        const current = state.mode === "clip" ? state.active : state.segment?.clip;
        const wanted = (current?.inPoint || 0) + cursorRef.current - (state.mode === "timeline" ? current?.start || 0 : 0);
        const bounded = Math.max(0, Math.min(wanted, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : wanted));
        if (Math.abs(video.currentTime - bounded) > 0.03) video.currentTime = bounded;
        const volume = Math.max(0, Math.min(2, current?.volume ?? 1));
        if (gainRef.current?.video === video) { gainRef.current.gain.gain.value = volume; video.volume = 1; }
        else video.volume = Math.min(1, volume);
        startMedia();
    }, [startMedia]);
    useEffect(() => { syncMedia(); if (mediaUrl || gap) pendingSeek.current = false; }, [mediaUrl, sourceKey, seekVersion, gap, syncMedia]);
    useEffect(() => {
        return () => { if (gainRef.current) { void gainRef.current.context.close().catch(() => {}); gainRef.current = null; } };
    }, [sourceKey]);
    useEffect(() => {
        playingRef.current = playing;
        if (playing) startMedia(); else videoRef.current?.pause();
    }, [playing, mediaUrl, startMedia]);
    useEffect(() => {
        if (!playing) return;
        let frame = 0; let last = performance.now();
        const tick = (now: number) => {
            const state = latest.current;
            const video = videoRef.current;
            if (pendingSeek.current) { last = now; frame = requestAnimationFrame(tick); return; }
            let time = cursorRef.current;
            if (state.gap) time += Math.min((now - last) / 1000, 0.25);
            else if (video && state.mediaUrl && video.readyState >= 2 && !video.seeking) {
                const current = state.mode === "clip" ? state.active : state.segment?.clip;
                time = video.currentTime - (current?.inPoint || 0) + (state.mode === "timeline" ? current?.start || 0 : 0);
                const end = state.mode === "timeline" ? (state.segment?.start || 0) + (state.segment?.duration || 0) : state.duration;
                if (video.ended || time >= end - 0.015) time = end;
            }
            last = now;
            if (state.mode === "timeline" && state.segment && time >= state.segment.start + state.segment.duration) {
                video?.pause();
                time = state.segment.start + state.segment.duration;
            }
            moveCursor(Math.min(state.duration, Math.max(0, time)));
            if (time >= state.duration) { pause(); return; }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [playing, moveCursor, pause]);
    useEffect(() => () => { playingRef.current = false; videoRef.current?.pause(); void gainRef.current?.context.close(); }, []);

    const toggle = () => {
        if (playingRef.current) { pause(); return; }
        setError("");
        if (cursorRef.current >= duration - 0.015) seek(0);
        playingRef.current = true; setPlaying(true);
    };
    return <section data-video-editor-preview data-preview-mode={mode} className="shrink-0 rounded-xl border p-3" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <Segmented size="small" value={mode} onChange={value => switchMode(value as Mode)} options={[{ label: "单镜头预览", value: "clip" }, { label: "时间线预览", value: "timeline" }]} />
            <span className="min-w-0 max-w-[45%] truncate text-xs" title={source?.label} style={{ color: theme.node.muted }}>{gap ? "时间线空隙 · 黑场" : source?.label || "请选择一个片段"}</span>
        </div>
        <div className="relative flex items-center justify-center overflow-hidden rounded-lg" style={{ height: "clamp(150px, 29vh, 340px)", background: gap ? "#000" : theme.node.panel }}>
            {mediaUrl && !gap ? <video key={sourceKey} ref={videoRef} data-editor-player src={mediaUrl} preload="auto" playsInline className="h-full w-full object-contain" onLoadedMetadata={syncMedia} onCanPlay={startMedia} onError={() => { setError("视频加载失败。请检查素材是否仍在本地素材库中，或重新导入视频。"); pause(); }} /> : <span className="text-xs" style={{ color: gap ? "#f5f5f5" : theme.node.muted }}>{gap ? "黑场（与合成结果一致）" : source ? "正在载入视频…" : "导入视频后即可预览"}</span>}
            {error && <div role="alert" className="absolute inset-x-3 bottom-3 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">{error}</div>}
        </div>
        <div className="mt-2 flex items-center gap-2">
            <Button size="small" aria-label={playing ? "暂停预览" : "播放预览"} icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} disabled={!duration || (!mediaUrl && !gap)} onClick={toggle}>{playing ? "暂停" : "播放"}</Button>
            <Button size="small" aria-label="从头预览" icon={<RotateCcw className="size-3.5" />} disabled={!duration} onClick={() => seek(0)} />
            <Slider className="!my-1 !mx-2 min-w-12 flex-1" aria-label="预览进度" min={0} max={Math.max(0.01, duration)} step={0.01} value={cursor} onChange={seek} tooltip={{ formatter: value => `${Number(value).toFixed(2)}s` }} />
            <span data-preview-time className="shrink-0 font-mono text-[11px]" style={{ color: theme.node.muted }}>{cursor.toFixed(1)} / {duration.toFixed(1)}s</span>
            <Button size="small" aria-label="全屏预览" icon={<Maximize className="size-3.5" />} disabled={!mediaUrl} onClick={() => { void videoRef.current?.requestFullscreen().catch(() => {}); }} />
        </div>
        {(mode === "clip" ? active?.volume : segment?.clip?.volume || 0)! > 1 && mediaUrl && !mediaUrl.startsWith("blob:") && <p className="mt-1 text-[10px]" style={{ color: theme.node.muted }}>外链素材预览音量最多 100%；增益会在最终成片中生效。</p>}
        <p className="mt-1 text-[10px]" style={{ color: theme.node.muted }}>{mode === "clip" ? "按当前入点 / 出点播放所选镜头；不改动原文件。" : "重叠时上方轨道优先；同轨后放入的镜头在上层。声音跟随可见镜头，下层恢复时从对应时间继续。"}</p>
    </section>;
}
