import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { creationPlanName } from "./creation-output-names";

/** 来自 infinite-creation/lib/shared/index.js 的固定顺序与默认绑定，不能拖动阶段绕过依赖。 */
export const CREATION_STAGES = [
    { id: "novel", label: "生成小说", skills: ["webnovel-writing"] },
    { id: "script", label: "生成剧本", skills: ["sd-script-engine", "short-drama-scriptwriting", "novel-to-skitscreenplay"] },
    { id: "character", label: "人物素材", skills: ["image-prompt-writing", "sd-asset-engine"] },
    { id: "prop", label: "道具素材", skills: ["image-prompt-writing", "sd-asset-engine"] },
    { id: "scene", label: "场景素材", skills: ["image-prompt-writing", "sd-asset-engine", "era-consistency-optimizer"] },
    { id: "costume", label: "换装", skills: ["image-prompt-writing", "sd-asset-engine"] },
    { id: "age", label: "年龄分级", skills: ["image-prompt-writing", "sd-asset-engine"] },
    { id: "voice", label: "配音·音色", skills: ["tts-voice-design"] },
    { id: "storyboard", label: "生成分镜脚本", skills: ["story-pipeline-cn", "sd-storyboard-engine", "scene-blocking-consistency"] },
    { id: "video_prompt", label: "视频提示词", skills: ["h3-prompt-writing", "video-cinematography"] },
    { id: "music", label: "生成背景音乐", skills: ["ai-music-studio", "music-caption-rewriter"] },
    { id: "pipeline", label: "总流水线", skills: ["novel-to-video", "short-drama-director"] },
] as const;
export type CreationStageId = typeof CREATION_STAGES[number]["id"];
export type AssetKind = "character" | "prop" | "scene" | "costume" | "age";
export const ASSET_STAGES: AssetKind[] = ["character", "prop", "scene", "costume", "age"];
export type SkillPipelineConfig = { nodes: Record<CreationStageId, { skills: string[]; fallback: boolean }> };
export const defaultCreationPipeline = (): SkillPipelineConfig => ({ nodes: Object.fromEntries(CREATION_STAGES.map((s) => [s.id, { skills: [...s.skills], fallback: true }])) as SkillPipelineConfig["nodes"] });
export function validatePipelineConfig(raw: unknown): SkillPipelineConfig {
    if (!raw || typeof raw !== "object" || !("nodes" in raw) || !raw.nodes || typeof raw.nodes !== "object") throw new Error("缺少流水线 nodes 配置。");
    const nodes = raw.nodes as Record<string, unknown>;
    if (Object.keys(nodes).some((id) => !CREATION_STAGES.some((s) => s.id === id))) throw new Error("流水线包含未知环节。");
    const result = defaultCreationPipeline();
    for (const stage of CREATION_STAGES) {
        const entry = nodes[stage.id] as { skills?: unknown; fallback?: unknown } | undefined;
        if (!entry || !Array.isArray(entry.skills) || entry.skills.length > 20 || typeof entry.fallback !== "boolean" || !entry.skills.every((s) => typeof s === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(s))) throw new Error(`${stage.label} 的技能配置无效。`);
        result.nodes[stage.id] = { skills: [...new Set(entry.skills)] as string[], fallback: entry.fallback };
    }
    return result;
}
export type CreationPlan = {
    assets: Array<{ id: string; kind: AssetKind; label: string; parentId?: string }>;
    shots: Array<{ id: string; label: string; referenceIds: string[]; promptNodeId: string; videoNodeId: string }>;
    voiceIds: string[];
    musicIds: string[];
    /** Optional semantic names for voice/music/text outputs; legacy plans may omit them. */
    outputNames?: Record<string, string>;
    /** 空素材/音色/配乐环节必须说明为什么不需要，不能默默跳过。 */
    omitted: Partial<Record<AssetKind | "voice" | "music", string>>;
};
export type CreationPipelineState = { version: 1; completed: CreationStageId[]; plan?: CreationPlan; render?: boolean; videos?: boolean; backgroundMusic?: boolean; review?: { sourceNodeId: string; candidateNodeId: string; feedback: string; createdAt: number; inputSignatures?: Record<string, string> } };
export type CreationOutput = {
    projectNodeId: string; stage: CreationStageId; name?: string;
    revisionOf?: string; revisionKind?: "candidate" | "history" | "discarded"; revisionAccepted?: boolean;
    feedback?: string; needsRevision?: boolean; revisionReason?: string;
};
export function currentCreationStage(state?: CreationPipelineState): CreationStageId | null {
    return CREATION_STAGES.find((s) => !state?.completed.includes(s.id))?.id || null;
}
export function validateCreationPlan(raw: unknown): CreationPlan {
    const p = raw as CreationPlan;
    if (!p || !Array.isArray(p.assets) || !Array.isArray(p.shots) || !Array.isArray(p.voiceIds) || !Array.isArray(p.musicIds) || !p.omitted || typeof p.omitted !== "object") throw new Error("计划必须包含 assets/shots/voiceIds/musicIds/omitted。");
    if (p.assets.length > 80 || !p.shots.length || p.shots.length > 60 || p.voiceIds.length > 30 || p.musicIds.length > 10) throw new Error("素材或镜头数量超限（素材80/镜头1-60/音色30/配乐10）。");
    const ids = new Set<string>();
    const add = (id: string) => { if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || ids.has(id)) throw new Error("计划中的节点ID必须合法且全局唯一。"); ids.add(id); };
    for (const asset of p.assets) {
        if (!asset || !ASSET_STAGES.includes(asset.kind) || typeof asset.label !== "string" || !asset.label.trim()) throw new Error("素材类型或名称无效。");
        add(asset.id);
        if (["costume", "age"].includes(asset.kind) && !p.assets.some((a) => a.id === asset.parentId && a.kind === "character")) throw new Error("换装/年龄变体必须绑定已规划人物 parentId。");
    }
    for (const shot of p.shots) {
        if (!shot || typeof shot.label !== "string" || !shot.label.trim() || !Array.isArray(shot.referenceIds) || !shot.referenceIds.length || shot.referenceIds.length > 9 || new Set(shot.referenceIds).size !== shot.referenceIds.length || shot.referenceIds.some((id) => !p.assets.some((a) => a.id === id))) throw new Error("每个镜头必须绑定1-9张不重复的已规划设定图。");
        add(shot.id); add(shot.promptNodeId); add(shot.videoNodeId);
    }
    for (const id of [...p.voiceIds, ...p.musicIds]) add(id);
    if (p.outputNames !== undefined && (!p.outputNames || typeof p.outputNames !== "object" || Array.isArray(p.outputNames) || Object.entries(p.outputNames).some(([id, name]) => !ids.has(id) || typeof name !== "string" || !name.trim() || name.length > 120))) throw new Error("outputNames必须是计划ID到简短素材名称的映射，每个名称1–120字。");
    for (const kind of [...ASSET_STAGES, "voice", "music"] as const) {
        const count = kind === "voice" ? p.voiceIds.length : kind === "music" ? p.musicIds.length : p.assets.filter((a) => a.kind === kind).length;
        if (!count && (typeof p.omitted[kind] !== "string" || !p.omitted[kind]!.trim())) throw new Error(`未使用 ${kind} 时必须在 omitted 写明原因。`);
    }
    return structuredClone(p);
}
export function expectedStageIds(stage: CreationStageId, plan?: CreationPlan): string[] | null {
    if (!plan) return null;
    if (ASSET_STAGES.includes(stage as AssetKind)) return plan.assets.filter((a) => a.kind === stage).map((a) => a.id);
    if (stage === "voice") return plan.voiceIds;
    if (stage === "music") return plan.musicIds;
    if (stage === "storyboard") return plan.shots.map((s) => s.id);
    if (stage === "video_prompt") return plan.shots.map((s) => s.promptNodeId);
    if (stage === "pipeline") return plan.shots.map((s) => s.videoNodeId);
    return null;
}
export function mediaReady(node?: CanvasNodeData) {
    const m = node?.metadata;
    return Boolean(m && !m.creationOutput?.needsRevision && !["history", "discarded"].includes(m.creationOutput?.revisionKind || "") && m.status === "success" && (m.content || m.storageKey || m.images?.some((image) => image.status === "success" && (image.content || image.storageKey))));
}
function textReady(node?: CanvasNodeData) { return node?.type === "text" && !node.metadata?.creationOutput?.needsRevision && Boolean(node.metadata?.content?.trim()); }
export function inspectCreationStage(stage: CreationStageId, state: CreationPipelineState, nodes: CanvasNodeData[], projectNodeId: string, render = true, videos = true) {
    if (state.review) return { ready: false, reasons: ["素材重生成结果尚待用户确认，请采用或取消后继续。"], waiting: false };
    if (stage === "music" && state.backgroundMusic === false) return { ready: true, reasons: [], waiting: false };
    const expected = expectedStageIds(stage, state.plan);
    const own = nodes.filter((n) => n.metadata?.creationOutput?.projectNodeId === projectNodeId && n.metadata.creationOutput.stage === stage && !n.metadata.creationOutput.revisionKind);
    const required = expected ? expected.map((id) => own.find((n) => n.id === id)) : own;
    const reasons: string[] = [];
    if (stage === "script" && !state.plan) reasons.push("需先提交完整素材/镜头计划");
    if (stage !== "novel" && stage !== "script" && !state.plan) reasons.push("缺少锁定计划");
    if ((stage === "novel" || stage === "script") && !own.length) reasons.push("缺少正文文本卡");
    const mediaStage = ASSET_STAGES.includes(stage as AssetKind) || stage === "voice" || stage === "music" || stage === "pipeline";
    const requireMedia = render && mediaStage && (stage !== "pipeline" || videos);
    for (let i = 0; i < required.length; i++) {
        const n = required[i];
        if (stage === "pipeline" && !videos) continue;
        const expectedType = ASSET_STAGES.includes(stage as AssetKind) ? "image" : stage === "pipeline" ? "video" : "audio";
        if (!n || (requireMedia ? n.type !== expectedType || !mediaReady(n) : !textReady(n))) reasons.push(`${expected?.[i] || n?.id || stage}：${n?.metadata?.status === "error" ? "生成失败" : requireMedia ? "等待真实生成结果" : "缺少文本"}`);
    }
    return { ready: reasons.length === 0, reasons, waiting: requireMedia && required.some((n) => n?.metadata?.status === "loading") };
}

