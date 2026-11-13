import type { AiTextMessage } from "@/services/api/image";
import i18n from "@/i18n";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, isAudioNodeType } from "@/types/canvas";
import { getGenerationResourceNodes, getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { appendGenerationText } from "@/lib/canvas/generation-prompt";
import { getNodeDefinition } from "@/lib/canvas/node-registry";

export type NodeLora = { name: string; strength: number };

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    loras: NodeLora[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

type NodeGenerationResourceInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio" | "lora";
    title: string;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
    loras?: NodeLora[];
};

type NodeGenerationGroupInput = {
    nodeId: string;
    type: "group";
    title: string;
    children: NodeGenerationResourceInput[];
};

export type NodeGenerationInput = NodeGenerationResourceInput | NodeGenerationGroupInput;

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string, options?: { audio?: boolean }): NodeGenerationContext {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
    const sourceNode = nodes.find((node) => node.id === nodeId);
    // 音频只用用户自己填写的内容：拼接上游文本会带上【文本N】这类固定标签，
    // 朗读时会被念出来、音乐会把它当歌词。音频节点自身，或以音频模式生成，都算音频。
    const isAudio = Boolean(options?.audio) || sourceNode?.type === CanvasNodeType.Audio;
    if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) {
        return buildComposerGenerationContext(inputs, prompt, { stripTextBlocks: isAudio });
    }

    const resourceInputs = flattenGenerationInputs(inputs);
    let textIndex = 0;
    const upstreamText = resourceInputs.flatMap((input) => (input.text ? [{ label: generationLabel("text", textIndex++), text: input.text }] : []));
    const referenceImages = resourceInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = resourceInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = resourceInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));
    const loras = resourceInputs.flatMap((input) => (input.type === "lora" ? input.loras || [] : []));

    return {
        prompt: isAudio ? prompt : appendGenerationText(prompt, upstreamText),
        referenceImages,
        referenceVideos,
        referenceAudios,
        loras,
        textCount: resourceInputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

// 二级/子卡自身没有 LoRA，沿连线往上游找最近一层带 LoRA 的节点。
export function collectNodeLoras(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], maxDepth = 8): NodeLora[] {
    const seen = new Set<string>();
    let queue = [nodeId];
    for (let depth = 0; depth <= maxDepth && queue.length; depth += 1) {
        const next: string[] = [];
        for (const id of queue) {
            if (seen.has(id)) continue;
            seen.add(id);
            const node = nodes.find((item) => item.id === id);
            if (!node) continue;
            const stored = node.metadata?.params?.loras;
            if (Array.isArray(stored)) {
                const loras = stored.flatMap((item) => {
                    const name = typeof item?.name === "string" ? item.name.trim() : "";
                    const strength = Number(item?.strength);
                    return name && Number.isFinite(strength) ? [{ name, strength }] : [];
                });
                if (loras.length) return loras;
            }
            const contextLoras = buildNodeGenerationContext(id, nodes, connections, "").loras;
            if (contextLoras.length) return contextLoras;
            for (const connection of connections) {
                if (connection.toNodeId === id && !seen.has(connection.fromNodeId)) next.push(connection.fromNodeId);
            }
        }
        queue = next;
    }
    return [];
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string, { stripTextBlocks = false }: { stripTextBlocks?: boolean } = {}): NodeGenerationContext {
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const selectedInputs: NodeGenerationResourceInput[] = [];
    const labelByNodeId = new Map<string, string>();
    const textBlocks: string[] = [];
    const counts = { image: 0, video: 0, audio: 0, text: 0, lora: 0 };
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const input = inputByNodeId.get(match[1]);
        if (input) {
            const labels = flattenGenerationInputs([input]).map((resource) => {
                let label = labelByNodeId.get(resource.nodeId);
                if (!label) {
                    label = generationLabel(resource.type, counts[resource.type]++);
                    labelByNodeId.set(resource.nodeId, label);
                    if (resource.type === "text") textBlocks.push(textBlock(label, resource.text || ""));
                    else selectedInputs.push(resource);
                }
                // 音频只保留用户自己写的文本：不插入【文本N】标记，也不展开上游文本内容。
                if (stripTextBlocks) return "";
                return resource.type === "text" ? `【${label}】` : label;
            });
            nextPrompt += labels.join("、");
        }
        lastIndex = match.index + match[0].length;
    }

    nextPrompt += prompt.slice(lastIndex);
    if (stripTextBlocks) {
        // 去掉为 @令牌 留下的多余分隔符，避免朗读/歌词里出现「、、」或空行。
        nextPrompt = nextPrompt.replace(/[、,，]\s*(?=[、,，]|$)/g, "").replace(/^\s*[、,，]\s*/gm, "").trim();
    } else if (textBlocks.length) {
        nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;
    }
    const referenceImages = selectedInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = selectedInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = selectedInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));
    const loras = flattenGenerationInputs(inputs).flatMap((input) => (input.type === "lora" ? input.loras || [] : []));

    if (!hasToken) {
        return {
            prompt,
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            loras,
            textCount: 0,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
    }

    return {
        prompt: nextPrompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        loras,
        textCount: counts.text,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
    return getGenerationResourceNodes(nodeId, nodes, connections).flatMap((node): NodeGenerationInput[] => {
        if (node.type === CanvasNodeType.Group) {
            const children = getGroupResourceNodes(node.id, nodes).flatMap(readNodeGenerationResource);
            return children.length ? [{ nodeId: node.id, type: "group", title: node.title, children }] : [];
        }
        return readNodeGenerationResource(node);
    });
}

function flattenGenerationInputs(inputs: NodeGenerationInput[]) {
    const resources = inputs.flatMap((input) => (input.type === "group" ? input.children : [input]));
    return [...new Map(resources.map((input) => [input.nodeId, input])).values()];
}

function readNodeGenerationResource(node: CanvasNodeData): NodeGenerationResourceInput[] {
    const image = readReferenceImage(node);
    if (image) return [{ nodeId: node.id, type: "image", title: node.title, image }];
    const video = readReferenceVideo(node);
    if (video) return [{ nodeId: node.id, type: "video", title: node.title, video }];
    const audio = readReferenceAudio(node);
    if (audio) return [{ nodeId: node.id, type: "audio", title: node.title, audio }];
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    if (resource?.kind === "image" && resource.url) return [{ nodeId: node.id, type: "image", title: node.title, image: { id: node.id, name: mediaFileName(node.title, node.id, "png"), type: node.metadata?.mimeType || "image/png", dataUrl: resource.url, storageKey: node.metadata?.storageKey } }];
    if (resource?.kind === "video" && resource.url) return [{ nodeId: node.id, type: "video", title: node.title, video: { id: node.id, name: mediaFileName(node.title, node.id, "mp4"), type: node.metadata?.mimeType || "video/mp4", url: resource.url, storageKey: node.metadata?.storageKey, durationMs: node.metadata?.durationMs } }];
    if (resource?.kind === "audio" && resource.url) return [{ nodeId: node.id, type: "audio", title: node.title, audio: { id: node.id, name: mediaFileName(node.title, node.id, "mp3"), type: node.metadata?.mimeType || "audio/mpeg", url: resource.url, storageKey: node.metadata?.storageKey } }];
    if (resource?.kind === "lora" && resource.loras?.length) return [{ nodeId: node.id, type: "lora", title: node.title, loras: resource.loras }];
    if (resource?.kind === "text" && resource.text) return [{ nodeId: node.id, type: "text", title: node.title, text: resource.text }];
    const text = readNodeTextInput(node);
    return text ? [{ nodeId: node.id, type: "text", title: node.title, text }] : [];
}

export function buildNodeResponseMessages(context: NodeGenerationContext): AiTextMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    return { ...context, referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))) };
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

