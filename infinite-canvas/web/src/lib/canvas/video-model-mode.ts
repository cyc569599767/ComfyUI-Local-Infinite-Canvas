import { channelModelOf, modelOptionName, workflowModelOptions, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

const NO_VDN_SUFFIX = "-novdn";

export function videoWorkflowId(config: AiConfig, model: string) {
    return channelModelOf(config, model)?.model.workflowId || modelOptionName(model);
}

export function isNoVdnWorkflowId(workflowId: string) {
    return String(workflowId || "").endsWith(NO_VDN_SUFFIX);
}

export function isFastH3Model(config: AiConfig, model: string) {
    return baseVideoWorkflowId(videoWorkflowId(config, model)) === "video-h3-fast";
}

export function baseVideoWorkflowId(workflowId: string) {
    return String(workflowId || "").replace(/-novdn$/, "");
}

/** Fixed H3 workflows define their input contract even if a saved card carries
 * a stale mode. Fast draft and other providers remain user-configurable.
 * Resolve metadata before stripping the no-VDN suffix (base-model variants may
 * have a different model name while sharing this workflow ID).
 */
export function resolveVideoWorkflowMode(config: AiConfig, model: string, mode: string) {
    const id = baseVideoWorkflowId(videoWorkflowId(config, model));
    if (id === "creation-video-h3-768" || id === "creation-video-h3-1080") return "reference";
    if (id === "video-h3-ref2va" || id === "video-h3-character-swap") return "reference";
    if (id === "video-h3-frames") return "frames";
    if (id === "video-h3-t2v") return "text";
    return mode;
}

export function videoModelForWorkflow(config: AiConfig, workflowId: string, options?: { noVdn?: boolean }) {
    const optionsList = workflowModelOptions(config, "video");
    const target = options?.noVdn ? `${workflowId}${NO_VDN_SUFFIX}` : workflowId;
    const exact = optionsList.find((value) => videoWorkflowId(config, value) === target);
    if (exact) return exact;
    return optionsList.find((value) => videoWorkflowId(config, value) === workflowId) || "";
}

export function videoModelModePatch(config: AiConfig, model: string): Partial<NonNullable<CanvasNodeData["metadata"]>> {
    const workflowId = baseVideoWorkflowId(videoWorkflowId(config, model));
    if (workflowId === "video-h3-ref2va") return { model, videoMode: "reference" };
    if (workflowId === "video-h3-character-swap") return { model, videoMode: "reference" };
    if (workflowId === "video-h3-frames") return { model, videoMode: "frames" };
    if (workflowId === "video-h3-fast") return { model, videoMode: "frames" };
    if (workflowId === "video-h3-t2v") return { model, videoMode: "text" };
    return { model };
}
// ── 上游 v0.25.x 追加：HyperFlow（6+2）也属于多模式工作流 ──
const HYPERFLOW_FAMILY = /^video-hyperflow-(t2v|frames|ref2va)-6p2$/;
const H3_MULTI_MODE_IDS = new Set(["video-h3-ref2va"]);

/** HyperFlow 三种模式共用一条工作流：t2v/frames/ref2va 分别对应 text/frames/reference。 */
export function hyperflowModeOf(workflowId: string): "text" | "frames" | "reference" | undefined {
    const match = HYPERFLOW_FAMILY.exec(baseVideoWorkflowId(workflowId));
    if (!match) return undefined;
    return match[1] === "t2v" ? "text" : match[1] === "frames" ? "frames" : "reference";
}

/** 多模式工作流：模式内切换，不换模型。 */
export function isMultiModeVideoWorkflow(workflowId: string) {
    const base = baseVideoWorkflowId(workflowId);
    return H3_MULTI_MODE_IDS.has(base) || Boolean(hyperflowModeOf(base));
}
