/**
 * 哪些请求不该写访问日志。
 *
 * 这些端点是前端按秒级节奏轮询的（进度、会话状态、模型列表、系统状态），
 * 每一条都记下来的话，服务面板的 100 行缓冲会在十几秒内被刷满，
 * 真正有用的错误反而看不到。
 *
 * 但「安静」不等于「静默失败」：HTTP 4xx/5xx 仍然要记，否则轮询出错时日志里
 * 一片空白。304 是正常的条件轮询响应，同样应静默；任务失败另有独立警告。
 */
// 只匹配单个视频任务的状态接口，不包括创建、取消或内容下载。
const VIDEO_STATUS_PATH = /^\/v1\/videos\/[^/]+\/?$/;
const QUIET_PATTERNS = [
    VIDEO_STATUS_PATH,
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

/** 成功的高频轮询不记，失败一律记；省略 method 保持原有读取调用兼容。 */
export function shouldLogRequest(requestPath, statusCode, method = "GET") {
    const status = Number(statusCode);
    if (status >= 400) return true;
    if (VIDEO_STATUS_PATH.test(String(requestPath || ""))) {
        const read = method === "GET" || method === "HEAD";
        return !(read && ((status >= 200 && status < 300) || status === 304));
    }
    return !isQuietRequestPath(requestPath);
}