function textBlock(label: string, text: string) {
    return `【${label}】\n${text}`;
}

function generationLabel(type: NodeGenerationResourceInput["type"], index: number) {
    if (type === "image") return imageReferenceLabel(index);
    if (type === "video") return i18n.t("canvas.configNode.videoReferences") + ` ${index + 1}`;
    if (type === "audio") return i18n.t("canvas.configNode.audioReferences") + ` ${index + 1}`;
    if (type === "lora") return `LoRA ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

const MEDIA_EXTENSION_RE = /\.(png|jpe?g|webp|gif|bmp|mp4|webm|mov|mkv|avi|mp3|wav|ogg|m4a|flac)$/i;

function mediaFileName(title: string | undefined, id: string, extension: string) {
    const name = (title || id).trim();
    return MEDIA_EXTENSION_RE.test(name) ? name : `${name}.${extension}`;
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (node.type !== CanvasNodeType.Image || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: mediaFileName(node.title, node.id, "png"),
        type: node.metadata.mimeType || "image/png",
        dataUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
    };
}

function readReferenceVideo(node: CanvasNodeData): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: mediaFileName(node.title, node.id, "mp4"),
        type: node.metadata.mimeType || "video/mp4",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: node.metadata.naturalWidth,
        height: node.metadata.naturalHeight,
        durationMs: node.metadata.durationMs,
    };
}

/** 把音频节点自身的产物读成参考音频：音色克隆可以直接拿当前节点当参考音色。 */
export function audioReferenceFromNode(node: CanvasNodeData | undefined): ReferenceAudio | null {
    return node ? readReferenceAudio(node) : null;
}

function readReferenceAudio(node: CanvasNodeData): ReferenceAudio | null {
    if (!isAudioNodeType(node.type) || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: mediaFileName(node.title, node.id, "mp3"),
        type: node.metadata.mimeType || "audio/mpeg",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        durationMs: node.metadata.durationMs,
    };
}
