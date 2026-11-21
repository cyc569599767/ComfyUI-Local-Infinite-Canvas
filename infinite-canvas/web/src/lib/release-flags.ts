// 发布树默认隐藏 dev 新增未发布功能的入口；dev 树保持可见。
export const HIDE_UNRELEASED_FEATURES = import.meta.env.VITE_HIDE_EXPERIMENTAL === "1";

// 发布树隐藏入口的 dev 新增节点类型（代码与已存节点仍保留）。
// 说明：本 fork 已接入「短剧」（short-drama），因此不在此列，保持入口可用；
// automation / model3d / stage3d 尚未接入，若将来接入再移出此集合。
export const HIDDEN_NODE_TYPES = new Set(["automation", "model3d", "stage3d"]);

// 角色替换入口：发布树隐藏，dev 保持可见。
export const HIDE_CHARACTER_SWAP = true;

// Viggle Remake 角色替换：本 fork 已完整接入（swap/edit/edit-singularity），保持可见。
export const HIDE_VIGGLE_SWAP = false;