/** The confirmed video_prompt text is authoritative; the video card is only a render target. */
export function creationVideoPromptSource(videoNodeId: string, state: CreationPipelineState, nodes: CanvasNodeData[], projectNodeId: string) {
    const shot = state.plan?.shots.find(s => s.videoNodeId === videoNodeId);
    const source = nodes.find(n => n.id === shot?.promptNodeId);
    const output = source?.metadata?.creationOutput;
    const ready = Boolean(shot && textReady(source) && output?.projectNodeId === projectNodeId && output.stage === "video_prompt" && !output.revisionKind);
    return { promptNodeId: shot?.promptNodeId || "", ready, prompt: ready ? source!.metadata!.content! : "" };
}

/** Runtime evidence is separate from persisted card labels; neither proves GPU activity. */
export function inspectCreationExecution(stage: CreationStageId, state: CreationPipelineState, nodes: CanvasNodeData[], projectNodeId: string, render = true, videos = true, isActive?: (nodeId: string) => boolean) {
    const check = inspectCreationStage(stage, state, nodes, projectNodeId, render, videos);
    const ids = expectedStageIds(stage, state.plan) || nodes.filter(n => n.metadata?.creationOutput?.projectNodeId === projectNodeId && n.metadata.creationOutput.stage === stage && !n.metadata.creationOutput.revisionKind).map(n => n.id);
    const outputs = ids.map(id => {
        const node = nodes.find(n => n.id === id && n.metadata?.creationOutput?.projectNodeId === projectNodeId && n.metadata.creationOutput.stage === stage && !n.metadata.creationOutput.revisionKind);
        const active = Boolean(isActive?.(id));
        const loading = node?.metadata?.status === "loading";
        const promptSource = stage === "pipeline" ? creationVideoPromptSource(id, state, nodes, projectNodeId) : undefined;
        return { id, status: !node ? "missing" : active ? "request_active" : node.metadata?.status === "error" ? "failed" : mediaReady(node) || (node.type === "text" && textReady(node)) ? "ready" : loading ? "unverified_loading" : "not_started", error: node?.metadata?.errorDetails || "", videoTaskId: node?.metadata?.videoTaskId || "", ...(promptSource ? { promptSource: { nodeId: promptSource.promptNodeId, ready: promptSource.ready, characters: promptSource.prompt.length, policy: "从已确认视频提示词卡自动读取全文；视频卡prompt可以为空，无需复制或改写。" } } : {}) };
    });
    const untracked = isActive ? outputs.filter(o => o.status === "unverified_loading").map(o => o.id) : [];
    return { ...check, waiting: (check.waiting || outputs.some(o => o.status === "request_active")) && !untracked.length, outputs, untracked, evidence: "request_active仅表示前端请求仍在等待，不代表GPU已接单；没有结果不得声称完成。", ...(untracked.length ? { error: `节点显示生成中，但当前页面没有活动生成请求：${untracked.join("、")}。停止空等，先核对后台队列和任务记录，不能自动重复提交。` } : {}) };
}

