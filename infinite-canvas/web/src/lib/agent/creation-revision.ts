import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { creationMediaMetadata } from "./creation-media";
import { creationOutputName } from "./creation-output-names";
import { CREATION_STAGES, expectedStageIds, mediaReady, type CreationOutput, type CreationPipelineState } from "./creation-pipeline";

export type CreationRevisionAction =
    | { action: "request"; sourceNodeId: string; candidateNodeId: string; feedback: string; createdAt: number }
    | { action: "accept"; historyNodeId: string }
    | { action: "discard" };
const isLoading = (node: CanvasNodeData) => node.metadata?.status === "loading" || node.metadata?.images?.some(i => i.status === "loading");
const isMedia = (node: CanvasNodeData) => ["image", "video", "audio"].includes(node.type);
const owns = (node: CanvasNodeData, projectNodeId: string) => node.metadata?.creationOutput?.projectNodeId === projectNodeId;
// Blob URLs change on refresh; stored identity must remain stable across hydration.
function inputSignature(node?: CanvasNodeData) {
    const m = node?.metadata;
    return JSON.stringify([node?.type, m?.storageKey || m?.content || "", m?.status, m?.creationOutput?.needsRevision || false, m?.creationOutput?.revisionKind || ""]);
}

export function affectedCreationOutputs(nodes: CanvasNodeData[], projectNodeId: string, sourceId: string, state: CreationPipelineState, connections: CanvasConnection[] = []) {
    const plan = state.plan;
    const source = nodes.find(n => n.id === sourceId)!;
    const affected = new Set<string>();
    if (plan) {
        const dependents = new Set([sourceId]);
        for (let pass = 0; pass < plan.assets.length; pass++) for (const asset of plan.assets) {
            if (asset.parentId && dependents.has(asset.parentId)) { dependents.add(asset.id); affected.add(asset.id); }
        }
        for (const shot of plan.shots) {
            if (shot.referenceIds.some(id => dependents.has(id))) for (const id of [shot.id, shot.promptNodeId, shot.videoNodeId]) affected.add(id);
            if (source.metadata?.creationOutput?.stage === "voice") affected.add(shot.videoNodeId);
        }
    }
    // Include user-established real reference dependencies, never presentation edges.
    for (let pass = 0; pass < nodes.length; pass++) {
        let changed = false;
        for (const edge of connections) {
            if (edge.role === "lineage" || (edge.fromNodeId !== sourceId && !affected.has(edge.fromNodeId)) || affected.has(edge.toNodeId)) continue;
            const target = nodes.find(n => n.id === edge.toNodeId);
            if (target && owns(target, projectNodeId) && !target.metadata?.creationOutput?.revisionKind) { affected.add(target.id); changed = true; }
        }
        if (!changed) break;
    }
    return nodes.filter(n => n.id !== sourceId && owns(n, projectNodeId) && !n.metadata?.creationOutput?.revisionKind && affected.has(n.id));
}

function requireIdle(nodes: CanvasNodeData[], projectNodeId: string) {
    if (nodes.some(n => (owns(n, projectNodeId) || n.id === `${projectNodeId}-editor`) && isLoading(n))) throw new Error("本项目仍有媒体正在生成；Agent 已暂停，请等待生成结束后重试。不会取消已提交任务。");
}
function pendingMetadata(source: CanvasNodeData, output: CreationOutput, host: CanvasNodeData, feedback: string): CanvasNodeMetadata {
    const settings = host.metadata!.agentCreation!;
    const m = { ...source.metadata };
    for (const key of ["content", "storageKey", "images", "texts", "primaryImageId", "primaryTextId", "references", "previewUrl", "previewMime", "previewStep", "previewTotal", "videoTaskId", "videoTaskProvider", "stepProgress", "generationStartedAt", "generationDurationMs", "errorDetails", "mimeType", "bytes", "durationMs", "composerContent", "generationInputPrompt", "seed", "audioSeed"] as const) delete m[key];
    const originalPrompt = source.metadata?.generationInputPrompt || source.metadata?.prompt || "";
    if (!originalPrompt.trim()) throw new Error("此素材缺少原生成提示词，无法重生成。");
    const prompt = output.stage === "voice" ? originalPrompt : `${originalPrompt}\n\n【用户本次修改要求（优先满足）】\n${feedback}`;
    return {
        ...creationMediaMetadata(output.stage, settings, { ...m, params: {}, prompt,
            ...(output.stage === "voice" ? { audioVoiceDescription: `${m.audioVoiceDescription || ""}\n用户音色修改要求：${feedback}` } : {}) }),
        generationMode: source.type as "image" | "video" | "audio", status: "loading", seedFixed: "false", audioSeed: "", audioSeedFixed: "false",
        creationOutput: { projectNodeId: output.projectNodeId, stage: output.stage, name: creationOutputName(source, [host]), revisionKind: "candidate", revisionOf: source.id, feedback },
    };
}

