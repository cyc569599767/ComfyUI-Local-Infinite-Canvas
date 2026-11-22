// 候选帧抽取的真实 ffmpeg 验证（回归 ffmpeg 9 的 -vsync 报错）。
//
// 现场故障：源视频候选帧抽取失败，stderr 是
//   Unrecognized option 'vsync'. / Error splitting the argument list: Option not found
// 因为 ffmpeg 5.1 起用 -fps_mode 取代 -vsync，9.x 已彻底删除旧参数。
//
// 这里不 mock ffmpeg：本机没有 ffmpeg 时整组跳过，有则真跑一次抽帧。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { extractVideoFrame, extractVideoFrames } from "../src/viggle-long.js";

function ffmpegAvailable() {
    try {
        execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

const available = ffmpegAvailable();

/** 造一段 2 秒 24fps 的测试视频。 */
function makeSource() {
    const file = path.join(os.tmpdir(), `viggle-src-${process.pid}.mp4`);
    execFileSync("ffmpeg", ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", file], { stdio: "ignore", timeout: 60000 });
    return file;
}

test("ffmpeg 可用时能抽出多个候选帧（回归 -vsync 报错）", { skip: !available }, async () => {
    const source = makeSource();
    try {
        const file = { buffer: fs.readFileSync(source), originalname: "src.mp4", mimetype: "video/mp4" };
        const frames = await extractVideoFrames(file, { frames: [0, 8, 16, 24], config: {} });
        assert.equal(frames.length, 4);
        for (const frame of frames) {
            assert.ok(frame.buffer.length > 0, `帧 ${frame.frame} 为空`);
            assert.equal(frame.mimeType, "image/png");
            // 必须是真 PNG：前 8 字节是 PNG 魔数
            assert.equal(frame.buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        }
        // 帧号要对上请求的顺序
        assert.deepEqual(frames.map((frame) => frame.frame), [0, 8, 16, 24]);
    } finally {
        fs.rmSync(source, { force: true });
    }
});

test("ffmpeg 可用时能抽出单帧", { skip: !available }, async () => {
    const source = makeSource();
    try {
        const file = { buffer: fs.readFileSync(source), originalname: "src.mp4", mimetype: "video/mp4" };
        const one = await extractVideoFrame(file, { frame: 10, config: {} });
        assert.equal(one.frame, 10);
        assert.ok(one.buffer.length > 0);
        assert.equal(one.buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    } finally {
        fs.rmSync(source, { force: true });
    }
});

test("抽帧失败时给出可读原因，不吞异常", { skip: !available }, async () => {
    // 传一段不是视频的字节，ffmpeg 必然失败
    const file = { buffer: Buffer.from("not a video at all"), originalname: "bad.mp4", mimetype: "video/mp4" };
    await assert.rejects(
        () => extractVideoFrames(file, { frames: [0], config: {} }),
        (error) => {
            assert.match(String(error.message), /抽帧|候选帧/);
            // 不能把 ffmpeg 的完整 stderr 全塞进去（已截断到 300 字）
            assert.ok(String(error.message).length < 600, "错误信息过长会淹没界面");
            return true;
        },
    );
});
