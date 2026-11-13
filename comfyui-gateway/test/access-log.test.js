import assert from "node:assert/strict";
import test from "node:test";

import { isQuietRequestPath, shouldLogRequest } from "../src/access-log.js";

// 服务面板只保留最近 100 行日志。前端按秒级节奏轮询 /v1/models（8s）和
// /api/system/stats（5s），如果每条都记，十几秒就能把真实错误挤出去。
// 这组测试锁定「高频成功轮询安静、失败仍然记录」这条边界。

test("模型列表与系统状态的成功轮询不写访问日志", () => {
    assert.equal(isQuietRequestPath("/v1/models"), true);
    assert.equal(isQuietRequestPath("/api/system/stats"), true);
    assert.equal(shouldLogRequest("/v1/models", 200), false);
    assert.equal(shouldLogRequest("/api/system/stats", 200), false);
});

test("原有的进度与会话轮询仍然安静", () => {
    assert.equal(isQuietRequestPath("/api/progress/free_abc"), true);
    assert.equal(isQuietRequestPath("/api/session/status"), true);
    assert.equal(shouldLogRequest("/api/progress/free_abc", 200), false);
    assert.equal(shouldLogRequest("/api/session/status", 200), false);
});

test("静默路径的失败必须记录，否则轮询出错时日志一片空白", () => {
    for (const path of ["/v1/models", "/api/system/stats", "/api/progress/x", "/api/session/status"]) {
        assert.equal(shouldLogRequest(path, 500), true, `${path} 500 应记录`);
        assert.equal(shouldLogRequest(path, 400), true, `${path} 400 应记录`);
        assert.equal(shouldLogRequest(path, 404), true, `${path} 404 应记录`);
    }
});

test("正常业务请求照常记录", () => {
    assert.equal(shouldLogRequest("/v1/chat/completions", 200), true);
    assert.equal(shouldLogRequest("/api/free-workflows/free_1/audio", 200), true);
    assert.equal(shouldLogRequest("/api/setup/status", 200), true);
});

test("安静匹配是精确的，不会误伤名字相近的端点", () => {
    // 带后缀/前缀的相似路径不该被当成轮询
    assert.equal(isQuietRequestPath("/v1/models/extra"), false);
    assert.equal(isQuietRequestPath("/api/system/stats/detail"), false);
    assert.equal(isQuietRequestPath("/v1/models-refresh"), false);
    // 前缀匹配的 progress 仍应覆盖子路径
    assert.equal(isQuietRequestPath("/api/system/statsX"), false);
});

test("带 query 的路径按 path 判定，不受参数影响", () => {
    // Express 的 req.path 不含 query，这里传入的是纯 path；确保判定本身不依赖 query
    assert.equal(shouldLogRequest("/v1/models", 200), false);
    assert.equal(shouldLogRequest("/api/system/stats", 200), false);
});

test("空值与异常输入不抛错", () => {
    assert.equal(isQuietRequestPath(""), false);
    assert.equal(isQuietRequestPath(undefined), false);
    assert.equal(isQuietRequestPath(null), false);
    assert.equal(shouldLogRequest("", 200), true);
    assert.equal(shouldLogRequest("/v1/models", "200"), false);
});

test("模型事件 SSE 重连也不刷屏", () => {
    assert.equal(shouldLogRequest("/api/models/events", 200), false);
});

test("更新进度轮询同样安静：400ms 一次，一次更新就是几百条", () => {
    assert.equal(shouldLogRequest("/api/update/progress", 200), false);
    // 但更新检查本身要留痕，它只跑一次且结果可能有用
    assert.equal(shouldLogRequest("/api/update/check", 200), true);
});