/** Trusted UI-only operation: validate everything before one atomic canvas mutation. */
export function applyCreationRevision(snapshot: CanvasAgentSnapshot, projectNodeId: string, action: CreationRevisionAction): CanvasAgentSnapshot {
    const host = snapshot.nodes.find(n => n.id === projectNodeId && n.metadata?.workbenchKind === "agent-creation");
    if (!host?.metadata?.agentCreation) throw new Error("当前画布中找不到此创作项目。");
    const state = host.metadata.creationPipeline;
    if (!state?.plan || state.render === false) throw new Error("仅支持已建立媒体计划的创作项目。");
    requireIdle(snapshot.nodes, projectNodeId);
    let nodes = snapshot.nodes;
    let nextState = state;
    let connections = snapshot.connections;
    if (action.action === "request") {
        if (state.review) throw new Error("请先采用或取消当前候选，再重做其他素材。");
        const source = nodes.find(n => n.id === action.sourceNodeId);
        const output = source?.metadata?.creationOutput;
        if (!source || !output || !owns(source, projectNodeId) || output.revisionKind || !isMedia(source)) throw new Error("只能重做本项目的正式图片、视频或音频素材。");
        if (!expectedStageIds(output.stage, state.plan)?.includes(source.id)) throw new Error("素材不在本项目锁定计划中。");
        const feedback = action.feedback.trim();
        if (!feedback || feedback.length > 4000) throw new Error("请填写 1–4000 字的素材修改要求。");
        if (nodes.some(n => n.id === action.candidateNodeId)) throw new Error("候选ID已存在。");
        const asset = state.plan.assets.find(a => a.id === source.id);
        const shot = state.plan.shots.find(s => s.videoNodeId === source.id);
        const requiredIds = shot ? shot.referenceIds : asset?.parentId ? [asset.parentId] : [];
        if (requiredIds.some(id => !mediaReady(nodes.find(n => n.id === id)))) throw new Error("先修复此素材依赖的设定图，再重新生成。");
        if (shot && [shot.id, shot.promptNodeId].some(id => { const n = nodes.find(x => x.id === id); return !n?.metadata?.content?.trim() || n.metadata.creationOutput?.needsRevision; })) throw new Error("分镜或视频提示词需要重做，请先继续项目更新文本后再生成视频。");
        const promptSource = shot ? { ...source, metadata: { ...source.metadata, generationInputPrompt: nodes.find(n => n.id === shot.promptNodeId)!.metadata!.content! } } : source;
        const metadata = pendingMetadata(promptSource, output, host, feedback);
        const candidate = { ...source, id: action.candidateNodeId, title: `${creationOutputName(source, nodes)} · 待确认新版`, metadata };
        nodes = [...nodes, candidate];
        // Keep the exact input ordering, never use the rejected result as reference.
        const incoming = snapshot.connections.filter(c => c.toNodeId === source.id && c.role !== "lineage");
        const sourceIds = [...new Set([...requiredIds, ...incoming.map(c => c.fromNodeId)])];
        for (const id of sourceIds) {
            const ref = nodes.find(n => n.id === id);
            if (!ref || ref.metadata?.creationOutput?.revisionKind || ref.metadata?.creationOutput?.needsRevision || (isMedia(ref) && !mediaReady(ref))) throw new Error("参考素材已失效或尚未成功，请先更新参考后重试。");
        }
        connections = [...connections, ...sourceIds.map((id, index) => ({ id: `revision-ref:${candidate.id}:${index}`, fromNodeId: id, toNodeId: candidate.id }))];
        const inputSignatures = Object.fromEntries([...sourceIds, source.id, ...(shot ? [shot.id, shot.promptNodeId] : [])].map(id => [id, inputSignature(nodes.find(n => n.id === id))]));
        nextState = { ...state, review: { sourceNodeId: source.id, candidateNodeId: candidate.id, feedback, createdAt: action.createdAt, inputSignatures } };
    } else {
        const review = state.review;
        if (!review) throw new Error("没有待确认的重生成结果。");
        const source = nodes.find(n => n.id === review.sourceNodeId);
        const candidate = nodes.find(n => n.id === review.candidateNodeId);
        if (!source || !owns(source, projectNodeId)) throw new Error("原版素材已移除，无法采用或恢复。");
        if ((!candidate || !owns(candidate, projectNodeId) || candidate.metadata?.creationOutput?.revisionKind !== "candidate") && action.action === "accept") throw new Error("待确认素材已移除或被修改。");
        if (action.action === "accept") {
            if (Object.entries(review.inputSignatures || {}).some(([id, signature]) => inputSignature(nodes.find(n => n.id === id)) !== signature)) throw new Error("生成期间原版或参考内容已变化，请取消候选并按最新内容重新生成。");
            if (!candidate || !mediaReady(candidate) || candidate.type !== source.type) throw new Error("新版尚未生成成功，不能采用。");
            if (nodes.some(n => n.id === action.historyNodeId)) throw new Error("历史版本ID已存在。");
            const output = source.metadata!.creationOutput!;
            const affected = new Set(affectedCreationOutputs(nodes, projectNodeId, source.id, state, connections).map(n => n.id));
            const name = creationOutputName(source, nodes)!;
            const history: CanvasNodeData = { ...source, id: action.historyNodeId, title: `${name} · 历史版本`, metadata: { ...source.metadata, creationOutput: { ...output, name, revisionKind: "history", revisionOf: source.id } } };
            nodes = [...nodes.map((n): CanvasNodeData => n.id === source.id ? { ...n, title: name, metadata: { ...candidate.metadata, creationOutput: { projectNodeId, stage: output.stage, name, feedback: review.feedback } } }
                : n.id === candidate.id ? { ...n, title: `${name} · 已采用记录`, metadata: { ...n.metadata, creationOutput: { ...n.metadata!.creationOutput!, revisionKind: "history", revisionAccepted: true } } }
                : affected.has(n.id) ? { ...n, metadata: { ...n.metadata, creationOutput: { ...n.metadata!.creationOutput!, needsRevision: true, revisionReason: `参考 ${source.title} 已更换，请按新版重新检查/生成。` } } } : n), history];
            const earliest = CREATION_STAGES.findIndex(s => s.id === output.stage);
            nextState = { ...state, review: undefined, completed: state.completed.filter(id => CREATION_STAGES.findIndex(s => s.id === id) < earliest) };
        } else {
            nodes = nodes.map(n => n.id === candidate?.id ? { ...n, title: `${creationOutputName(source, nodes)} · 未采用版本`, metadata: { ...n.metadata, creationOutput: { ...n.metadata!.creationOutput!, revisionKind: "discarded" } } } : n);
            nextState = { ...state, review: undefined };
        }
    }
    const progress = action.action === "request" ? "已提交单素材重生成；流水线暂停，等待检查并采用新版。" : action.action === "accept" ? "已采用新版，旧版已保留；受影响的下游需重做，检查后继续项目。" : "已取消本次重做，原版保持不变；可修改要求重试或继续项目。";
    nodes = nodes.map(n => n.id === host.id ? { ...n, metadata: { ...n.metadata, creationPipeline: nextState, agentCreation: { ...host.metadata!.agentCreation!, status: "ready", progress, lastError: undefined } } } : n);
    return { ...snapshot, nodes, connections };
}
