/**
 * 记住最后打开的画布，供下次启动时恢复。
 *
 * 为什么不塞进 canvas store：那个 store 用 localforage 持久化整个 projects 数组，
 * 把「上次打开的 id」混进去会让每次切换画布都触发整库重写。这里只需要一个短字符串，
 * 单独放 localStorage 更轻，也不会因为 store 结构演进被牵连。
 *
 * 恢复时机是首页挂载时：桌面端启动固定落在 /，如果这里能拿到一个仍然存在的画布，
 * 就直接进去；拿不到（首次使用、画布已被删除）就照常显示首页。
 */
export const LAST_CANVAS_KEY = "infinite-canvas:last_canvas_id";

function safeStorage(): Storage | null {
    try {
        return typeof window === "undefined" ? null : window.localStorage;
    } catch {
        // 隐私模式或存储被禁用时 localStorage 访问会抛错，不能让它影响画布打开。
        return null;
    }
}

export function rememberLastCanvas(projectId: string) {
    const id = String(projectId || "").trim();
    if (!id) return;
    try {
        safeStorage()?.setItem(LAST_CANVAS_KEY, id);
    } catch {
        // 配额满或被拒绝时静默失败：记不住只是少一个便利功能，不该打断使用。
    }
}

export function readLastCanvas(): string {
    try {
        return String(safeStorage()?.getItem(LAST_CANVAS_KEY) || "").trim();
    } catch {
        return "";
    }
}

export function forgetLastCanvas() {
    try {
        safeStorage()?.removeItem(LAST_CANVAS_KEY);
    } catch {
        // 同上，清不掉也无害。
    }
}

/**
 * 决定首页要不要跳转。
 *
 * 只有「记录存在且对应画布还在」才恢复。画布被删除后必须回落到首页，
 * 否则会跳到一个空路由再被重定向，闪一下反而更差。
 */
export function resolveResumeCanvasId(lastId: string, projectIds: string[]): string {
    const id = String(lastId || "").trim();
    if (!id) return "";
    return projectIds.includes(id) ? id : "";
}

/**
 * 自动恢复每个会话只做一次。
 *
 * 没有这个闸门的话，顶部 logo 和画布里的「主页」按钮都会被立刻弹回上次的画布，
 * 首页就再也进不去了。用 sessionStorage 而不是 localStorage：
 * 关掉软件重开（新会话）应该恢复，同一次使用里主动回首页则不该被弹走。
 */
const RESUMED_FLAG = "infinite-canvas:last_canvas_resumed";

export function hasResumedThisSession(): boolean {
    const storage = safeSessionStorage();
    // 拿不到 sessionStorage 就当作已恢复：宁可这次不自动跳转，
    // 也不要在每次进首页时都尝试跳走，把首页入口锁死。
    if (!storage) return true;
    try {
        return storage.getItem(RESUMED_FLAG) === "1";
    } catch {
        return true;
    }
}

export function markResumedThisSession() {
    try {
        safeSessionStorage()?.setItem(RESUMED_FLAG, "1");
    } catch {
        // 存不了就当作已恢复，宁可这次不自动跳转，也不要把首页锁死。
    }
}

function safeSessionStorage(): Storage | null {
    try {
        return typeof window === "undefined" ? null : window.sessionStorage;
    } catch {
        return null;
    }
}
