// 角色替换 / 视频编辑这类「以当前视频为源」的工作流，源视频就是节点自身的内容。
//
// referenceVideos 只从上游连线收集（见 canvas-node-generation.ts 的
// buildNodeGenerationInputs），不包含节点自身。于是用户在视频节点上明明有视频，
// 后端仍然收到 0 个，报「ref_videos 需要至少 1 张视频」。
//
// 这里把节点自身的视频补进源视频列表。

export type SelfSourceVideoLike = { id?: string } & Record<string, unknown>;

/** 这些工作流以「当前节点的视频」作为源，需要自动补自身视频。 */
const SELF_SOURCE_WORKFLOWS = new Set(["video-h3-character-swap", "video-h3-viggle-swap"]);

export function needsSelfSourceVideo(workflowId: string, mode?: string): boolean {
  // Viggle 的编辑档同样以当前视频为源。
  if (/^(edit|edit-singularity)$/i.test(String(mode || ""))) return true;
  return SELF_SOURCE_WORKFLOWS.has(String(workflowId || ""));
}

/**
 * 把节点自身视频并入源视频列表。
 *
 * 源视频只能有一个（后端 ref_videos 的 max 是 1）：自身优先，
 * 避免自身与上游连线同时存在时后端静默择一、用户不知道用的是哪个。
 */
export function withSelfSourceVideo<T extends SelfSourceVideoLike>(
  videos: T[],
  workflowId: string,
  mode: string | undefined,
  selfVideo: T | null,
): T[] {
  if (videos.some((item) => item?.id && item.id === selfVideo?.id)) return videos;
  if (!needsSelfSourceVideo(workflowId, mode)) return videos;
  if (!selfVideo) return videos;
  return [selfVideo, ...videos].slice(0, 1);
}
