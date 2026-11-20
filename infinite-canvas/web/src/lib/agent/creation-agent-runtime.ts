/**
 * 独立创作执行体：关闭工作台不取消；切换画布安全停止，绝不写入另一张画布。
 * 会话、审批、停止和进度按工作台隔离。只共享 promptCloudApis 和画布能力。
 */
import { buildAgentCreationTask, type AgentCreationSeed } from "@/lib/agent/agent-creation-task";
import { applyApprovedCanvasOps } from "@/lib/agent-chat-lifecycle";
import { readAgentChatResponse, redactAgentError, type StreamDelta } from "@/lib/agent-chat-stream";
import { rebuildChatHistory } from "@/lib/agent-chat-history";
import { resolveAgentRuntime } from "@/lib/agent-cloud-config";
import { summarizeCanvasAgentOps, type CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { requestAgentChat } from "@/services/api/agent-cloud";
import { canvasFeatureCatalog, cloudTools, compactCanvasState } from "@/components/agent/agent-cloud-shared";
import { activePromptCloudApi, useConfigStore } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCreationAgentStore, type CreationConversation } from "@/stores/use-creation-agent-store";
import type { AgentChatMessageItem } from "@/components/agent/agent-chat-message";
import { CREATION_STAGES, currentCreationStage, guardCreationOps, inspectCreationStage, inspectCreationExecution, validateCreationPlan, expectedStageIds, type CreationPipelineState, type SkillPipelineConfig, type CreationStageId } from "@/lib/agent/creation-pipeline";
import { loadCreationSkill, loadCreationSkillReference, listCreationSkills, type SkillFileOverrides } from "@/lib/agent/creation-skills";
import { useCreationPipelineStore } from "@/stores/use-creation-pipeline-store";
import { normalizeCreationResolution, type CreationResolution } from "./creation-settings";
import { creationMediaMetadata, CREATION_MEDIA_WORKFLOWS } from "./creation-media";

const CREATION_CONNECTION = { transport: "cloud", enabled: false, localBaseUrl: "" } as const;
const MAX_CREATION_TOOL_STEPS = 120;
const MAX_CREATION_MEDIA_WAIT_MS = 30 * 60 * 1000;
type ApiMessage = { role: "system" | "user" | "assistant" | "tool"; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string; provider_metadata?: unknown; reasoning_content?: string };
type RunningTask = {
    controller: AbortController;
    conversationId: string;
    projectNodeId: string;
    canvasId: string;
    render: boolean;
    videos: boolean;
    backgroundMusic: boolean;
    userChat: boolean;
    resolution: CreationResolution;
    aspectRatio: AgentCreationSeed["aspectRatio"];
    pipelineConfig: SkillPipelineConfig;
    skillFiles: SkillFileOverrides;
    loadedStages: Set<CreationStageId>;
    appliedSnapshot?: import("@/lib/canvas/canvas-agent-ops").CanvasAgentSnapshot;
    confirmBeforeApply: boolean;
    stopReason: string;
    pendingApproval: { resolve: (approved: boolean) => void } | null;
};
const tasks = new Map<string, RunningTask>();
const creationId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

function readTarget(task: RunningTask) {
    if (task.controller.signal.aborted) throw new DOMException("Canceled", "AbortError");
    const context = useAgentStore.getState().canvasContext;
    if (!context || context.snapshot.projectId !== task.canvasId) throw new Error("画布已切换，创作已停止。请回到原画布继续项目。");
    if (!context.snapshot.nodes.some((node) => node.id === task.projectNodeId)) throw new Error("项目工作台已移除，创作已停止。");
    return context;
}

