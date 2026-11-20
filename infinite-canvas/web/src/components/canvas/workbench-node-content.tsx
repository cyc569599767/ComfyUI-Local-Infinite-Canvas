import { useCallback, useMemo } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { Clapperboard, Film, Scissors, Scroll, Sparkles, User } from "lucide-react";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { StoryboardWorkbenchPanel } from "@/components/canvas/storyboard-workbench-panel";
import { DigitalHumanWorkbenchPanel, type DigitalHumanSegment } from "@/components/canvas/digital-human-workbench-panel";
import { VideoEditorWorkbenchPanel, type EditClip } from "@/components/canvas/video-editor-workbench-panel";
import { NovelWorkbenchPanel } from "@/components/canvas/novel-workbench-panel";
import { AgentCreationWorkbenchPanel, type AgentCreationInput } from "@/components/canvas/agent-creation-workbench-panel";
import { videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { buildMergePayload, collectTimelineSources, timelineSignature, type TimelineMergedVideo } from "@/lib/canvas/video-timeline";
import { LOCAL_GATEWAY_BASE_URL, LOCAL_GATEWAY_CHANNEL_ID, LOCAL_GATEWAY_MODELS } from "@/constant/app-mode";
import { encodeChannelModel, type AiConfig } from "@/stores/use-config-store";
import { createVideoMergeTask, storeGeneratedVideo, waitForVideoGenerationTask } from "@/services/api/video";
import type { StoryboardShot } from "@/services/api/storyboard";
import { CanvasNodeType, type CanvasNodeMetadata } from "@/types/canvas";
import { startCreationRun } from "@/lib/agent/creation-agent-runtime";
import { isProjectRunning, useCreationAgentStore } from "@/stores/use-creation-agent-store";
import { activePromptCloudApi, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

/** 合并进度用同一个 message key，成功/失败会替换掉那条常驻的 loading。 */
const MERGE_TOAST_KEY = "video-merge";

/**
 * 工作台种类。
 *
 * 三种工作台共用同一个节点类型（CanvasNodeType.Workbench），靠 metadata.workbenchKind
 * 区分。这样画布上只需要一个类型、一套尺寸/连接规则，新增工作台不用改节点体系；
 * 代价是面板分发必须显式做（见 WorkbenchPanelHost），漏了就会三个工作台共用同一个面板。
 */
export type WorkbenchKind = "storyboard" | "digital-human" | "video-editor" | "novel" | "agent-creation";

const KIND_META: Record<WorkbenchKind, { icon: typeof Clapperboard; color: string; titleKey: string; hintKey: string }> = {
    storyboard: { icon: Clapperboard, color: "#f472b6", titleKey: "canvas.workbench.storyboard", hintKey: "canvas.workbench.hint" },
    "digital-human": { icon: User, color: "#e879f9", titleKey: "canvas.workbench.digitalHuman", hintKey: "canvas.digitalHuman.nodeHint" },
    "video-editor": { icon: Scissors, color: "#22d3ee", titleKey: "canvas.workbench.videoEditor", hintKey: "canvas.videoEditor.nodeHint" },
    novel: { icon: Scroll, color: "#fbbf24", titleKey: "canvas.workbench.novel", hintKey: "canvas.novel.nodeHint" },
    "agent-creation": { icon: Sparkles, color: "#f0b35a", titleKey: "canvas.workbench.agentCreation", hintKey: "canvas.workbench.agentCreationNodeHint" },
};

export function readWorkbenchKind(metadata: CanvasNodeContext["node"]["metadata"]): WorkbenchKind {
    const kind = metadata?.workbenchKind;
    return kind === "digital-human" || kind === "video-editor" || kind === "novel" || kind === "agent-creation" ? kind : "storyboard";
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
    const bound = kind === "storyboard" ? Boolean(ctx.node.metadata?.storyboardProjectId) : kind === "agent-creation" ? Boolean(ctx.node.metadata?.agentCreation?.idea) : false;

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
                        {kind === "storyboard" ? (bound ? t("canvas.workbench.bound") : t("canvas.workbench.empty")) : kind === "agent-creation" ? (bound ? t("canvas.workbench.agentCreationStatus", { status: t(`canvas.workbench.agentCreationState.${ctx.node.metadata?.agentCreation?.status || "draft"}`) }) : t("canvas.workbench.agentCreationEmpty")) : t("canvas.workbench.localData")}
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
    if (kind === "novel") return <NovelPanelHost ctx={ctx} onClose={onClose} />;
    if (kind === "agent-creation") return <AgentCreationPanelHost ctx={ctx} onClose={onClose} />;
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
    const { t } = useTranslation();
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    // 合并只在本地网关实现：这里构造一份只含本地通道的配置，
    // 用户即使把视频模型切到云端，导出成片也不会把素材传到外部服务。
    // 只改 baseUrl 不够 —— 请求通道由 channels 解析，必须让本地通道也在里面。
    const localGatewayConfig = useMemo<AiConfig>(() => {
        const localModel = LOCAL_GATEWAY_MODELS.find((model) => model.capability === "video")?.name || "video-h3-t2v";
        const channel = {
            id: LOCAL_GATEWAY_CHANNEL_ID,
            name: "本地网关",
            baseUrl: LOCAL_GATEWAY_BASE_URL,
            apiKey: "local",
            apiFormat: "openai" as const,
            models: [{ name: localModel, capability: "video" as const }],
        };
        const model = encodeChannelModel(LOCAL_GATEWAY_CHANNEL_ID, localModel);
        return { ...effectiveConfig, baseUrl: LOCAL_GATEWAY_BASE_URL, apiKey: "local", apiFormat: "openai", channels: [channel], model, videoModel: model };
    }, [effectiveConfig]);
    // 画布上的视频卡就是时间线的素材来源：Agent/分镜/数字人出的片都落在画布上，
    // 打开剪辑台时自动铺好，用户不用再手抄 URL。
    const sources = useMemo(() => collectTimelineSources(ctx.getNodes().filter(node => node.metadata?.videoEditorOriginId !== ctx.node.id && !node.metadata?.editTimeline), ctx.node.id), [ctx]);
    const handleTimelineChange = useCallback((clips: EditClip[]) => {
        const latest = ctx.getNodes().find(node => node.id === ctx.node.id)?.metadata?.videoEditor;
        ctx.updateMetadata({ videoEditor: { ...latest, version: 1, clips } });
    }, [ctx]);
    const handleExport = useCallback(
        async (clips: EditClip[], totalSeconds: number) => {
            const liveNodes = ctx.getNodes();
            const stale = liveNodes.filter(n => n.metadata?.creationOutput?.revisionKind || n.metadata?.creationOutput?.needsRevision);
            if (clips.some(clip => stale.some(n => (clip.storageKey && clip.storageKey === n.metadata?.storageKey) || clip.url === n.metadata?.content)
                && !liveNodes.some(n => !n.metadata?.creationOutput?.revisionKind && !n.metadata?.creationOutput?.needsRevision && ((clip.storageKey && clip.storageKey === n.metadata?.storageKey) || clip.url === n.metadata?.content)))) throw new Error("时间线包含历史或失效版本，请移除旧片段并从画布重新导入新版后合成。");
            const payload = buildMergePayload(clips);
            if (!payload.sources.length) throw new Error(t("canvas.videoEditor.needClips"));
            if (!localGatewayConfig.baseUrl.trim()) throw new Error(t("canvas.videoEditor.gatewayRequired"));
            // Saving a draft is enough for recovery; do not duplicate every source
            // as extra canvas cards on each failed/repeated merge.
            const origin = ctx.node.position;
            const gapX = ctx.node.width + 60;
            const stamp = Date.now();
            const submittedSignature = timelineSignature(clips);
            message.loading({ content: t("canvas.videoEditor.merging"), key: MERGE_TOAST_KEY, duration: 0 });
            try {
                const task = await createVideoMergeTask(localGatewayConfig, {
                    clips: payload.clips,
                    sources: payload.sources,
                    totalSeconds: payload.totalSeconds,
                });
                const video = await storeGeneratedVideo(await waitForVideoGenerationTask(localGatewayConfig, task));
                const nodeId = `merged-${stamp}`;
                const merged: TimelineMergedVideo = { url: video.url, storageKey: video.storageKey, label: t("canvas.videoEditor.mergedTitle", { seconds: totalSeconds.toFixed(1) }), duration: video.durationMs ? video.durationMs / 1000 : totalSeconds, timelineSignature: submittedSignature, nodeId };
                const latest = ctx.getNodes().find(node => node.id === ctx.node.id)?.metadata?.videoEditor;
                ctx.applyOps([
                    { type: "update_node" as const, id: ctx.node.id, metadata: { videoEditor: { version: 1 as const, clips: latest?.clips || clips, merged } } },
                    {
                        type: "add_node" as const,
                        id: nodeId,
                        nodeType: CanvasNodeType.Video,
                        title: t("canvas.videoEditor.mergedTitle", { seconds: totalSeconds.toFixed(1) }),
                        position: { x: origin.x + gapX * 2, y: origin.y },
                        metadata: { ...videoMetadata(video), videoEditorOriginId: ctx.node.id, prompt: t("canvas.videoEditor.mergedPrompt", { count: clips.length }), editTimeline: { start: 0, inPoint: 0, outPoint: merged.duration, track: 0, volume: 1, totalSeconds: merged.duration } },
                    },
                    { type: "select_nodes" as const, ids: [nodeId] },
                ]);
                message.success({ content: t("canvas.videoEditor.merged"), key: MERGE_TOAST_KEY });
                return merged;
            } catch (error) {
                message.error({ content: error instanceof Error ? error.message : String(error), key: MERGE_TOAST_KEY });
                throw error;
            }
        },
        [ctx, localGatewayConfig, message, t],
    );

    return <VideoEditorWorkbenchPanel key={ctx.node.id} open nodeTitle={ctx.node.title} onClose={onClose} availableSources={sources} initialDraft={ctx.node.metadata?.videoEditor} onTimelineChange={handleTimelineChange} onExportTimeline={handleExport} />;
}
function AgentCreationPanelHost({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const current = ctx.node.metadata?.agentCreation;
    const title = ctx.node.title || "新故事";
    const defaultProject: NonNullable<CanvasNodeMetadata["agentCreation"]> = {
        idea: "",
        style: "",
        aspectRatio: "16:9",
        targetSeconds: 60,
        resolution: "768p",
        backgroundMusic: true,
        createImages: true,
        createVideos: true,
        status: "draft",
        progress: "",
        conversationId: "",
    };
    const updateProject = useCallback((patch: Partial<typeof defaultProject>) => {
        const latest = ctx.getNodes().find((node) => node.id === ctx.node.id)?.metadata?.agentCreation;
        const savedProject = { ...defaultProject, ...latest, ...patch };
        ctx.updateMetadata({ workbenchKind: "agent-creation", agentCreation: savedProject, ...(patch.progress !== undefined ? { agentCreationProgress: patch.progress } : {}) });
    }, [ctx, current]);
    /**
     * 启动创作 Agent。
     *
     * 和改造前的关键差别：这里不再往 useAgentStore 塞 canvasAgentSeed、也不再打开画布助手面板。
     * 创作任务走自己的引擎（creation-agent-runtime）和自己的会话（useCreationAgentStore），
     * 所以它跑长任务时用户仍可正常使用画布助手，反之亦然。
     * 两边唯一共享的是 promptCloudApis 那份模型配置。
     */
    const startAgent = useCallback((input: AgentCreationInput, continueExisting = false, userMessage?: string) => {
        const text = input.idea.trim();
        const chatMessage = userMessage?.trim();
        if (userMessage !== undefined && !chatMessage) throw new Error("请输入项目聊天消息。");
        if (!chatMessage && !text) throw new Error("请先输入故事想法或原文。");
        if (!activePromptCloudApi(useConfigStore.getState().config)) throw new Error("请先在设置中配置云端聊天模型。");
        if (isProjectRunning(ctx.node.id)) throw new Error("这个项目正在创作中；先停止或等它完成。");
        const seedId = `agent-creation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const conversationId = startCreationRun({
            seedId,
            projectNodeId: ctx.node.id,
            projectTitle: title,
            idea: text,
            style: input.style,
            aspectRatio: input.aspectRatio,
            targetSeconds: input.targetSeconds,
            resolution: input.resolution || "768p",
            backgroundMusic: input.backgroundMusic !== false,
            createImages: input.createImages,
            createVideos: input.createVideos,
            ...(chatMessage ? { userMessage: chatMessage } : {}),
            // 历史会话丢失也按续跑处理：先读画布产物，不要重新从零建卡。
            continueExisting,
            progress: useCreationAgentStore.getState().conversationFor(ctx.node.id)?.progress || current?.progress || "",
        });
        return conversationId;
    }, [ctx.node.id, title, current?.progress]);
    const bind = useCallback((projectTitle: string) => {
        if (projectTitle.trim() && projectTitle.trim() !== ctx.node.title) ctx.updateNode({ title: projectTitle.trim() });
    }, [ctx]);
    return (
        <AgentCreationWorkbenchPanel
            open
            nodeId={ctx.node.id}
            project={current}
            nodeTitle={title}
            onUpdateProject={updateProject}
            onStartAgent={startAgent}
            onContinueAgent={(input) => startAgent(input, true)}
            onSendMessage={(input, text) => startAgent(input, true, text)}
            onBind={bind}
            onClose={onClose}
        />
    );
}

function NovelPanelHost({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const handleProjectChange = useCallback(
        (id: string, name: string) => {
            ctx.updateMetadata({ workbenchKind: "novel", novelProjectId: id });
            if (name && ctx.node.title !== name) ctx.updateNode({ title: name });
        },
        [ctx],
    );

    return (
        <NovelWorkbenchPanel
            open
            projectId={ctx.node.metadata?.novelProjectId}
            nodeTitle={ctx.node.title}
            onClose={onClose}
            onProjectChange={handleProjectChange}
        />
    );
}
