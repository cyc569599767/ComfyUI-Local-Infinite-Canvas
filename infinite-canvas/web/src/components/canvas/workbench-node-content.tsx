import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Clapperboard, Film, Scissors, User } from "lucide-react";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { StoryboardWorkbenchPanel } from "@/components/canvas/storyboard-workbench-panel";
import { DigitalHumanWorkbenchPanel, type DigitalHumanSegment } from "@/components/canvas/digital-human-workbench-panel";
import { VideoEditorWorkbenchPanel, type EditClip } from "@/components/canvas/video-editor-workbench-panel";
import type { StoryboardShot } from "@/services/api/storyboard";
import { CanvasNodeType, type CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

/**
 * 工作台种类。
 *
 * 三种工作台共用同一个节点类型（CanvasNodeType.Workbench），靠 metadata.workbenchKind
 * 区分。这样画布上只需要一个类型、一套尺寸/连接规则，新增工作台不用改节点体系；
 * 代价是面板分发必须显式做（见 WorkbenchPanelHost），漏了就会三个工作台共用同一个面板。
 */
export type WorkbenchKind = "storyboard" | "digital-human" | "video-editor";

const KIND_META: Record<WorkbenchKind, { icon: typeof Clapperboard; color: string; titleKey: string; hintKey: string }> = {
    storyboard: { icon: Clapperboard, color: "#f472b6", titleKey: "canvas.workbench.storyboard", hintKey: "canvas.workbench.hint" },
    "digital-human": { icon: User, color: "#e879f9", titleKey: "canvas.workbench.digitalHuman", hintKey: "canvas.digitalHuman.nodeHint" },
    "video-editor": { icon: Scissors, color: "#22d3ee", titleKey: "canvas.workbench.videoEditor", hintKey: "canvas.videoEditor.nodeHint" },
};

export function readWorkbenchKind(metadata: CanvasNodeContext["node"]["metadata"]): WorkbenchKind {
    const kind = metadata?.workbenchKind;
    return kind === "digital-human" || kind === "video-editor" ? kind : "storyboard";
}

/**
 * 工作台卡片的正面。
 *
 * 卡片本身不放编辑器：这些面板都要整屏宽度，塞进 360px 的卡片里没法用。
 * 卡片只回答两件事——这是哪个工作台、绑定了什么数据，然后提示双击打开。
 */
export function WorkbenchNodeContent({ ctx }: { ctx: CanvasNodeContext }) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const kind = readWorkbenchKind(ctx.node.metadata);
    const meta = KIND_META[kind];
    const Icon = meta.icon;
    const bound = Boolean(ctx.node.metadata?.storyboardProjectId);

    return (
        <div
            className="flex h-full w-full flex-col justify-between gap-2 p-3"
            style={{ color: theme.node.text }}
            // 卡片内层的双击会盖住节点外层的判定，这里直接接管，
            // 否则点在标题文字上没反应，用户会以为面板坏了。
            onDoubleClick={(event) => {
                event.stopPropagation();
                ctx.openPanel();
            }}
        >
            <div className="flex items-center gap-2">
                <Icon className="size-4 shrink-0" style={{ color: meta.color }} />
                <span className="truncate text-sm font-medium">{t(meta.titleKey)}</span>
            </div>
            <div className="space-y-1 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                <div className="flex items-center gap-1.5">
                    <Film className="size-3 shrink-0" />
                    {/* 只有分镜导演台绑定网关项目；另外两个的工作数据存在节点 metadata 里。 */}
                    <span className="truncate">
                        {kind === "storyboard" ? (bound ? t("canvas.workbench.bound") : t("canvas.workbench.empty")) : t("canvas.workbench.localData")}
                    </span>
                </div>
                <div className="truncate">{t(meta.hintKey)}</div>
            </div>
        </div>
    );
}

/**
 * 把工作台面板挂到工作台节点上，按 workbenchKind 分发。
 *
 * 三种面板的 props 各不相同，这里做统一翻译：
 * 项目 id / 剪辑数据存进节点 metadata（跟着画布一起保存），
 * 生成请求转成画布操作。
 */
