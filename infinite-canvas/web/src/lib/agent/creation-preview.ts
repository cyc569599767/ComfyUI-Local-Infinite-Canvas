import type { CanvasNodeData } from "@/types/canvas";
import { creationVideoPromptSource } from "./creation-pipeline";

export function creationPreviewText(node?: CanvasNodeData, nodes: CanvasNodeData[] = []) {
    const metadata = node?.metadata;
    let prompt = "";
    let source: "prompt" | "generationInputPrompt" | "video_prompt" | "missing" = "missing";
    if (metadata?.prompt?.trim()) {
        prompt = metadata.prompt;
        source = "prompt";
    } else if (metadata?.generationInputPrompt?.trim()) {
        prompt = metadata.generationInputPrompt;
        source = "generationInputPrompt";
    } else if (node?.type === "video" && metadata?.creationOutput?.stage === "pipeline" && !metadata.creationOutput.revisionKind) {
        const projectNodeId = metadata.creationOutput.projectNodeId;
        const state = nodes.find(item => item.id === projectNodeId)?.metadata?.creationPipeline;
        if (state) {
            const linked = creationVideoPromptSource(node.id, state, nodes, projectNodeId);
            if (linked.ready) {
                prompt = linked.prompt;
                source = "video_prompt";
            }
        }
    }
    const details: Array<{ label: string; text: string }> = [];
    if (node?.type === "audio") {
        if (metadata?.creationOutput?.stage === "voice" || metadata?.audioMode === "voice-design" || metadata?.audioMode === "voice-clone") {
            details.push({ label: "音色描述", text: metadata.audioVoiceDescription?.trim() ? metadata.audioVoiceDescription : "未保存音色描述。" });
        }
        if (metadata?.creationOutput?.stage === "music" || metadata?.audioMode === "music") {
            details.push({ label: "歌词", text: metadata.audioLyrics === undefined ? "未保存歌词记录。" : metadata.audioLyrics.trim() ? metadata.audioLyrics : "纯器乐（无歌词）" });
        }
    }
    return { prompt, source, label: source === "video_prompt" ? "关联提示词（尚无生成记录）" : "原提示词", details };
}
