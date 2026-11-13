import type { ReferenceAudio } from "@/types/media";

export type AudioCloneReferencePlan = {
    /** 实际发给网关的参考音频。 */
    reference?: ReferenceAudio;
    /**
     * true = 用节点自己的音频当参考音色。
     * 这时结果必须落到新节点上，否则会把参考音色本身覆盖掉。
     */
    usesSelfReference: boolean;
};

/**
 * 音色克隆的参考音色决策：连入的音频节点优先；没连就用本节点已有的音频；
 * 两者都没有时不发参考音频，由调用方决定是否拦截。
 */
export function planAudioCloneReference(mode: string, upstream: ReferenceAudio | undefined, self: ReferenceAudio | null | undefined): AudioCloneReferencePlan {
    if (mode !== "voice-clone") return { usesSelfReference: false };
    if (upstream) return { reference: upstream, usesSelfReference: false };
    if (self) return { reference: self, usesSelfReference: true };
    return { usesSelfReference: false };
}