export function WorkbenchPanelHost({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const kind = readWorkbenchKind(ctx.node.metadata);
    if (kind === "digital-human") return <DigitalHumanPanelHost ctx={ctx} onClose={onClose} />;
    if (kind === "video-editor") return <VideoEditorPanelHost ctx={ctx} onClose={onClose} />;
    return <StoryboardPanelHost ctx={ctx} onClose={onClose} />;
}

function StoryboardPanelHost({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const projectId = ctx.node.metadata?.storyboardProjectId;

    const handleProjectChange = useCallback(
        (id: string, name: string) => {
            const patch: CanvasNodeMetadata = { workbenchKind: "storyboard", storyboardProjectId: id };
            ctx.updateMetadata(patch);
            // 节点标题跟着项目名走，画布上一眼能认出是哪个故事，
            // 而不是一排都叫「工作台」。
            if (name && ctx.node.title !== name) ctx.updateNode({ title: name });
        },
        [ctx],
    );

    const handleGenerateShots = useCallback(
        async (shots: StoryboardShot[]) => {
            if (!shots.length) return;
            // 每个分镜建一张图片卡并立刻生成：导演台负责编排，出图仍然走画布，
            // 这样结果能接参考图、能继续超分/插帧，不会被关在面板里。
            const origin = ctx.node.position;
            const gapX = ctx.node.width + 60;
            const ops = shots.flatMap((shot, index) => {
                const nodeId = `shot-${shot.id}-${Date.now()}-${index}`;
                const prompt = (shot.positive || shot.title || "").trim();
                return [
                    {
                        type: "add_node" as const,
                        id: nodeId,
                        nodeType: CanvasNodeType.Image,
                        title: shot.title || `#${index + 1}`,
                        position: { x: origin.x + gapX, y: origin.y + index * 300 },
                        metadata: { prompt, generationMode: "image" as const, status: "idle" as const },
                    },
                    { type: "run_generation" as const, nodeId, mode: "image" as const, prompt },
                ];
            });
            ctx.applyOps(ops);
        },
        [ctx],
    );

    return (
        <StoryboardWorkbenchPanel
            open
            projectId={projectId}
            nodeTitle={ctx.node.title}
            onClose={onClose}
            onProjectChange={handleProjectChange}
            onGenerateShots={handleGenerateShots}
        />
    );
}

function DigitalHumanPanelHost({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const handleGenerate = useCallback(
        async (segments: DigitalHumanSegment[]) => {
            if (!segments.length) return;
            // 数字人出的是视频：音频已经驱动了口型，所以这里建视频卡而不是图片卡。
            const origin = ctx.node.position;
            const gapX = ctx.node.width + 60;
            const ops = segments.flatMap((segment, index) => {
                const nodeId = `dh-${segment.id}-${Date.now()}-${index}`;
                const prompt = segment.text.trim();
                return [
                    {
                        type: "add_node" as const,
                        id: nodeId,
                        nodeType: CanvasNodeType.Video,
                        title: prompt ? prompt.slice(0, 20) : `#${index + 1}`,
                        position: { x: origin.x + gapX, y: origin.y + index * 280 },
                        metadata: {
                            prompt,
                            generationMode: "video" as const,
                            status: "idle" as const,
                            // 运镜与音频区间跟着卡片走，导出时需要，落在 metadata 里才不会丢。
                            digitalHumanSegment: {
                                start: segment.start,
                                end: segment.end,
                                camera: segment.camera,
                                reference: segment.reference,
                            },
                        },
                    },
                    { type: "run_generation" as const, nodeId, mode: "video" as const, prompt },
                ];
            });
            ctx.applyOps(ops);
        },
        [ctx],
    );

    return <DigitalHumanWorkbenchPanel open nodeTitle={ctx.node.title} onClose={onClose} onGenerateSegments={handleGenerate} />;
}

function VideoEditorPanelHost({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const handleExport = useCallback(
        async (clips: EditClip[], totalSeconds: number) => {
            // 时间线本身不产出媒体：导出时把片段按顺序建成视频卡，
            // 这样用户还能继续在画布上对单个片段做超分/插帧。
            const origin = ctx.node.position;
            const gapX = ctx.node.width + 60;
            const ops = clips.flatMap((clip, index) => {
                const nodeId = `cut-${clip.id}-${Date.now()}-${index}`;
                const metadata: CanvasNodeMetadata = {
                    prompt: clip.label,
                    generationMode: "video" as const,
                    status: "idle" as const,
                    content: clip.url,
                    editTimeline: { start: clip.start, inPoint: clip.inPoint, outPoint: clip.outPoint, track: clip.track, volume: clip.volume, totalSeconds },
                };
                return [
                  {
                      type: "add_node" as const,
                      id: nodeId,
                      nodeType: CanvasNodeType.Video,
                      title: clip.label,
                      position: { x: origin.x + gapX, y: origin.y + index * 280 },
                      metadata,
                  },
                ];
            });
            ctx.applyOps(ops);
        },
        [ctx],
    );

    return <VideoEditorWorkbenchPanel open nodeTitle={ctx.node.title} onClose={onClose} onExportTimeline={handleExport} />;
}