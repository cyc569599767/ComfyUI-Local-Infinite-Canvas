import { LOCAL_GATEWAY_CHANNEL_ID } from "@/constant/app-mode";
import type { CanvasNodeMetadata } from "@/types/canvas";
import type { CreationStageId } from "./creation-pipeline";
import { normalizeCreationResolution, type CreationResolution } from "./creation-settings";

export const CREATION_MEDIA_WORKFLOWS = {
    image: "creation-image-krea2", edit: "creation-image-qwen21-edit",
    video: "creation-video-h3-768", video1080: "creation-video-h3-1080",
    voice: "creation-audio-voice-design", clone: "creation-audio-voice-clone", music: "creation-audio-music",
} as const;
export type CreationMediaSettings = { resolution?: CreationResolution; aspectRatio: "16:9" | "9:16" | "1:1"; backgroundMusic?: boolean };
export function creationWorkflowFor(stage: CreationStageId, resolution?: CreationResolution) {
    if (["character", "prop", "scene"].includes(stage)) return CREATION_MEDIA_WORKFLOWS.image;
    if (["costume", "age"].includes(stage)) return CREATION_MEDIA_WORKFLOWS.edit;
    if (stage === "voice") return CREATION_MEDIA_WORKFLOWS.voice;
    if (stage === "music") return CREATION_MEDIA_WORKFLOWS.music;
    if (stage === "pipeline") return normalizeCreationResolution(resolution) === "1080p" ? CREATION_MEDIA_WORKFLOWS.video1080 : CREATION_MEDIA_WORKFLOWS.video;
    return null;
}
/** 基础图片按参考项目1K面积并向上对齐32，不把视频档位错误套到设定图。 */
export function creationImageSize(ratio: CreationMediaSettings["aspectRatio"]) {
    const [w, h] = ratio.split(":").map(Number);
    const width = Math.ceil(Math.sqrt(1e6 * w / h) / 32) * 32;
    const height = Math.ceil(Math.sqrt(1e6 * h / w) / 32) * 32;
    return `${width}x${height}`;
}
/** 项目设置强制覆盖模型随意指定的参数，不修改提示词/既有生成结果。 */
export function creationMediaMetadata(stage: CreationStageId, settings: CreationMediaSettings, source: CanvasNodeMetadata = {}): CanvasNodeMetadata {
    const workflow = creationWorkflowFor(stage, settings.resolution);
    if (!workflow) return source;
    if (stage === "music" && settings.backgroundMusic === false) throw new Error("项目已关闭背景音乐，不能提交配乐。");
    const result: CanvasNodeMetadata = { ...source, model: `${LOCAL_GATEWAY_CHANNEL_ID}::${workflow}`, aspectRatio: settings.aspectRatio, count: 1 };
    // 只沿用种子和前端业务所需参数，禁止Agent覆盖工作流模型/LoRA/采样等默认配置。
    const params: Record<string, unknown> = {};
    if (source.params?.seed !== undefined) params.seed = source.params.seed;
    if (stage === "pipeline") {
        result.videoMode = "reference";
        result.videoInterpolation = "off";
        result.size = settings.aspectRatio;
        result.vquality = normalizeCreationResolution(settings.resolution);
        result.generateAudio = "true";
        params.resolution = normalizeCreationResolution(settings.resolution).toUpperCase();
        params.aspect_ratio = settings.aspectRatio;
    } else if (["character", "prop", "scene"].includes(stage)) {
        result.size = creationImageSize(settings.aspectRatio); result.imageMode = "t2i"; result.generationType = "generation";
    } else if (stage === "costume" || stage === "age") {
        result.imageMode = "edit"; result.generationType = "edit";
    } else if (stage === "voice") result.audioMode = "voice-design";
    else if (stage === "music") { result.audioMode = "music"; result.audioLyrics = source.audioLyrics?.trim() || " "; }
    result.params = params;
    return result;
}