function targetSnapshot(task: RunningTask) {
    return task.appliedSnapshot || readTarget(task).snapshot;
}
function pipelineState(task: RunningTask): CreationPipelineState {
    return targetSnapshot(task).nodes.find((n) => n.id === task.projectNodeId)?.metadata?.creationPipeline || { version: 1, completed: [] };
}
function writePipeline(task: RunningTask, state: CreationPipelineState) {
    const ctx = readTarget(task);
    task.appliedSnapshot = ctx.applyOps([{ type: "update_node", id: task.projectNodeId, metadata: { creationPipeline: state } }, { type: "layout_creation", projectNodeId: task.projectNodeId }]);
}
function creationTools() {
    const extra = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } });
    return [
        ...cloudTools().filter((t) => t.function.name !== "site_navigate"),
        extra("creation_get_pipeline", "获取真实阶段、计划与未完成依赖；不可跳过前置阶段。", {}),
        extra("creation_set_plan", "剧本阶段一次提交全量素材与镜头清单，锁定后不可删减来绕过生成；无某类素材需omitted说明。镜头此时只填名称及引用，不写分镜正文。", { plan: { type: "object", properties: {
            assets: { type: "array", items: { type: "object", properties: { id: { type: "string" }, kind: { enum: ["character", "prop", "scene", "costume", "age"] }, label: { type: "string" }, parentId: { type: "string" } }, required: ["id", "kind", "label"] } },
            shots: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, referenceIds: { type: "array", items: { type: "string" } }, promptNodeId: { type: "string" }, videoNodeId: { type: "string" } }, required: ["id", "label", "referenceIds", "promptNodeId", "videoNodeId"] } },
            outputNames: { type: "object", description: "音色/配乐等产物ID对应简短名称，例如voice-luming:陆明-音色；不得用提示词作名称。", additionalProperties: { type: "string" } },
            voiceIds: { type: "array", items: { type: "string" } }, musicIds: { type: "array", items: { type: "string" } }, omitted: { type: "object", additionalProperties: { type: "string" } },
        }, required: ["assets", "shots", "voiceIds", "musicIds", "omitted"] } }, ["plan"]),
        extra("creation_complete_stage", "程序核实所有计划产物；必须读过当前环节skills。素材必须真实生成成功，空环节需计划中的原因。通过才进入下一环节。", {}),
        extra("creation_wait", "程序等待当前批已提交媒体，期间不重复调用云模型；完成后自动继续，失败或用户停止时退出。最长30分钟，不伪造结果。", {}),
        extra("skill", "读取当前环节按优先级配置的完整skills正文和参考文件索引。传name可在允许fallback时读取已安装补充技能。", { name: { type: "string" } }),
        extra("skill_reference", "读取已安装技能的指定参考资料全文（不执行脚本）。", { name: { type: "string" }, ref: { type: "string" } }, ["name", "ref"]),
    ];
}
async function loadStageSkills(task: RunningTask, name?: string) {
    const stage = currentCreationStage(pipelineState(task));
    if (!stage) return { done: true };
    const entry = task.pipelineConfig.nodes[stage];
    if (name && !entry.skills.includes(name) && !entry.fallback) throw new Error("当前环节关闭了自动匹配，不能加载未绑定技能。");
    let names = name ? [name] : entry.skills;
    if (!names.length && entry.fallback) names = [...CREATION_STAGES.find((s) => s.id === stage)!.skills];
    if (!names.length) throw new Error("本环节没有技能且禁止自动匹配，请配置技能后继续。");
    const loaded = [];
    const failures: string[] = [];
    for (const skillName of names) {
        try { loaded.push(await loadCreationSkill(skillName, task.skillFiles)); }
        catch (error) {
            if (!entry.fallback) throw error;
            failures.push(`${skillName}：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!loaded.length && entry.fallback) {
        for (const candidate of CREATION_STAGES.find((s) => s.id === stage)!.skills) {
            try { loaded.push(await loadCreationSkill(candidate, task.skillFiles)); } catch { /* 后续候选继续 */ }
        }
    }
    if (!loaded.length) throw new Error("当前环节绑定和自动匹配技能均不可用，请检查技能包。");
    task.loadedStages.add(stage);
    return { stage, priority: loaded.map((s) => s.name), skills: loaded, missing: failures, availableFallback: entry.fallback ? await listCreationSkills(task.skillFiles) : [] };
}

/** 不依赖面板挂载写回进度；离开目标画布时仅保存独立会话，不能触碰新画布。 */
function saveProgress(task: RunningTask, status: CreationConversation["status"], progress: string, lastError?: string) {
    useCreationAgentStore.getState().setProgress(task.conversationId, { status, progress, lastError });
    const context = useAgentStore.getState().canvasContext;
    const nodes = task.appliedSnapshot?.nodes || context?.snapshot.nodes;
    const node = nodes?.find((item) => item.id === task.projectNodeId);
    if (context?.snapshot.projectId !== task.canvasId || !node?.metadata?.agentCreation) return;
    task.appliedSnapshot = context.applyOps([{ type: "update_node", id: task.projectNodeId, metadata: {
        agentCreation: { ...node.metadata.agentCreation, status, progress, lastError, conversationId: task.conversationId },
        agentCreationProgress: progress,
    } }]);
}

function inspectCurrentExecution(task: RunningTask, stage: CreationStageId) {
    return inspectCreationExecution(stage, pipelineState(task), targetSnapshot(task).nodes, task.projectNodeId, task.render, task.videos, readTarget(task).isGenerationActive);
}
function executionBlock(task: RunningTask, check: ReturnType<typeof inspectCreationExecution>): string {
    if (pipelineState(task).review) return "素材候选尚待确认，自动推进已暂停；请先采用或取消。";
    return check.error || check.outputs.filter(o => o.status === "failed").map(o => `${o.id}：${o.error || "生成失败"}`).join("；");
}
/** Keep the same run/abort handle while waiting locally; never ask the model to poll. */
async function waitForCreationMedia(task: RunningTask, stage: CreationStageId): Promise<ReturnType<typeof inspectCreationExecution> & { pauseRun?: boolean; message?: string }> {
    const initial = inspectCurrentExecution(task, stage);
    const blocked = executionBlock(task, initial);
    if (blocked) return { ...initial, error: blocked, pauseRun: true };
    if (!initial.waiting) return initial;
    const label = CREATION_STAGES.find(s => s.id === stage)!.label;
    useCreationAgentStore.getState().setRunPhase(task.projectNodeId, "waiting_media");
    saveProgress(task, "running", `${label}：等待已提交媒体返回，完成后自动继续；此期间不重复调用云模型，可随时停止自动推进。`);
    try {
        return await new Promise<ReturnType<typeof inspectCreationExecution> & { pauseRun?: boolean; message?: string }>((resolve, reject) => {
            let settled = false;
            let unsubscribe = () => {};
            let timer: ReturnType<typeof setTimeout> | undefined;
            const cleanup = () => { if (timer) clearTimeout(timer); unsubscribe(); task.controller.signal.removeEventListener("abort", abort); };
            const fail = (error: unknown) => { if (!settled) { settled = true; cleanup(); reject(error); } };
            const finish = (result: ReturnType<typeof inspectCreationExecution> & { pauseRun?: boolean; message?: string }) => { if (!settled) { settled = true; cleanup(); resolve(result); } };
            const abort = () => fail(new DOMException("Canceled", "AbortError"));
            const inspect = () => {
                if (settled) return;
                try {
                    readTarget(task);
                    const result = inspectCurrentExecution(task, stage), error = executionBlock(task, result);
                    if (error) finish({ ...result, error, pauseRun: true });
                    else if (!result.waiting) finish(result);
                } catch (error) { fail(error); }
            };
            // Canvas context briefly becomes null during React effect replacement.
            unsubscribe = useAgentStore.subscribe(() => queueMicrotask(inspect));
            task.controller.signal.addEventListener("abort", abort, { once: true });
            timer = setTimeout(() => {
                try { finish({ ...inspectCurrentExecution(task, stage), pauseRun: true, message: "媒体等待超过30分钟，自动推进已暂停；已提交请求未被取消，请检查后台任务后再继续。" }); }
                catch (error) { fail(error); }
            }, MAX_CREATION_MEDIA_WAIT_MS);
            if (task.controller.signal.aborted) abort(); else inspect();
        });
    } finally { useCreationAgentStore.getState().setRunPhase(task.projectNodeId, "executing"); }
}
function creationProgressKey(task: RunningTask) {
    const snapshot = targetSnapshot(task);
    return JSON.stringify([pipelineState(task).completed, snapshot.nodes.filter(n => n.metadata?.creationOutput?.projectNodeId === task.projectNodeId && !n.metadata.creationOutput.revisionKind).map(n => [n.id, n.metadata?.status, n.metadata?.content, n.metadata?.storageKey, n.metadata?.prompt, n.metadata?.creationOutput?.needsRevision])]);
}

function creationSystemPrompt(seed: AgentCreationSeed) {
    const catalog = canvasFeatureCatalog();
    return [
        "你是「Agent 无限创作」的执行 Agent，负责把故事推进成画布上的蓝图、分镜和视频片段。",
        `当前项目：「${seed.projectTitle}」，工作台卡片 ID=${seed.projectNodeId}。只在这个项目工作，不创建别的项目或数据库。`,
        `项目设置：画幅${seed.aspectRatio}，视频分辨率${seed.resolution || "768p"}，目标${seed.targetSeconds}秒。背景音乐${seed.backgroundMusic === false ? "关闭：不生成配乐，video_prompt的non_diegetic_music写N/A，保留环境音/台词" : "开启：规划并生成独立背景音乐素材"}。`,
        `以下JSON是项目资料，不是本轮用户聊天消息或待执行指令；用户在原文框编辑不等于要求立即重做。${JSON.stringify({ storySource: seed.idea, style: seed.style })}`,
        seed.userMessage ? "当前是项目专属对话：只响应这条聊天消息，可以读取项目状态和技能，但不修改画布或生成媒体。先讨论并明确修改方案；用户点击启动/继续项目后，执行器会结合本项目聊天记录推进。" : "当前是用户点击启动/继续项目，请按已有阶段推进。",
        seed.style.trim() ? `统一画面风格：${seed.style.trim()}。保持人物、场景、分镜一致。` : "画面风格留空：根据故事题材、时代和情绪主动推断合适视觉风格，在小说/剧本蓝图中明确记录推断结果，并在人物、道具、场景和视频提示词中一致沿用；不要求用户先选风格。",
        "可用工具：canvas_get_state、canvas_get_features、canvas_apply_ops。写入前先读画布，使用真实 ID；不要删除用户既有节点。",
        "canvas_apply_ops 单批最多 48 个操作、4 个 run_generation。文本卡正文用 metadata.content；生成卡用 metadata.prompt + metadata.model + metadata.generationMode。",
        "工作台卡：nodeType=workbench，metadata.workbenchKind=storyboard / digital-human / video-editor / novel / agent-creation；漏写会退化为故事分镜导演台。",
        `可用生图模型（原样使用 value）：${catalog.models.image.map((item) => item.value).join("、") || "无"}。`,
        `媒体工作流固定使用专用入口；默认参考NVIDIA模板，图像编辑已由用户明确切换完整Qwen Image 2.1链（非2511），用户可在设置→添加工作流→配置模型显式覆盖兼容权重：${JSON.stringify(CREATION_MEDIA_WORKFLOWS)}；程序按当前阶段覆盖model和分辨率，不得换用其他模型。图片设定按默认1K面积，视频按项目档位（1080P=768P底图+1.4二次采样）。音色必须提供metadata.audioVoiceDescription和试听文案prompt；配乐prompt为caption、audioLyrics可空为纯器乐。未找到精确权重/节点时报告缺失，不能选相似量化替代。`,
        `可用视频模型：${catalog.models.video.map((item) => item.value).join("、") || "无"}。`,
        "生成是异步任务；触发生成不等于生成成功，不要声称已生成或已合成成片。确有结果才进入下一阶段；每阶段完成后自动推进，不要求用户发送继续。媒体未返回时由程序等待真实结果，等待结束后自动接着做。",
        "进度由运行引擎保存，不要更新工作台节点。必须依次执行12环节：生成小说→生成剧本→人物素材→道具素材→场景素材→换装→年龄分级→配音音色→生成分镜脚本→视频提示词→生成背景音乐→总流水线。",
        "每阶段先 skill() 读全部有序绑定技能，再按当前阶段建卡，creation_complete_stage通过后才能切换。skill_reference读取参考全文，不能执行技能附带脚本。技能描述的外部工具需适配为本画布工具，不虚构可用工具。",
        "creation_get_pipeline读取完整计划与ID。剧本阶段用creation_set_plan一次规划所有素材、镜头与引用，素材包含character/prop/scene/costume/age；variant的parentId是人物基础图。空类别在omitted中写不需要的理由。",
        "素材阶段必须使用计划ID建image卡并run_generation；全部实际成功之前不得写分镜。配音/music用audio卡。分镜及视频提示词各镜一张text卡。最终pipeline阶段才使用计划videoNodeId建video卡；引擎从promptNodeId读取最终提示词并按referenceIds顺序连接参考图。视频卡自身prompt为空是合法的，直接run_generation(mode=video)，禁止因空值复制、重写或缩短已确认的提示词；状态中的promptSource说明真实来源是否就绪。",
        "创建媒体卡只写prompt/model等生成参数，禁止写status/content/storageKey伪造结果。写文本时用metadata.content。每批最多2个生成，等待用creation_wait；生成失败就明确待办，不标记完成。",
        "若某批被用户拒绝，不要改写参数再次提交同一改动；汇报待办并结束。",
        "产物布局由程序统一安排：阶段从上到下，阶段内从左到右，每行最多4张；不要通过坐标或set_viewport改变布局。流程展示连线由程序生成，只有计划规定的父人物/视频参考线参与生成输入。",
        "用户可在素材检查区重做单项媒体。creationOutput.needsRevision的媒体必须等待用户重生成并采用，不能自动覆盖；需要重做的文本在对应阶段更新正文后再核验。历史版本和候选均不算正式产物。",
        "素材命名只用人物姓名、物品名称、场景名称等简短语义标签（assets.label），换装/年龄变体含人物名；镜头label写镜头名称。voice/music在plan.outputNames按ID填人物音色/配乐名称，不得把提示词作标题或文件名。提示词仅写metadata.prompt。",
        "媒体等待由程序订阅状态，不要持续输出‘继续等待’，不要在普通阶段结束时要求用户继续。只有失败、无进展、审批拒绝、候选确认或用户停止才暂停。request_active只说明前端请求未返回，不代表ComfyUI已接单。",
        "历史聊天中的‘已提交/正在生成’不是执行证据。本轮必须实际调用工具；只有正文没有tool_calls时，程序不会执行其中描述的任何动作。",
        "中文简洁汇报实际结果和下一步。",
    ].join("\n");
}

function requestCreationApproval(task: RunningTask, summary: string) {
    return new Promise<boolean>((resolve) => {
        const signal = task.controller.signal;
        const finish = (approved: boolean) => {
            signal.removeEventListener("abort", abort);
            task.pendingApproval = null;
            useCreationAgentStore.getState().setPendingApproval(task.projectNodeId, null);
            resolve(approved);
        };
        const abort = () => finish(false);
        if (signal.aborted) return resolve(false);
        task.pendingApproval = { resolve: finish };
        signal.addEventListener("abort", abort, { once: true });
        useCreationAgentStore.getState().setPendingApproval(task.projectNodeId, { summary });
    });
}

async function executeCreationTool(name: string, input: Record<string, unknown>, task: RunningTask): Promise<unknown> {
    readTarget(task);
    if (task.userChat && !["canvas_get_state", "canvas_get_features", "creation_get_pipeline", "skill", "skill_reference"].includes(name)) throw new Error("项目聊天为只读讨论，不自动生成或修改画布。请使用启动/继续项目执行制作。");
    const state = pipelineState(task);
    const stage = currentCreationStage(state);
    if (name === "creation_get_pipeline") return { state, stage, config: task.pipelineConfig, render: task.render, videos: task.videos, expectedIds: stage ? expectedStageIds(stage, state.plan) : [], check: stage ? inspectCreationExecution(stage, state, targetSnapshot(task).nodes, task.projectNodeId, task.render, task.videos, readTarget(task).isGenerationActive) : { ready: true } };
    if (name === "skill") return loadStageSkills(task, typeof input.name === "string" ? input.name : undefined);
    if (name === "skill_reference") {
        if (!stage) return { error: "流水线已完成" };
        const entry = task.pipelineConfig.nodes[stage];
        const skillName = String(input.name || "");
        if (!entry.fallback && !entry.skills.includes(skillName)) throw new Error("此技能未绑定当前环节。");
        return { name: skillName, ref: input.ref, content: await loadCreationSkillReference(skillName, String(input.ref || ""), task.skillFiles) };
    }
    if (name === "creation_set_plan") {
        if (stage !== "script" || state.plan) throw new Error("计划仅能在剧本阶段设置一次；已锁定计划不能删减。");
        if (!task.loadedStages.has(stage)) throw new Error("请先读取当前环节skills。");
        const proposed = input.plan as Record<string, unknown> | undefined;
        const plan = validateCreationPlan(!task.backgroundMusic && proposed ? { ...proposed, musicIds: [], omitted: { ...(proposed.omitted as Record<string, unknown> || {}), music: "用户关闭自动背景音乐" } } : proposed);
        if (task.backgroundMusic && !plan.musicIds.length) throw new Error("用户已开启背景音乐，请在musicIds中规划至少一条独立配乐。");
        if ([...plan.assets.map((a) => a.id), ...plan.shots.flatMap((s) => [s.id, s.promptNodeId, s.videoNodeId]), ...plan.voiceIds, ...plan.musicIds].some((id) => targetSnapshot(task).nodes.some((n) => n.id === id))) throw new Error("计划ID与已有画布节点冲突。");
        writePipeline(task, { ...state, plan });
        return { ok: true, plan };
    }
    if (name === "creation_complete_stage") {
        if (stage === "pipeline" && task.videos && !task.render) throw new Error("真实视频需要先完成素材图，纯文本模式不能生成视频。");
        if (!stage) return { done: true };
        if (!task.loadedStages.has(stage)) throw new Error("请先读取当前环节skills。");
        for (const prior of state.completed) {
            const dependency = inspectCreationStage(prior, state, targetSnapshot(task).nodes, task.projectNodeId, task.render, task.videos);
            if (!dependency.ready) throw new Error(`前置 ${prior} 产物失效：${dependency.reasons.join("；")}`);
        }
        const check = inspectCreationStage(stage, state, targetSnapshot(task).nodes, task.projectNodeId, task.render, task.videos);
        if (!check.ready) return { error: check.reasons.join("；"), waiting: check.waiting };
        writePipeline(task, { ...state, completed: [...state.completed, stage] });
        if (stage === "pipeline" && task.videos) {
            const ctx = readTarget(task);
            const host = targetSnapshot(task).nodes.find((n) => n.id === task.projectNodeId)!;
            const editorId = `${task.projectNodeId}-editor`;
            if (!targetSnapshot(task).nodes.some((n) => n.id === editorId)) task.appliedSnapshot = ctx.applyOps([
                { type: "add_node", id: editorId, nodeType: "workbench", title: "视频剪辑台", position: { x: host.position.x + 500, y: host.position.y + 400 }, metadata: { workbenchKind: "video-editor" } },
                { type: "layout_creation", projectNodeId: task.projectNodeId },
            ]);
        }
        return { ok: true, completed: stage, next: currentCreationStage(pipelineState(task)), ...(stage === "pipeline" ? { delivery: "片段生成结束；最终合成需打开视频剪辑台点击合成成片。" } : {}) };
    }
    if (name === "creation_wait") {
        if (!stage) return { done: true };
        const result = await waitForCreationMedia(task, stage);
        if (result.ready || result.waiting) return result;
        const error = executionBlock(task, result);
        return { ...result, ...(error ? { error, pauseRun: true } : {}), message: error || `当前没有活动生成请求；请继续处理未完成产物：${result.outputs.map(o => `${o.id}=${o.status}`).join("；")}。不能空等。` };
    }
    if (name === "canvas_get_state") return { ...compactCanvasState(), creation: { state, stage } };
    if (name === "canvas_get_features") return canvasFeatureCatalog();
    if (name !== "canvas_apply_ops") return { error: `未知工具：${name}` };
    if (!stage || !task.loadedStages.has(stage)) throw new Error("写画布前必须用 skill() 读取当前阶段技能。");
    const rawOps = Array.isArray(input.ops) ? input.ops as CanvasAgentOp[] : [];
    // 在守卫前固定媒体入口；更新合并已有参数，生成前重申，旧项目重试也走专用工作流。
    const ops: CanvasAgentOp[] = rawOps.flatMap((op): CanvasAgentOp[] => {
        if (!task.render) return [op];
        if (op.type === "add_node") return [{ ...op, metadata: creationMediaMetadata(stage, task, op.metadata) }];
        if (op.type === "update_node") {
            const original = targetSnapshot(task).nodes.find((n) => n.id === op.id)?.metadata;
            return [{ ...op, metadata: creationMediaMetadata(stage, task, { prompt: original?.prompt, audioVoiceDescription: original?.audioVoiceDescription, audioLyrics: original?.audioLyrics, ...op.metadata }) }];
        }
        if (op.type === "run_generation" && !rawOps.some((candidate) => candidate.type === "add_node" && candidate.id === op.nodeId)) {
            const n = targetSnapshot(task).nodes.find((item) => item.id === op.nodeId);
            const settings = creationMediaMetadata(stage, task, { params: n?.metadata?.params });
            // 仅补强制配置，不能从旧快照取prompt/音色覆盖同批刚更新的内容。
            delete settings.audioLyrics;
            return [{ type: "update_node", id: op.nodeId, metadata: settings }, op];
        }
        return [op];
    });
    if (!ops.length) return { error: "ops 不能为空。" };
    // 预检以及审批后的二次预检都执行，防止确认期间依赖变化。
    guardCreationOps(ops, targetSnapshot(task).nodes, task.projectNodeId, pipelineState(task), task.render, task.videos);
    const applied = await applyApprovedCanvasOps({
        ops, summary: summarizeCanvasAgentOps(ops) || "修改当前画布",
        confirmTools: task.confirmBeforeApply,
        readContext: () => ({ ...readTarget(task), applyOps: (raw: CanvasAgentOp[]) => {
            const ctx = readTarget(task);
            const safe = guardCreationOps(raw, targetSnapshot(task).nodes, task.projectNodeId, pipelineState(task), task.render, task.videos);
            task.appliedSnapshot = ctx.applyOps([...safe, { type: "layout_creation", projectNodeId: task.projectNodeId }]);
            return task.appliedSnapshot;
        } }),
        requestApproval: (summary) => requestCreationApproval(task, summary),
        signal: task.controller.signal,
    });
    if ("error" in applied) return applied;
    return {
        ok: true, nodeCount: applied.snapshot.nodes.length, connectionCount: applied.snapshot.connections.length,
        message: ops.some((op) => op.type === "run_generation") ? "已请求前端调度生成，尚未确认后台接单；请读取流水线检查真实状态，不能仅凭此回执声称正在生成。" : "画布已更新。",
    };
}

export function resolveCreationApproval(projectNodeId: string, approved: boolean) {
    tasks.get(projectNodeId)?.pendingApproval?.resolve(approved);
}

export function stopCreationRun(projectNodeId: string) {
    const task = tasks.get(projectNodeId);
    if (!task) return;
    task.stopReason = "自动推进已停止。已提交的图片、视频或音频不会随之取消；结果返回后也不会自动重启Agent。";
    task.controller.abort();
    // 在 finally 里释放锁，避免旧任务的清理覆盖刚启动的新一轮。
}

const revisionRequests = new Set<string>();

/** User action, not an LLM tool: pause the project, preserve originals and render one candidate. */
export async function requestCreationRevision(projectNodeId: string, sourceNodeId: string, feedback: string) {
    if (revisionRequests.has(projectNodeId)) throw new Error("正在提交重生成，请勿重复点击。");
    if (!feedback.trim() || feedback.trim().length > 4000) throw new Error("请填写1–4000字修改要求。");
    const initial = useAgentStore.getState().canvasContext;
    const canvasId = initial?.snapshot.projectId;
    if (!initial?.snapshot.nodes.some(n => n.id === sourceNodeId && n.metadata?.creationOutput?.projectNodeId === projectNodeId)) throw new Error("素材不属于当前项目。");
    revisionRequests.add(projectNodeId);
    try {
        if (tasks.has(projectNodeId)) {
            stopCreationRun(projectNodeId);
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { unsubscribe(); reject(new Error("Agent 尚未停止，请稍后重试。")); }, 10000);
                const unsubscribe = useCreationAgentStore.subscribe(s => { if (!s.runs[projectNodeId]) { clearTimeout(timer); unsubscribe(); resolve(); } });
            });
        }
        const ctx = useAgentStore.getState().canvasContext;
        if (!ctx || ctx.snapshot.projectId !== canvasId) throw new Error("画布已切换，未提交重生成。");
        const candidateNodeId = creationId("revision");
        const source = ctx.snapshot.nodes.find(n => n.id === sourceNodeId)!;
        const next = ctx.applyOps([
            { type: "revise_creation", projectNodeId, revision: { action: "request", sourceNodeId, candidateNodeId, feedback, createdAt: Date.now() } },
            { type: "layout_creation", projectNodeId },
            { type: "run_generation", nodeId: candidateNodeId, mode: source.type as "image" | "video" | "audio" },
        ]);
        recordRevision(projectNodeId, next, `重做素材「${source.title}」：${feedback.trim()}`);
    } finally { revisionRequests.delete(projectNodeId); }
}
function recordRevision(projectNodeId: string, next: import("@/lib/canvas/canvas-agent-ops").CanvasAgentSnapshot, text: string) {
    const host = next.nodes.find(n => n.id === projectNodeId)!;
    const store = useCreationAgentStore.getState();
    const id = store.ensureConversation(projectNodeId, host.title);
    store.appendMessage(id, { id: creationId("revision-event"), role: "system", text });
    store.setProgress(id, { status: "ready", progress: host.metadata?.agentCreation?.progress || text, lastError: undefined });
}
function settleCreationRevision(projectNodeId: string, accept: boolean) {
    if (tasks.has(projectNodeId) || revisionRequests.has(projectNodeId)) throw new Error("项目正在运行，请先停止后操作。");
    const ctx = useAgentStore.getState().canvasContext;
    if (!ctx) throw new Error("当前画布未就绪。");
    const next = ctx.applyOps([
        { type: "revise_creation", projectNodeId, revision: accept ? { action: "accept", historyNodeId: creationId("revision-history") } : { action: "discard" } },
        { type: "layout_creation", projectNodeId },
    ]);
    recordRevision(projectNodeId, next, accept ? "用户已采用重生成新版，旧版保留，下游需按新版检查。" : "用户取消本次重做，保留原版。");
}
export function acceptCreationRevision(projectNodeId: string) { settleCreationRevision(projectNodeId, true); }
export function discardCreationRevision(projectNodeId: string) { settleCreationRevision(projectNodeId, false); }

/** 同步校验后启动，返回真实独立会话 ID；配置在一轮内固定，下轮使用最新共享配置。 */
export function startCreationRun(seed: AgentCreationSeed): string {
    const store = useCreationAgentStore.getState();
    if (!store.hydrated || !useCreationPipelineStore.getState().hydrated) throw new Error("创作会话或技能编排正在初始化，请稍后重试。");
    if (!seed.userMessage && seed.createVideos && !seed.createImages) throw new Error("视频制作必须先完成设定图，请开启素材图片生成。");
    if (seed.userMessage !== undefined && !seed.userMessage.trim()) throw new Error("请输入项目聊天消息。");
    if (!seed.userMessage && !seed.idea.trim()) throw new Error("请先输入故事想法或原文。");
    if (tasks.has(seed.projectNodeId) || revisionRequests.has(seed.projectNodeId)) throw new Error("这个项目正在创作或提交重做中；先停止或等它完成。");
    const runtime = resolveAgentRuntime(CREATION_CONNECTION, activePromptCloudApi(useConfigStore.getState().config));
    const context = useAgentStore.getState().canvasContext;
    const node = context?.snapshot.nodes.find((item) => item.id === seed.projectNodeId);
    if (!context || node?.metadata?.workbenchKind !== "agent-creation") throw new Error("请在目标画布中打开创作工作台。");
    const existingPipeline = node.metadata.creationPipeline;
    if (existingPipeline?.review && !seed.userMessage) throw new Error("素材重生成结果尚待确认，请先采用新版或取消本次重做。");
    if (existingPipeline?.completed.length && existingPipeline.render !== undefined && existingPipeline.render !== seed.createImages) throw new Error("已有阶段产物不能在纯文本预演与媒体制作间切换，请新建工作台。");
    const initialPipeline: CreationPipelineState = { ...(existingPipeline || { version: 1, completed: [] }), render: seed.createImages, videos: seed.createVideos, backgroundMusic: seed.backgroundMusic !== false };
    if (existingPipeline?.backgroundMusic === false && seed.backgroundMusic !== false && initialPipeline.plan) {
        const plan = structuredClone(initialPipeline.plan);
        if (!plan.musicIds.length) {
            const musicId = `${seed.projectNodeId}-bgm`;
            if (context.snapshot.nodes.some((n) => n.id === musicId && n.metadata?.creationOutput?.projectNodeId !== seed.projectNodeId)) throw new Error("配乐节点ID与其他项目冲突。");
            plan.musicIds = [musicId]; delete plan.omitted.music;
        }
        initialPipeline.plan = plan;
        initialPipeline.completed = initialPipeline.completed.filter((s) => !["music", "pipeline"].includes(s));
    }
    if (existingPipeline?.videos === false && seed.createVideos) initialPipeline.completed = initialPipeline.completed.filter((s) => s !== "pipeline");
    const conversationId = store.ensureConversation(seed.projectNodeId, seed.projectTitle);
    const task: RunningTask = {
        controller: new AbortController(), conversationId, projectNodeId: seed.projectNodeId,
        canvasId: context.snapshot.projectId, confirmBeforeApply: store.confirmBeforeApply,
        render: seed.createImages, videos: seed.createVideos, backgroundMusic: seed.backgroundMusic !== false,
        userChat: Boolean(seed.userMessage?.trim()), resolution: normalizeCreationResolution(seed.resolution), aspectRatio: seed.aspectRatio,
        pipelineConfig: structuredClone(useCreationPipelineStore.getState().config),
        skillFiles: useCreationPipelineStore.getState().files, loadedStages: new Set(),
        stopReason: "任务已停止。", pendingApproval: null,
    };
    // 只写一次初始 metadata；面板不能再用旧快照覆盖 conversationId。
    task.appliedSnapshot = context.applyOps([{ type: "update_node", id: seed.projectNodeId, metadata: { creationPipeline: initialPipeline, agentCreation: {
        ...node.metadata.agentCreation, idea: seed.idea.trim(), style: seed.style, aspectRatio: seed.aspectRatio,
        targetSeconds: Math.min(600, Math.max(5, seed.targetSeconds || 60)), createImages: seed.createImages, createVideos: seed.createVideos,
        resolution: task.resolution, backgroundMusic: task.backgroundMusic,
        status: "running", conversationId, progress: "创作 Agent 已启动。", lastError: undefined,
    } } }]);
    tasks.set(seed.projectNodeId, task);
    store.startRun(conversationId, seed.projectNodeId);
    store.setProgress(conversationId, { status: "running", progress: "创作 Agent 已启动。", lastError: undefined });
    // React 的 effect cleanup 会短暂设 null；等本轮微任务结束再判定真正离开。
    const unsubscribe = useAgentStore.subscribe((next, previous) => {
        if (next.canvasContext === previous.canvasContext) return;
        if (next.canvasContext) task.appliedSnapshot = next.canvasContext.snapshot;
        queueMicrotask(() => {
            if (tasks.get(seed.projectNodeId) !== task || task.controller.signal.aborted) return;
            const target = useAgentStore.getState().canvasContext;
            if (!target || target.snapshot.projectId !== task.canvasId || !target.snapshot.nodes.some((item) => item.id === seed.projectNodeId)) {
                task.stopReason = "画布已切换或工作台已移除，创作已安全停止。回到原画布后可继续项目。";
                task.controller.abort();
            }
        });
    });

    void (async () => {
        let liveId: string | null = null;
        let allReasoning = "";
        let executedTools = 0;
        let narrationRetries = 0;
        let lastContinuationKey = creationProgressKey(task);
        let observedStage = currentCreationStage(pipelineState(task));
        let continuedCompletedCount = pipelineState(task).completed.length;
        const turnId = creationId("turn");
        const ensureLive = () => {
            if (!liveId) {
                liveId = creationId("creation-live");
                useCreationAgentStore.getState().appendMessage(conversationId, { id: liveId, role: "assistant", text: "", streamId: liveId, turnId });
            }
            return liveId;
        };
        const patchLive = (patch: Partial<AgentChatMessageItem>) => {
            if (liveId) useCreationAgentStore.getState().patchMessage(conversationId, liveId, patch);
        };
        try {
            const history = store.conversationFor(seed.projectNodeId)?.messages || [];
            const apiMessages: ApiMessage[] = [{ role: "system", content: creationSystemPrompt(seed) }, ...rebuildChatHistory(history, () => undefined)];
            const promptText = buildAgentCreationTask(seed, seed.idea);
            if (!task.userChat) {
                const state = pipelineState(task), stage = currentCreationStage(state);
                apiMessages.push({ role: "user", content: `本轮启动时程序读取的真实流水线状态（优先于历史口头进度）：${JSON.stringify({ stage, check: stage ? inspectCreationExecution(stage, state, targetSnapshot(task).nodes, task.projectNodeId, task.render, task.videos, readTarget(task).isGenerationActive) : { ready: true } })}。不要从历史文字推断任务已提交。\n\n${promptText}` });
            } else apiMessages.push({ role: "user", content: promptText });
            store.appendMessage(conversationId, { id: creationId("creation-user"), role: "user", text: seed.userMessage?.trim() || (seed.continueExisting ? "继续这个项目" : "按项目资料启动创作"), promptText, turnId });
            for (let step = 0; step < MAX_CREATION_TOOL_STEPS; step += 1) {
                readTarget(task);
                const currentStage = currentCreationStage(pipelineState(task));
                // Limit non-progress loops per stage, not the whole twelve-stage project.
                if (currentStage !== observedStage) { observedStage = currentStage; step = 0; }
                if (!task.userChat && currentStage) {
                    const check = inspectCurrentExecution(task, currentStage);
                    const blocked = executionBlock(task, check);
                    if (blocked) throw new Error(blocked);
                    if (check.waiting) {
                        const result = await waitForCreationMedia(task, currentStage);
                        if (result.pauseRun) throw new Error(result.error || result.message || "媒体等待已暂停。");
                        apiMessages.push({ role: "user", content: `程序收到媒体状态更新：${JSON.stringify(result)}。请根据真实结果自动继续剩余产物或完成阶段，不重提已有请求。` });
                    }
                }
                let roundContent = "";
                const response = await requestAgentChat(runtime, {
                    model: runtime.model, messages: apiMessages,
                    tools: task.userChat ? creationTools().filter((tool) => ["canvas_get_state", "canvas_get_features", "creation_get_pipeline", "skill", "skill_reference"].includes(tool.function.name)) : creationTools(), tool_choice: "auto", stream: true,
                }, task.controller.signal);
                const reply = await readAgentChatResponse(response, {
                    signal: task.controller.signal, apiKey: runtime.apiKey,
                    onDelta: (delta: StreamDelta) => {
                        if (task.controller.signal.aborted) return;
                        if (delta.reasoning) {
                            allReasoning += delta.reasoning;
                            ensureLive(); patchLive({ reasoning: allReasoning });
                        }
                        if (delta.content) {
                            roundContent += delta.content;
                            ensureLive(); patchLive({ text: !task.userChat && !executedTools ? "正在读取模型响应；尚未收到本轮实际操作调用。" : roundContent });
                        }
                    },
                });
                readTarget(task);
                if (reply.toolCalls.length) {
                    apiMessages.push({ role: "assistant", content: reply.content || null, provider_metadata: reply.providerMetadata,
                        ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}), tool_calls: reply.toolCalls.map((call) => ({ ...call, type: "function" })) });
                    if (liveId) patchLive({ text: reply.content || "", streamId: undefined });
                    liveId = null;
                    for (const call of reply.toolCalls) {
                        const name = call.function?.name || "";
                        let result: unknown;
                        let summary = name;
                        try {
                            const input = JSON.parse(call.function?.arguments || "{}") as Record<string, unknown>;
                            if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("工具参数必须是对象。");
                            if (name === "canvas_apply_ops" && Array.isArray(input.ops)) summary = summarizeCanvasAgentOps(input.ops as CanvasAgentOp[]) || name;
                            result = await executeCreationTool(name, input, task);
                            executedTools += 1;
                        } catch (error) {
                            readTarget(task); // 停止或切换不是模型可以重试的普通工具错误。
                            result = { error: redactAgentError(error instanceof Error ? error.message : String(error), runtime.apiKey) };
                        }
                        apiMessages.push({ role: "tool", tool_call_id: call.id || "", content: JSON.stringify(result) });
                        const error = result && typeof result === "object" && "error" in result ? String(result.error) : "";
                        const detail = result && typeof result === "object" ? result as Record<string, unknown> : {};
                        store.appendMessage(conversationId, { id: creationId("creation-tool"), role: "tool", title: name, text: error ? `${summary}：${error}` : `${summary}：${typeof detail.message === "string" ? detail.message : "已执行"}`, turnId });
                        store.bumpStep(seed.projectNodeId);
                        if (detail.pauseRun === true) {
                            const text = error || String(detail.message || "生成未完成，本轮已暂停，不再循环空等；请查看媒体状态后继续。");
                            store.appendMessage(conversationId, { id: creationId("creation-wait-status"), role: "system", text, turnId });
                            saveProgress(task, error ? "error" : "ready", text, error || undefined);
                            return;
                        }
                        saveProgress(task, "running", error ? `本批需调整：${error}` : `已完成 ${useCreationAgentStore.getState().runs[seed.projectNodeId]?.step || 0} 次工具调用：${summary}`);
                        if (error.includes("用户拒绝")) {
                            saveProgress(task, "ready", "本批写入已拒绝，未执行。可调整要求后继续项目。");
                            return;
                        }
                    }
                    continue;
                }
                const answer = reply.content.trim();
                if (!answer) throw new Error("模型返回了空消息。");
                if (!task.userChat && task.render && !executedTools && currentCreationStage(pipelineState(task))) {
                    const status = "模型只返回了执行描述，没有实际操作调用；本轮没有因此提交任何生成任务。";
                    ensureLive(); patchLive({ text: status, streamId: undefined }); liveId = null;
                    if (narrationRetries++ === 0) {
                        apiMessages.push({ role: "assistant", content: answer });
                        apiMessages.push({ role: "user", content: "上述只是文字，没有发生操作。请现在实际调用 creation_get_pipeline 和 canvas_get_state 核对状态，再按工具结果继续；不要模拟工具结果、不要反复声称已提交或正在等待。若不能调用工具，请直接说明。" });
                        continue;
                    }
                    throw new Error(`${status} 已停止自动重试，请检查云端模型/渠道是否支持工具调用。`);
                }
                let verifiedAnswer = answer;
                if (!task.userChat) {
                    const stage = currentCreationStage(pipelineState(task));
                    if (stage) {
                        let check = inspectCurrentExecution(task, stage);
                        const blocked = executionBlock(task, check);
                        if (blocked) throw new Error(blocked);
                        if (check.waiting) {
                            const result = await waitForCreationMedia(task, stage);
                            if (result.pauseRun) throw new Error(result.error || result.message || "媒体等待已暂停。");
                            check = result;
                        }
                        if (check.ready && task.loadedStages.has(stage)) {
                            const result = await executeCreationTool("creation_complete_stage", {}, task) as { error?: string };
                            if (result.error) throw new Error(result.error);
                            store.appendMessage(conversationId, { id: creationId("auto-stage"), role: "system", text: `${CREATION_STAGES.find(s => s.id === stage)!.label}已通过产物核验，自动进入下一阶段。`, turnId });
                        }
                        const next = currentCreationStage(pipelineState(task));
                        const key = creationProgressKey(task);
                        const progressed = key !== lastContinuationKey || pipelineState(task).completed.length > continuedCompletedCount;
                        if (next && (progressed || (check.ready && narrationRetries++ === 0))) {
                            lastContinuationKey = key;
                            continuedCompletedCount = pipelineState(task).completed.length;
                            const text = `自动推进：${CREATION_STAGES.find(s => s.id === next)!.label}。无需手动发送继续。`;
                            ensureLive(); patchLive({ text, streamId: undefined }); liveId = null;
                            saveProgress(task, "running", text);
                            apiMessages.push({ role: "assistant", content: answer });
                            apiMessages.push({ role: "user", content: `${text} 请先读取本阶段技能，继续实际工具操作；阶段状态：${JSON.stringify(inspectCurrentExecution(task, next))}。` });
                            continue;
                        }
                        if (next && task.render) verifiedAnswer = `自动推进已暂停：当前阶段没有新的产物进展，也没有活动请求。${check.outputs.map(o => `${o.id}=${o.status}`).join("；")}。请检查模型工具调用或缺失依赖，不会重复空等或自动重提。`;
                        if (!next) verifiedAnswer = task.videos ? "12阶段已完成，视频片段已核验。可打开视频剪辑台合成成片；尚未自动合成。" : "12阶段已完成，本次所需产物已核验。";
                    }
                }
                ensureLive(); patchLive({ text: verifiedAnswer, reasoning: allReasoning || undefined, streamId: undefined });
                liveId = null;
                saveProgress(task, "ready", verifiedAnswer.slice(-2600));
                return;
            }
            throw new Error(`已达到当前阶段无进展保护上限（${MAX_CREATION_TOOL_STEPS} 轮）。自动推进已暂停，已完成产物保留；请检查模型调用和依赖后恢复。`);
        } catch (error) {
            if (liveId) patchLive({ streamId: undefined });
            const stopped = task.controller.signal.aborted;
            const text = stopped ? task.stopReason : redactAgentError(error instanceof Error ? error.message : String(error), runtime.apiKey);
            store.appendMessage(conversationId, { id: creationId("creation-status"), role: stopped ? "system" : "error", text, turnId });
            saveProgress(task, "error", text, text);
        } finally {
            unsubscribe();
            task.pendingApproval?.resolve(false);
            if (tasks.get(seed.projectNodeId) === task) {
                tasks.delete(seed.projectNodeId);
                store.endRun(seed.projectNodeId);
            }
        }
    })();
    return conversationId;
}
