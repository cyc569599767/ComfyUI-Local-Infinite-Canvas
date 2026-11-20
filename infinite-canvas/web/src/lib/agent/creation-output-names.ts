import type { CanvasNodeData } from "@/types/canvas";
import type { CreationPlan, CreationStageId } from "./creation-pipeline";

const STAGE_NAMES: Record<CreationStageId, string> = { novel: "小说", script: "剧本", character: "人物", prop: "物品", scene: "场景", costume: "换装", age: "年龄变体", voice: "音色", storyboard: "分镜", video_prompt: "视频提示词", music: "背景音乐", pipeline: "视频" };
/** Human label, never a prompt; remove filename/control syntax but preserve Chinese. */
export function safeCreationName(value: string, fallback = "素材") {
    const cleaned = Array.from(String(value || "").normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"/\\|?*%]/g, "_").replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, "")).slice(0, 80).join("").replace(/[. ]+$/g, "");
    const name = cleaned || fallback;
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}
export function creationPlanName(plan: CreationPlan | undefined, id: string, stage: CreationStageId, fallback = "") {
    const asset = plan?.assets.find(a => a.id === id);
    if (asset) {
        const parent = asset.parentId && plan?.assets.find(a => a.id === asset.parentId)?.label;
        return safeCreationName(parent && !asset.label.includes(parent) ? `${parent}-${asset.label}` : asset.label);
    }
    const shot = plan?.shots.find(s => [s.id, s.promptNodeId, s.videoNodeId].includes(id));
    if (shot) return safeCreationName(`${shot.label}-${STAGE_NAMES[stage]}`);
    const named = plan?.outputNames?.[id];
    if (named) return safeCreationName(named);
    return safeCreationName(fallback || `${STAGE_NAMES[stage]}-${id}`);
}
export function creationOutputName(node: CanvasNodeData, nodes: CanvasNodeData[] = []) {
    const output = node.metadata?.creationOutput;
    if (!output) return undefined;
    const host = nodes.find(n => n.id === output.projectNodeId);
    const id = output.revisionOf || node.id;
    // Older cards often have the first 32 prompt characters as their title.
    const prompt = node.metadata?.prompt?.trim() || "";
    const title = (node.title?.trim() || "").replace(/\s*·\s*(待确认新版|未采用版本|历史版本|已采用记录)$/, "");
    const cleanTitle = title && !(prompt && (prompt.startsWith(title) || title.startsWith(prompt))) ? title : "";
    const base = creationPlanName(host?.metadata?.creationPipeline?.plan, id, output.stage, output.name || cleanTitle);
    const accepted = output.revisionAccepted || /·\s*已采用记录$/.test(node.title || "");
    const version = output.revisionKind === "candidate" ? "待确认新版" : output.revisionKind === "discarded" ? "未采用版本" : output.revisionKind === "history" ? (accepted ? "已采用记录" : "历史版本") : "";
    return version ? `${base} · ${version}` : base;
}
export function creationAssetDownloadName(asset: { id: string; title: string; metadata?: Record<string, unknown> }, extension: string) {
    if (!asset.metadata?.creationOutput) return undefined;
    const identity = asset.id.replace(/[^A-Za-z0-9_-]/g, "") || "media";
    return `${safeCreationName(asset.title)}_${identity}.${extension.replace(/[^a-z0-9]/gi, "") || "bin"}`;
}
export function creationDownloadName(node: CanvasNodeData, nodes: CanvasNodeData[], extension: string, imageId?: string) {
    const name = creationOutputName(node, nodes);
    if (!name) return undefined;
    const identity = String(imageId || node.metadata?.storageKey || node.id).replace(/[^A-Za-z0-9_-]/g, "").slice(-12) || "media";
    return `${safeCreationName(name)}_${identity}.${extension.replace(/[^a-z0-9]/gi, "") || "bin"}`;
}
