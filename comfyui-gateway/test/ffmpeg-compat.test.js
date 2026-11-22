// ffmpeg 参数兼容：-vsync 在 ffmpeg 9 已删除，必须按版本选参数。
//
// 现场报错：
//   $ ffmpeg -y -i in.mp4 -vf "select=..." -vsync 0 out-%03d.png
//   Unrecognized option 'vsync'.
import assert from "node:assert/strict";
import test from "node:test";

import { frameExtractArgs, isUnrecognizedOptionError, parseFfmpegVersion, passthroughFrameArgs } from "../src/ffmpeg-compat.js";

test("解析真实 ffmpeg -version 首行", () => {
    // 本机 ffmpeg 9.0.2 的实际输出
    assert.deepEqual(parseFfmpegVersion("ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers"), { major: 9, minor: 0 });
    assert.deepEqual(parseFfmpegVersion("ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright"), { major: 4, minor: 4 });
    // n 前缀的 nightly 写法
    assert.deepEqual(parseFfmpegVersion("ffmpeg version n6.1.1 Copyright"), { major: 6, minor: 1 });
    // 兼容 "N-xxxxx-git" 这种无版本号
    assert.equal(parseFfmpegVersion("ffmpeg version N-112233-gabcdef Copyright"), null);
    assert.equal(parseFfmpegVersion(""), null);
    assert.equal(parseFfmpegVersion(undefined), null);
});

test("ffmpeg 5.1 及以上用 -fps_mode passthrough", () => {
    assert.deepEqual(passthroughFrameArgs({ major: 9, minor: 0 }), ["-fps_mode", "passthrough"]);
    assert.deepEqual(passthroughFrameArgs({ major: 7, minor: 1 }), ["-fps_mode", "passthrough"]);
    // 5.1 是分界点：5.1 起支持 -fps_mode
    assert.deepEqual(passthroughFrameArgs({ major: 5, minor: 1 }), ["-fps_mode", "passthrough"]);
    assert.deepEqual(passthroughFrameArgs({ major: 6, minor: 0 }), ["-fps_mode", "passthrough"]);
});

test("ffmpeg 5.0 及以下仍用 -vsync 0", () => {
    assert.deepEqual(passthroughFrameArgs({ major: 5, minor: 0 }), ["-vsync", "0"]);
    assert.deepEqual(passthroughFrameArgs({ major: 4, minor: 4 }), ["-vsync", "0"]);
    assert.deepEqual(passthroughFrameArgs({ major: 3, minor: 4 }), ["-vsync", "0"]);
});

test("版本未知时优先新参数（现代发行版占多数）", () => {
    assert.deepEqual(passthroughFrameArgs(null), ["-fps_mode", "passthrough"]);
    assert.deepEqual(passthroughFrameArgs(undefined), ["-fps_mode", "passthrough"]);
});

test("识别「参数不被支持」的报错，用于自动换另一套参数重试", () => {
    // ffmpeg 9 遇到 -vsync 的原话
    assert.equal(isUnrecognizedOptionError("Unrecognized option 'vsync'.\nError splitting the argument list: Option not found", "vsync"), true);
    // 旧版 ffmpeg 遇到 -fps_mode 的报错
    assert.equal(isUnrecognizedOptionError("Unrecognized option 'fps_mode'.", "fps_mode"), true);
    // 别的错误不能误判成参数问题
    assert.equal(isUnrecognizedOptionError("Invalid data found when processing input", "vsync"), false);
    assert.equal(isUnrecognizedOptionError("", "vsync"), false);
    // 提到了 vsync 但不是参数错误（例如编码日志里出现字样）也不应误判
    assert.equal(isUnrecognizedOptionError("Stream #0:0 vsync enabled normally", "vsync"), false);
});

test("frameExtractArgs 按版本拼完整抽帧参数", () => {
    const modern = frameExtractArgs("in.mp4", "select=eq(n\\,5)", "out-%03d.png", { major: 9, minor: 0 });
    assert.deepEqual(modern, ["-y", "-i", "in.mp4", "-vf", "select=eq(n\\,5)", "-fps_mode", "passthrough", "out-%03d.png"]);
    // 绝不能出现 -vsync（ffmpeg 9 会直接报 Unrecognized option）
    assert.ok(!modern.includes("-vsync"));

    const legacy = frameExtractArgs("in.mp4", "select=eq(n\\,5)", "out-%03d.png", { major: 4, minor: 4 });
    assert.deepEqual(legacy, ["-y", "-i", "in.mp4", "-vf", "select=eq(n\\,5)", "-vsync", "0", "out-%03d.png"]);
    assert.ok(!legacy.includes("-fps_mode"));
});

test("真实 ffmpeg 9 报错样本能被识别（回归现场故障）", () => {
    const realStderr = `Unrecognized option 'vsync'.
Error splitting the argument list: Option not found`;
    assert.equal(isUnrecognizedOptionError(realStderr, "vsync"), true);
    // 换成 -fps_mode 后不应该再被判定为参数错误
    assert.equal(isUnrecognizedOptionError(realStderr, "fps_mode"), false);
});
