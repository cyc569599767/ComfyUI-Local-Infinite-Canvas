import { useEffect, useId, useRef, useState } from "react";
import { App, Button, Empty, Input, InputNumber, Modal, Select, Switch, Tag, Tooltip } from "antd";
import { ArrowRight, BookOpen, Bot, LayoutGrid, Loader2, Play, Save, Send, Sparkles, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AgentChatMessage } from "@/components/agent/agent-chat-message";
import { CREATION_RESOLUTIONS, CREATION_STYLE_GROUPS, normalizeCreationResolution } from "@/lib/agent/creation-settings";
import { CreationPipelinePanel } from "@/components/canvas/creation-pipeline-panel";
import { CreationOutputReviewPanel } from "@/components/canvas/creation-output-review-panel";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { activePromptCloudApi, useEffectiveConfig } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCreationAgentStore } from "@/stores/use-creation-agent-store";
import { resolveCreationApproval, stopCreationRun } from "@/lib/agent/creation-agent-runtime";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type AgentCreationProject = NonNullable<CanvasNodeMetadata["agentCreation"]>;
export type AgentCreationInput = Pick<AgentCreationProject, "idea" | "style" | "aspectRatio" | "targetSeconds" | "resolution" | "backgroundMusic" | "createImages" | "createVideos">;
const projectChatDrafts = new Map<string, string>();
type Props = {
    open: boolean; nodeId: string; nodeTitle: string; project?: AgentCreationProject;
    onUpdateProject: (patch: Partial<AgentCreationProject>) => void;
    onStartAgent: (input: AgentCreationInput) => string;
    onContinueAgent: (input: AgentCreationInput) => string;
    onSendMessage: (input: AgentCreationInput, text: string) => string;
    onBind: (name: string) => void;
    onClose: () => void;
};

function hasLoadingCreationMedia(nodes: CanvasNodeData[], projectNodeId: string) {
    return nodes.some((node) => (node.metadata?.creationOutput?.projectNodeId === projectNodeId || node.id === `${projectNodeId}-editor`)
        && (node.metadata?.status === "loading" || node.metadata?.images?.some((image) => image.status === "loading")));
}

