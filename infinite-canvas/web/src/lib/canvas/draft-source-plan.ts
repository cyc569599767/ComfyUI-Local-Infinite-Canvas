import type { ReferenceImage } from "@/types/image";

export type DraftSourcePlan = {
    mode: "text" | "frames" | "reference";
    frameMode?: "first" | "last" | "both";
    // Images actually sent to the model (empty for text-to-video).
    images: ReferenceImage[];
    // Canvas references are distinct from model conditioning. Text mode keeps
    // existing source links, without uploading their images or changing mode.
    connectionImages: ReferenceImage[];
    requiredImageCount: number;
};

/** Mode comes from the original node's resolved configuration, not media count.
 * Missing inputs remain a validation error, never a silent switch to text mode.
 */
export function resolveDraftSourcePlan(
    parentMode: string,
    parentFrameMode: "first" | "last" | "both" | undefined,
    references: ReferenceImage[],
    maxReferences = 16,
): DraftSourcePlan {
    if (parentMode === "text") return { mode: "text", images: [], connectionImages: [...references], requiredImageCount: 0 };
    if (parentMode === "reference") {
        const images = references.slice(0, maxReferences);
        return { mode: "reference", images, connectionImages: images, requiredImageCount: 1 };
    }
    const frameMode = parentFrameMode || (references.length >= 2 ? "both" : "first");
    const requiredImageCount = frameMode === "both" ? 2 : 1;
    const images = references.slice(0, requiredImageCount);
    return { mode: "frames", frameMode, images, connectionImages: images, requiredImageCount };
}
