import type { PromptOptimizeMode } from "@/services/api/image";

/**
 * 推断提示词优化该用哪种任务类型。
 *
 * 优化端点（POST /v1/prompts/optimize）只认任务类型 + 提示词，与具体跑哪个视频
 * 工作流无关，所以这里的判断只依赖「这条提示词要生成什么样的视频」：
 * 有参考视频/音频、或声明全参考模式 → 全参考；否则按首/尾帧与参考图数量落到
 * 文生视频或对应的帧模式。
 *
 * 曾经这里只看 H3 的 workflowId 白名单，导致其它视频工作流的节点拿不到优化入口。
 */
export function resolvePromptOptimizeTaskType(input: {
    /** H3 的 ref2va / character-swap：恒为全参考，不看 videoMode。 */
    isH3Reference: boolean;
    /** 节点当前的视频模式（已过 resolveVideoWorkflowMode 归一化）。 */
    videoMode?: string;
    /** 是否是 H3 文生视频工作流；其它工作流按 videoMode 判断。 */
    isH3Text: boolean;
    /** 已选中的参考图数量。 */
    referenceImageCount: number;
    /** 首/尾帧选择。 */
    frameMode: "first" | "last" | "both";
    /** 是否连了参考视频。 */
    hasVideoReference: boolean;
    /** 是否连了参考音频。 */
    hasAudioReference: boolean;
}): { taskType: PromptOptimizeMode; isReferenceTask: boolean } {
    const isReferenceTask = input.isH3Reference || input.videoMode === "reference" || input.hasVideoReference || input.hasAudioReference;
    if (isReferenceTask) return { taskType: "全参考模式(Reference to Video)", isReferenceTask };

    if (input.isH3Text || input.videoMode === "text" || input.referenceImageCount === 0) {
        return { taskType: "文生视频(T2VA)", isReferenceTask };
    }
    if (input.frameMode === "last") return { taskType: "尾帧图生视频(L2VA)", isReferenceTask };
    if (input.frameMode === "both" && input.referenceImageCount >= 2) return { taskType: "首尾帧视频(FL2VA)", isReferenceTask };
    return { taskType: "首帧图生视频(I2VA)", isReferenceTask };
}