/** 工作台只观察独立创作会话，进度由执行引擎保存，不依赖弹窗轮询。 */
export function AgentCreationWorkbenchPanel({ open, nodeId, nodeTitle, project, onUpdateProject, onStartAgent, onContinueAgent, onSendMessage, onBind, onClose }: Props) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const fieldId = useId();
    const [idea, setIdea] = useState(project?.idea || "");
    const [style, setStyle] = useState(project?.style || "");
    const [aspectRatio, setAspectRatio] = useState<AgentCreationProject["aspectRatio"]>(project?.aspectRatio || "16:9");
    const [targetSeconds, setTargetSeconds] = useState(project?.targetSeconds || 60);
    const [resolution, setResolution] = useState<NonNullable<AgentCreationProject["resolution"]>>(normalizeCreationResolution(project?.resolution));
    const [backgroundMusic, setBackgroundMusic] = useState(project?.backgroundMusic !== false);
    const [createImages, setCreateImages] = useState(project?.createImages !== false);
    const [createVideos, setCreateVideos] = useState(project?.createVideos !== false);
    const [chatDraft, setChatDraft] = useState(() => ({ nodeId, text: projectChatDrafts.get(nodeId) || "" }));
    const chatText = chatDraft.nodeId === nodeId ? chatDraft.text : projectChatDrafts.get(nodeId) || "";
    const isComposing = useRef(false);
    const updateChatDraft = (text: string) => {
        if (text) projectChatDrafts.set(nodeId, text);
        else projectChatDrafts.delete(nodeId);
        setChatDraft({ nodeId, text });
    };
    const run = useCreationAgentStore((state) => state.runs[nodeId]);
    const hydrated = useCreationAgentStore((state) => state.hydrated);
    const isRunning = Boolean(run);
    const hasPendingRevision = useAgentStore(state => Boolean(state.canvasContext?.snapshot.nodes.find(n => n.id === nodeId)?.metadata?.creationPipeline?.review));
    const hasWorkbench = useAgentStore((state) => Boolean(state.canvasContext?.snapshot.nodes.some((node) => node.id === nodeId && node.type === "workbench" && node.metadata?.workbenchKind === "agent-creation")));
    const hasLoadingMedia = useAgentStore((state) => hasLoadingCreationMedia(state.canvasContext?.snapshot.nodes || [], nodeId));
    const layoutDisabledReason = !hydrated ? "正在加载创作状态，请稍后整理。" : !hasWorkbench ? "当前画布中找不到此创作工作台，请返回所属画布。" : isRunning ? "本项目正在创作，请等待运行结束后整理。" : hasLoadingMedia ? "本项目仍有媒体正在生成，请等待生成结束后整理。" : "";
    const conversation = useCreationAgentStore((state) => state.conversations.find((item) => item.projectNodeId === nodeId) || null);
    const confirmBeforeApply = useCreationAgentStore((state) => state.confirmBeforeApply);
    const setConfirmBeforeApply = useCreationAgentStore((state) => state.setConfirmBeforeApply);
    const modelLabel = activePromptCloudApi(config)?.model || t("agent.cloud.notConfigured");
    const interrupted = !isRunning && (conversation?.status || project?.status) === "running";
    const status = isRunning ? "running" : interrupted ? "error" : conversation?.status || project?.status || "draft";
    const progress = conversation?.progress || project?.progress;
    const lastError = interrupted ? t("canvas.workbench.agentCreationInterrupted") : conversation ? conversation.lastError : project?.lastError;
    const historyRef = useRef<HTMLDivElement>(null);
    const followHistory = useRef(true);
    useEffect(() => {
        followHistory.current = true;
        isComposing.current = false;
    }, [nodeId, open]);
    useEffect(() => {
        if (followHistory.current && historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }, [conversation?.messages, nodeId, open]);
    useEffect(() => {
        if (!open) return;
        setIdea(project?.idea || ""); setStyle(project?.style || "");
        setAspectRatio(project?.aspectRatio || "16:9"); setTargetSeconds(project?.targetSeconds || 60);
        setResolution(normalizeCreationResolution(project?.resolution)); setBackgroundMusic(project?.backgroundMusic !== false);
        setCreateImages(project?.createImages !== false); setCreateVideos(project?.createVideos !== false);
    }, [open, nodeId, project?.idea, project?.style, project?.aspectRatio, project?.targetSeconds, project?.resolution, project?.backgroundMusic, project?.createImages, project?.createVideos]);
    const input = (): AgentCreationInput => ({ idea: idea.trim(), style: style === "__custom__" ? "" : style.trim(), aspectRatio, targetSeconds: Math.min(600, Math.max(5, Number(targetSeconds) || 60)), resolution, backgroundMusic, createImages, createVideos });
    const saveDraft = () => {
        if (isRunning || !hydrated) return;
        onUpdateProject(input());
        message.success(t("canvas.workbench.saved"));
    };
    const sendMessage = () => {
        const text = chatText.trim();
        if (!text || isRunning || !hydrated || isComposing.current) return;
        try {
            if (!onSendMessage(input(), text)) return;
            followHistory.current = true;
            updateChatDraft("");
        } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
    };
    const start = (resume: boolean) => {
        if (isRunning || !hydrated) return;
        if (!idea.trim()) return void message.warning(t("canvas.workbench.agentCreationStoryRequired"));
        try {
            (resume ? onContinueAgent : onStartAgent)(input());
            followHistory.current = true;
            message.success(t("canvas.workbench.agentCreationStarted"));
        } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
    };
    const organizeOutputs = () => {
        const ctx = useAgentStore.getState().canvasContext;
        if (!ctx?.snapshot.nodes.some((node) => node.id === nodeId && node.type === "workbench" && node.metadata?.workbenchKind === "agent-creation")) return void message.warning("当前画布中找不到此创作工作台，请返回所属画布。");
        const creationState = useCreationAgentStore.getState();
        if (!creationState.hydrated) return void message.warning("正在加载创作状态，请稍后整理。");
        if (creationState.runs[nodeId]) return void message.warning("本项目正在创作，请等待运行结束后整理。");
        if (hasLoadingCreationMedia(ctx.snapshot.nodes, nodeId)) return void message.warning("本项目仍有媒体正在生成，请等待生成结束后整理。");
        try {
            ctx.applyOps([{ type: "layout_creation", projectNodeId: nodeId }]);
            message.success("已整理本项目产物：阶段从上到下，每行最多 4 张从左到右平铺；其他项目不动。");
        } catch (error) { message.error(`整理失败：${error instanceof Error ? error.message : String(error)}`); }
    };
    const muted = { color: theme.node.muted };
    const panel = { borderColor: theme.node.stroke, background: theme.node.panel };
    return (
        <Modal open={open} onCancel={onClose} footer={null} width="min(1100px, 96vw)" centered destroyOnHidden
            title={<span className="flex flex-wrap items-center gap-2"><Sparkles className="size-4" style={{ color: "#d39136" }} />{t("canvas.workbench.agentCreation")}<Tag>{nodeTitle}</Tag><Tag color={status === "running" ? "processing" : status === "ready" ? "success" : status === "error" ? "error" : "default"}>{t(`canvas.workbench.agentCreationState.${status}`)}</Tag></span>}>
            <div className="thin-scrollbar max-h-[80vh] space-y-3 overflow-y-auto px-1 pb-2" style={{ color: theme.node.text }}>
                <div className="flex flex-wrap items-start gap-3 rounded-xl border p-3" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>
                    <BookOpen className="mt-1 size-5 shrink-0" style={{ color: "#d39136" }} />
                    <div className="min-w-0 flex-1"><div className="text-sm font-medium">{t("canvas.workbench.agentCreationOverview")}</div><div className="mt-1 text-xs leading-5" style={muted}>{t("canvas.workbench.agentCreationOverviewDescription")}</div></div>
                    <Tooltip title={t("canvas.workbench.agentCreationModelHint")}><Tag className="max-w-[260px] truncate">{modelLabel}</Tag></Tooltip>
                </div>
                <CreationPipelinePanel nodeId={nodeId} disabled={isRunning} />
                <CreationOutputReviewPanel nodeId={nodeId} />
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_288px]">
                    <div className="space-y-3">
                        <section className="space-y-2 rounded-xl border p-3" style={panel}>
                            <label htmlFor={`${fieldId}-idea`} className="block text-xs font-medium">{t("canvas.workbench.agentCreationIdea")}</label>
                            <Input.TextArea id={`${fieldId}-idea`} aria-label={t("canvas.workbench.agentCreationIdea")} aria-describedby={`${fieldId}-idea-hint`} disabled={isRunning} value={idea} onChange={(event) => setIdea(event.target.value)} autoSize={{ minRows: 4, maxRows: 8 }} maxLength={60000} placeholder={t("canvas.workbench.agentCreationIdeaPlaceholder")} showCount />
                            <p id={`${fieldId}-idea-hint`} className="pt-1 text-[11px] leading-5" style={muted}>{t("canvas.workbench.agentCreationIdeaHint")}</p>
                        </section>
                        <section className="overflow-hidden rounded-xl border" style={panel}>
                            <div className="p-3">
                                <div className="mb-2 flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-sm font-medium"><Bot className="size-4" />{t("canvas.workbench.agentCreationHistory")}</span>{run ? <Tag color="processing">{t("canvas.workbench.agentCreationStep", { step: run.step })}</Tag> : null}</div>
                                <div ref={historyRef} className="thin-scrollbar h-[270px] space-y-3 overflow-auto break-words pr-1" onScroll={() => { const el = historyRef.current; if (el) followHistory.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
                                    {conversation?.messages.length ? conversation.messages.map((item) => <AgentChatMessage key={item.id} item={item} theme={theme} />) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.workbench.agentCreationHistoryEmpty")} />}
                                </div>
                            </div>
                            <div className="space-y-2 border-t p-3" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                                <label htmlFor={`${fieldId}-chat`} className="block text-xs font-medium">{t("canvas.workbench.agentCreationChatInput")}</label>
                                <Input.TextArea key={nodeId} id={`${fieldId}-chat`} aria-label={t("canvas.workbench.agentCreationChatInput")} aria-describedby={`${fieldId}-chat-status ${fieldId}-chat-shortcut`} value={chatText} onChange={(event) => updateChatDraft(event.target.value)} autoSize={{ minRows: 2, maxRows: 6 }} maxLength={60000} placeholder={t("canvas.workbench.agentCreationChatPlaceholder")}
                                    onCompositionStart={() => { isComposing.current = true; }} onCompositionEnd={() => { isComposing.current = false; }}
                                    onKeyDown={(event) => {
                                        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || isComposing.current) return;
                                        event.preventDefault();
                                        sendMessage();
                                    }} />
                                <div className="flex items-end justify-between gap-3">
                                    <div className="text-[11px] leading-5" style={muted}>
                                        <p id={`${fieldId}-chat-status`} role="status">{t(!hydrated ? "canvas.workbench.agentCreationChatLoading" : isRunning ? "canvas.workbench.agentCreationChatRunning" : "canvas.workbench.agentCreationChatReady")}</p>
                                        <p id={`${fieldId}-chat-shortcut`}>{t("canvas.workbench.agentCreationChatShortcut")}</p>
                                    </div>
                                    <Button type="primary" aria-label={t("canvas.workbench.agentCreationChatSend")} disabled={isRunning || !hydrated || !chatText.trim()} icon={<Send className="size-4" />} onClick={sendMessage}>{t("canvas.workbench.agentCreationChatSend")}</Button>
                                </div>
                            </div>
                        </section>
                    </div>
                    <div className="space-y-3">
                        <fieldset disabled={isRunning} className="space-y-2.5 rounded-xl border p-3" style={panel}>
                            <div className="flex items-center gap-1.5 text-xs font-semibold"><Play className="size-3.5" />{t("canvas.workbench.agentCreationSettings")}</div>
                            <div><label htmlFor={`${fieldId}-name`} className="mb-1 block text-[11px]" style={muted}>{t("canvas.workbench.agentCreationName")}</label><Input id={`${fieldId}-name`} aria-label={t("canvas.workbench.agentCreationName")} disabled={isRunning} size="small" value={nodeTitle} maxLength={80} onChange={(event) => onBind(event.target.value)} /></div>
                            <div><label htmlFor={`${fieldId}-style`} className="mb-1 block text-[11px]" style={muted}>画面风格</label><Select id={`${fieldId}-style`} aria-label="画面风格" disabled={isRunning} size="small" className="w-full" allowClear showSearch optionFilterProp="label" value={style || undefined} placeholder="留空，由 Agent 根据故事推断" onChange={(value) => setStyle(value || "")} options={[
                                ...CREATION_STYLE_GROUPS.map((group) => ({ label: group.label, options: group.styles.map((value) => ({ value, label: value })) })),
                                { label: "自定义", options: [{ value: "__custom__", label: "自定义风格" }, ...(style && !CREATION_STYLE_GROUPS.some((group) => (group.styles as readonly string[]).includes(style)) && style !== "__custom__" ? [{ value: style, label: style }] : [])] },
                            ]} />{style === "__custom__" || (style && !CREATION_STYLE_GROUPS.some((group) => (group.styles as readonly string[]).includes(style))) ? <Input className="mt-1" aria-label="自定义画面风格" value={style === "__custom__" ? "" : style} disabled={isRunning} placeholder="输入自定义画面风格" maxLength={1200} onChange={(event) => setStyle(event.target.value || "__custom__")} /> : null}<p className="mt-1 text-[11px] leading-5" style={muted}>沿用参考项目风格列表；留空时由 Agent 推断并在后续素材中保持一致。</p></div>
                            <div className="flex gap-2">
                                <div className="min-w-0 flex-1"><label htmlFor={`${fieldId}-aspect`} className="mb-1 block text-[11px]" style={muted}>{t("canvas.workbench.agentCreationAspect")}</label><Select id={`${fieldId}-aspect`} aria-label={t("canvas.workbench.agentCreationAspect")} disabled={isRunning} size="small" className="w-full" value={aspectRatio} options={["16:9", "9:16", "1:1"].map((value) => ({ value, label: value }))} onChange={setAspectRatio} /></div>
                                <div className="min-w-0 flex-1"><label htmlFor={`${fieldId}-duration`} className="mb-1 block text-[11px]" style={muted}>{t("canvas.workbench.agentCreationDuration")}</label><InputNumber id={`${fieldId}-duration`} aria-label={t("canvas.workbench.agentCreationDuration")} disabled={isRunning} size="small" className="w-full" min={5} max={600} value={targetSeconds} onChange={(value) => setTargetSeconds(Number(value) || 60)} /></div>
                            </div>
                            <div><label htmlFor={`${fieldId}-resolution`} className="mb-1 block text-[11px]" style={muted}>{t("canvas.workbench.agentCreationResolution")}</label><Select id={`${fieldId}-resolution`} aria-label={t("canvas.workbench.agentCreationResolution")} disabled={isRunning} size="small" className="w-full" value={resolution} options={CREATION_RESOLUTIONS.map((value) => ({ value, label: value.toUpperCase() }))} onChange={setResolution} /></div>
                            <div>
                                <div className="flex items-center justify-between gap-2 text-xs"><label htmlFor={`${fieldId}-bgm`}>{t("canvas.workbench.agentCreationBackgroundMusic")}</label><Switch id={`${fieldId}-bgm`} aria-label={t("canvas.workbench.agentCreationBackgroundMusic")} aria-describedby={`${fieldId}-bgm-hint`} size="small" checked={backgroundMusic} onChange={setBackgroundMusic} disabled={isRunning} /></div>
                                <p id={`${fieldId}-bgm-hint`} className="mt-1 text-[11px] leading-5" style={muted}>{t("canvas.workbench.agentCreationBackgroundMusicHint")}</p>
                            </div>
                            <p className="text-[11px] leading-5" style={muted}>{t("canvas.workbench.agentCreationMediaSettingsHint")}</p>
                            <label htmlFor={`${fieldId}-images`} className="flex items-start gap-2 text-xs leading-5"><input id={`${fieldId}-images`} aria-label={t("canvas.workbench.agentCreationIncludeImages")} type="checkbox" className="mt-1" checked={createImages} onChange={(event) => setCreateImages(event.target.checked)} /><span>{t("canvas.workbench.agentCreationIncludeImages")}<span className="mt-0.5 block text-[11px]" style={muted}>{t("canvas.workbench.agentCreationIncludeImagesHint")}</span></span></label>
                            <label htmlFor={`${fieldId}-videos`} className="flex items-start gap-2 text-xs leading-5"><input id={`${fieldId}-videos`} aria-label={t("canvas.workbench.agentCreationIncludeVideos")} type="checkbox" className="mt-1" checked={createVideos} onChange={(event) => setCreateVideos(event.target.checked)} /><span>{t("canvas.workbench.agentCreationIncludeVideos")}<span className="mt-0.5 block text-[11px]" style={muted}>{t("canvas.workbench.agentCreationIncludeVideosHint")}</span></span></label>
                        </fieldset>
                        <div className="rounded-xl border p-3" style={panel}>
                            <div className="text-xs font-semibold">{t("canvas.workbench.agentCreationAgentSettings")}</div>
                            <div className="mt-2 flex justify-between gap-2 text-xs"><span>{t("canvas.workbench.agentCreationConfirmLabel")}</span><Switch aria-label={t("canvas.workbench.agentCreationConfirmLabel")} size="small" checked={confirmBeforeApply} onChange={setConfirmBeforeApply} disabled={isRunning} /></div>
                            <div className="mt-1 text-[11px] leading-5" style={muted}>{t("canvas.workbench.agentCreationConfirmHint")}</div>
                            <div className="mt-2 text-[11px] leading-5" style={muted}>{t("canvas.workbench.agentCreationRuntimeHint")}</div>
                        </div>
                    </div>
                </div>
                {run?.pendingApproval ? <div className="rounded-xl border p-3" style={{ borderColor: "#d3913680", background: "#d3913614" }}>
                    <div className="text-xs font-medium">{t("canvas.workbench.agentCreationApprovalTitle")}</div>
                    <div className="mt-1 whitespace-pre-wrap text-xs" style={muted}>{run.pendingApproval.summary}</div>
                    <div className="mt-2 flex justify-end gap-2"><Button size="small" onClick={() => resolveCreationApproval(nodeId, false)}>{t("canvas.workbench.agentCreationReject")}</Button><Button size="small" type="primary" onClick={() => resolveCreationApproval(nodeId, true)}>{t("canvas.workbench.agentCreationApprove")}</Button></div>
                </div> : null}
                <section className="rounded-xl border p-3" style={panel}>
                    <div className="mb-2 flex items-center justify-between gap-2"><span className="text-xs font-medium">{t("canvas.workbench.agentCreationProgressTitle")}</span>{isRunning ? <Loader2 className="size-4 animate-spin" /> : null}</div>
                    <p data-creation-auto-progress className="mb-2 text-[11px] leading-5" style={muted}>{run?.phase === "waiting_media" ? "等待媒体结果，完成后自动推进；期间不重复请求云模型。点击停止可取消后续自动推进。" : "启动一次后按阶段自动推进，无需逐阶段发送继续。生成失败、审批或候选待确认时暂停；退出应用、刷新或切换画布后需手动恢复。"}</p>
                    {lastError ? <div className="mb-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">{lastError}</div> : null}
                    <div className="thin-scrollbar max-h-28 overflow-auto whitespace-pre-wrap break-words text-xs leading-5" style={muted}>{progress || t("canvas.workbench.agentCreationNoProgress")}</div>
                </section>
                <div className="rounded-xl border px-3 py-2 text-[11px] leading-5" style={panel}>
                    <p style={muted}>画布产物按 01–12 阶段从上到下排列，每行最多 4 张从左到右平铺；「整理产物」仅调整本项目，不移动其他项目。</p>
                    <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1" aria-label="创作连线图例">
                        <span className="inline-flex items-center gap-1.5" style={muted}><svg width="32" height="12" viewBox="0 0 32 12" aria-hidden="true"><path d="M 1 6 H 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4" strokeOpacity="0.55" /><path d="M 23 2 L 28 6 L 23 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.55" /></svg>虚线：流程顺序，不作为生成参考</span>
                        <span className="inline-flex items-center gap-1.5"><svg width="32" height="12" viewBox="0 0 32 12" aria-hidden="true"><path d="M 1 6 H 28 M 23 2 L 28 6 L 23 10" fill="none" stroke="currentColor" strokeWidth="2" /></svg>实线：真实参考，箭头指向使用方</span>
                    </div>
                    {layoutDisabledReason ? <p className="mt-1" role="status" style={muted}>{layoutDisabledReason}</p> : null}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                    <Tooltip title={layoutDisabledReason || "按阶段纵向、每行最多 4 张横向整理，仅影响本项目。"}><span className="inline-flex"><Button aria-label="按阶段整理产物" disabled={Boolean(layoutDisabledReason)} icon={<LayoutGrid className="size-4" />} onClick={organizeOutputs}>整理产物</Button></span></Tooltip>
                    <Button disabled={isRunning || !hydrated} icon={<Save className="size-4" />} onClick={saveDraft}>{t("canvas.workbench.agentCreationSaveDraft")}</Button>
                    {isRunning ? <Button danger icon={<Square className="size-4" />} onClick={() => stopCreationRun(nodeId)}>{t("canvas.workbench.agentCreationStop")}</Button> : null}
                    {conversation || project?.conversationId ? <Button disabled={isRunning || hasPendingRevision || !hydrated || !idea.trim()} icon={<ArrowRight className="size-4" />} onClick={() => start(true)}>{t("canvas.workbench.agentCreationContinue")}</Button> : null}
                    <Button type="primary" disabled={isRunning || hasPendingRevision || !hydrated || !idea.trim()} icon={<Play className="size-4" />} onClick={() => start(false)}>{t("canvas.workbench.agentCreationStart")}</Button>
                </div>
            </div>
        </Modal>
    );
}
