/**
 * 哪些请求不该写访问日志。
 *
 * 这些端点是前端按秒级节奏轮询的（进度、会话状态、模型列表、系统状态），
 * 每一条都记下来的话，服务面板的 100 行缓冲会在十几秒内被刷满，
 * 真正有用的错误反而看不到。
 *
 * 但「安静」不等于「静默失败」：非 2xx 仍然要记，否则轮询出错时日志里
 * 一片空白，排查时反而更难。这个判定只负责「成功时是否安静」。
 */
const QUIET_PATTERNS = [
    /^\/api\/progress\//,
    /^\/api\/session\/status\b/,
    /^\/v1\/models$/,
    /^\/api\/system\/stats$/,
    /^\/api\/models\/events$/,
    // 应用更新时前端以 400ms 轮询进度，一次更新就是几百条。
    /^\/api\/update\/progress$/,
];

export function isQuietRequestPath(requestPath) {
    const value = String(requestPath || "");
    return QUIET_PATTERNS.some((pattern) => pattern.test(value));
}

/** 成功的高频轮询不记，失败一律记。 */
export function shouldLogRequest(requestPath, statusCode) {
    if (Number(statusCode) >= 400) return true;
    return !isQuietRequestPath(requestPath);
}