/** 验证整批后再写入，不能用同批伪造 success/content 绕过阶段。 */
export function guardCreationOps(ops: CanvasAgentOp[], nodes: CanvasNodeData[], projectNodeId: string, state: CreationPipelineState, render = true, videos = true): CanvasAgentOp[] {
    if (state.review) throw new Error("请先采用或取消待确认的重生成素材。");
    const stage = currentCreationStage(state);
    if (!stage) throw new Error("流水线已完成。请新建工作台开始新项目。");
    if (stage === "music" && state.backgroundMusic === false && ops.some((op) => !["select_nodes", "set_viewport"].includes(op.type))) throw new Error("项目已关闭背景音乐，不能创建或生成配乐；请完成此跳过阶段。");
    for (const prior of state.completed) {
        const checked = inspectCreationStage(prior, state, nodes, projectNodeId, render, videos);
        if (!checked.ready) throw new Error(`前置 ${prior} 产物已失效：${checked.reasons.join("；")}。请修复后继续。`);
    }
    const expected = expectedStageIds(stage, state.plan);
    const virtual = new Map(nodes.map((n) => [n.id, n]));
    const mediaType = ASSET_STAGES.includes(stage as AssetKind) ? "image" : stage === "voice" || stage === "music" ? "audio" : stage === "pipeline" ? "video" : "text";
    const allowedType = render ? mediaType : "text";
    const safe: CanvasAgentOp[] = [];
    const assertOwn = (id: string) => {
        const n = virtual.get(id);
        if (n?.metadata?.creationOutput?.projectNodeId !== projectNodeId || n.metadata.creationOutput.stage !== stage || n.metadata.creationOutput.revisionKind) throw new Error("只能修改当前阶段所属的项目节点。");
        return n;
    };
    const cleanMetadata = (metadata: CanvasNodeMetadata = {}) => {
        for (const key of ["status", "storageKey", "images", "texts", "primaryImageId", "videoTaskId", "creationOutput", "creationPipeline", "agentCreation", "workbenchKind", "previewUrl", "references"] as const) if (key in metadata) throw new Error(`Agent 不得写入受保护字段 ${key}。`);
        if (allowedType !== "text" && "content" in metadata) throw new Error("媒体 content 只能由真实生成结果写入。");
        return metadata;
    };
    for (const op of ops) {
        if (op.type === "add_node") {
            if (!op.id || virtual.has(op.id)) throw new Error("新增节点必须使用唯一ID，不得覆盖已有节点。");
            if (expected && !expected.includes(op.id)) throw new Error("节点ID不在当前阶段的锁定计划中。");
            if (op.nodeType !== allowedType) throw new Error(`当前 ${stage} 阶段只允许 ${allowedType} 卡，不能提前进入分镜/视频。`);
            if (stage === "pipeline" && !videos) throw new Error("本轮未开启视频生成。");
            const m = cleanMetadata(op.metadata);
            const name = creationPlanName(state.plan, op.id, stage);
            const metadata: CanvasNodeMetadata = { ...m, creationOutput: { projectNodeId, stage, name } };
            if (stage === "voice") metadata.audioMode = "voice-design";
            if (stage === "music") metadata.audioMode = "music";
            if (stage === "pipeline" && render) metadata.videoMode = "reference";
            if ((stage === "costume" || stage === "age") && render) { metadata.imageMode = "edit"; metadata.generationType = "edit"; }
            const n: CanvasNodeData = { id: op.id, type: allowedType, title: name, position: op.position || { x: 0, y: 0 }, width: 300, height: 240, metadata };
            virtual.set(op.id, n); safe.push({ ...op, title: name, metadata });
        } else if (op.type === "update_node") {
            const n = assertOwn(op.id);
            if (op.patch && Object.keys(op.patch).some((key) => !["title", "position", "width", "height"].includes(key))) throw new Error("patch 仅允许标题和布局。");
            if (n.metadata?.status === "loading") throw new Error("正在生成的节点不可修改。");
            if (n.metadata?.creationOutput?.needsRevision && allowedType !== "text") throw new Error("该媒体引用已变化，请在素材检查区重新生成并采用新版。");
            const cleaned = cleanMetadata(op.metadata);
            const metadata = allowedType === "text" && n.metadata?.creationOutput?.needsRevision && cleaned.content?.trim()
                ? { ...cleaned, creationOutput: { ...n.metadata.creationOutput, needsRevision: false, revisionReason: undefined } } : cleaned;
            if (mediaReady(n)) throw new Error("已完成的媒体产物不可由 Agent 覆盖；请在素材检查区重生成。");
            const title = creationPlanName(state.plan, n.id, stage, n.metadata?.creationOutput?.name);
            const safeOp = { ...op, patch: { ...op.patch, title }, metadata };
            virtual.set(n.id, { ...n, ...safeOp.patch, metadata: { ...n.metadata, ...metadata } }); safe.push(safeOp);
        } else if (op.type === "run_generation") {
            const n = assertOwn(op.nodeId);
            if (!render || allowedType === "text" || op.mode !== allowedType) throw new Error("当前阶段不允许此类型生成。");
            if (n.metadata?.creationOutput?.needsRevision) throw new Error("该媒体需要用户在素材检查区重新生成并采用新版。");
            if (n.metadata?.status === "loading" || mediaReady(n)) throw new Error("节点正在生成或已有结果，不能重复提交。");
            if (stage === "pipeline") {
                const shot = state.plan?.shots.find((s) => s.videoNodeId === n.id);
                const source = creationVideoPromptSource(n.id, state, nodes, projectNodeId);
                if (!shot || !source.ready) throw new Error(`视频 ${n.id} 对应的已确认提示词卡 ${source.promptNodeId || "（未绑定）"} 缺失、为空或已失效；请修复原提示词卡，不要在视频卡临时补写。`);
                if (shot.referenceIds.some((id) => !mediaReady(nodes.find((item) => item.id === id)))) throw new Error("视频必须有分镜提示词且全部参考图真实完成。");
                safe.push(...shot.referenceIds.map((id) => ({ type: "connect_nodes" as const, fromNodeId: id, toNodeId: n.id })));
                safe.push({ ...op, prompt: source.prompt });
            } else {
                if (!String(op.prompt || n.metadata?.prompt || "").trim()) throw new Error("缺少生成提示词。");
                const asset = state.plan?.assets.find((a) => a.id === n.id);
                if (asset?.parentId) {
                    if (!mediaReady(nodes.find((item) => item.id === asset.parentId))) throw new Error("人物基础图未完成，不能生成换装/年龄变体。");
                    safe.push({ type: "connect_nodes", fromNodeId: asset.parentId, toNodeId: n.id });
                }
                safe.push(op);
            }
            virtual.set(n.id, { ...n, metadata: { ...n.metadata, status: "loading" } });
        } else if (op.type === "connect_nodes") {
            const target = assertOwn(op.toNodeId);
            const source = virtual.get(op.fromNodeId);
            if (op.fromNodeId !== projectNodeId && source?.metadata?.creationOutput?.projectNodeId !== projectNodeId) throw new Error("不能连接其他项目素材。");
            if (target.type === "video") throw new Error("视频参考连接由锁定计划自动装配。");
            // 展示连接由整批末尾的布局器统一生成；不保留模型的扇形/交叉连线。
            // 真正的父人物/视频参考连接只在 run_generation 分支装配。
        } else if (op.type === "select_nodes" || op.type === "set_viewport") safe.push(op);
        else throw new Error("创作流水线禁止删除已有节点或连线。");
    }
    return safe;
}
