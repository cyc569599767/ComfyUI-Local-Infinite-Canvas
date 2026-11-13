import { CanvasNodeType } from "@/types/canvas";

/**
 * 连接点弹出菜单的左右两套配置。
 *
 * - 左侧连接点（handleType = "target"）：拖出去表示「给我接一个上游」，
 *   新节点是当前节点的输入，所以列的是**节点类型**（文本 / 图片 / 视频 / 音频），
 *   标题为「引用节点」。注入型插件（insertBefore，如 LoRA）也属于上游，只在这里出现。
 * - 右侧连接点（handleType = "source"）：拖出去表示「往下游生成」，
 *   新节点是当前节点的产物，所以列的是**生成动作**（文本生成 / 图片生成 / 视频生成 / 音频生成），
 *   标题为「引用该节点生成」。插件是上游注入、音频参考要的是已有音频，两者在这里都不成立，故不列出。
 *
 * 「音频生成」用的是 VoiceDesign 节点（预设 voice-design 模式的空音频节点），
 * 普通音频节点只在左侧和工具栏出现。
 */
export type ConnectionMenuSide = "left" | "right";

export function connectionMenuSide(handleType: "source" | "target"): ConnectionMenuSide {
    return handleType === "target" ? "left" : "right";
}

const LEFT_TYPES: readonly CanvasNodeType[] = [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio];

const RIGHT_TYPES: readonly CanvasNodeType[] = [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.VoiceDesign];

export function connectionCreateTypes(side: ConnectionMenuSide): readonly CanvasNodeType[] {
    return side === "left" ? LEFT_TYPES : RIGHT_TYPES;
}

/** 插件只在左侧（上游注入）出现。 */
export function connectionMenuShowsPlugins(side: ConnectionMenuSide): boolean {
    return side === "left";
}

/** 标题：左侧「引用节点」，右侧「引用该节点生成」。 */
export function connectionMenuTitleKey(side: ConnectionMenuSide): string {
    return side === "left" ? "canvas.createMenu.referenceNode" : "canvas.createMenu.fromNode";
}

/** 左侧列节点类型名（文本 / 图片 / 视频 / 音频），右侧列生成动作名（文本生成 / …）。 */
export function connectionMenuTitleTextKey(side: ConnectionMenuSide, type: CanvasNodeType): string {
    if (side === "left") return `canvas.nodeTypes.${type}`;
    switch (type) {
        case CanvasNodeType.Text:
            return "canvas.createMenu.text";
        case CanvasNodeType.Image:
            return "canvas.createMenu.image";
        case CanvasNodeType.Video:
            return "canvas.createMenu.video";
        case CanvasNodeType.VoiceDesign:
            return "canvas.createMenu.audioGenerate";
        default:
            return `canvas.nodeTypes.${type}`;
    }
}

/** 只有右侧的「文本生成」「音频生成」带副标题。 */
export function connectionMenuDescriptionKey(side: ConnectionMenuSide, type: CanvasNodeType): string | null {
    if (side !== "right") return null;
    if (type === CanvasNodeType.Text) return "canvas.createMenu.textDescription";
    if (type === CanvasNodeType.VoiceDesign) return "canvas.createMenu.audioGenerateDescription";
    return null;
}
