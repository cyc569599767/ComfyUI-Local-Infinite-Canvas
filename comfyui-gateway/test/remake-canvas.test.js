// 换人成片应尽量使用源视频原分辨率与比例。
//
// RemakeConditioning.short_edge 只允许 480–736（步进 32），超出就按 16:9 改画布
// 并 cover-crop。硬编码 480 会把 1080p 压到 854x480、竖屏裁掉更多。
import assert from "node:assert/strict";
import test from "node:test";

import { alignUp32, pickImageCanvas, pickRemakeShortEdge, remakeCanvas } from "../src/remake-canvas.js";

test("alignUp32 向上对齐到 32 的倍数", () => {
    assert.equal(alignUp32(480), 480);
    assert.equal(alignUp32(481), 512);
    assert.equal(alignUp32(736), 736);
    assert.equal(alignUp32(737), 768);
    assert.equal(alignUp32(0), 0);
});

test("按源视频短边挑 short_edge，夹在 480–736 且是 32 的倍数", () => {
    // 1080p 横屏：短边 1080 → 向下取 32 倍数 = 1056，再夹到上限 736
    assert.equal(pickRemakeShortEdge(1920, 1080), 736);
    // 720p：720 不是 32 倍数 → 向下取 704（不用 736，避免放大到比源片还高）
    assert.equal(pickRemakeShortEdge(1280, 720), 704);
    // 竖屏 1080x1920：短边仍是 1080 → 736
    assert.equal(pickRemakeShortEdge(1080, 1920), 736);
    // 低分辨率：短边 360 → 抬到下限 480
    assert.equal(pickRemakeShortEdge(640, 360), 480);
    // 短边 700 → 向下 672
    assert.equal(pickRemakeShortEdge(1200, 700), 672);
    // 短边正好是 32 倍数且在范围内：原样用
    assert.equal(pickRemakeShortEdge(1024, 576), 576);
    assert.equal(pickRemakeShortEdge(1280, 704), 704);
});

test("源尺寸未知时回落到 480（保守，等同旧行为）", () => {
    assert.equal(pickRemakeShortEdge(0, 0), 480);
    assert.equal(pickRemakeShortEdge(NaN, 720), 480);
    assert.equal(pickRemakeShortEdge(undefined, undefined), 480);
});

test("短边恰好等于 shortEdge 且两边是 32 倍数时，画布原样保留", () => {
    // 1280x704 配 shortEdge=704：真正保持原分辨率，不裁不缩
    assert.deepEqual(remakeCanvas(1280, 704, 704), { width: 1280, height: 704, kept: true });
    // 竖屏同样（短边用 704：720 不是 32 倍数，不在允许档位）
    assert.deepEqual(remakeCanvas(704, 1280, 704), { width: 704, height: 1280, kept: true });
    // 480p：832 是 32 倍数可原样；854（老 mp4 常见宽度）不是，会被改成 16:9 的 832
    assert.deepEqual(remakeCanvas(832, 480, 480), { width: 832, height: 480, kept: true });
    assert.deepEqual(remakeCanvas(854, 480, 480), { width: 832, height: 480, kept: false });
});

test("短边不等于 shortEdge 时按 16:9 改画布（与 nodes.py 一致）", () => {
    // shortEdge=736 → long = 736*16/9=1308.4 → 向下取 32 倍数 = 1280
    assert.deepEqual(remakeCanvas(1920, 1080, 736), { width: 1280, height: 736, kept: false });
    // shortEdge=480 → long = 853.3 → 832
    assert.deepEqual(remakeCanvas(1920, 1080, 480), { width: 832, height: 480, kept: false });
    // 竖屏：宽=shortEdge，高=long
    assert.deepEqual(remakeCanvas(1080, 1920, 736), { width: 736, height: 1280, kept: false });
});

test("32 倍数短边的源片能真正保住原分辨率（核心诉求）", () => {
    // 1280x704 这种 32 对齐的源片，选了 704 之后画布完全保留
    const se = pickRemakeShortEdge(1280, 704);
    const canvas = remakeCanvas(1280, 704, se);
    assert.equal(se, 704);
    assert.equal(canvas.kept, true);
    assert.deepEqual({ width: canvas.width, height: canvas.height }, { width: 1280, height: 704 });

    // 576（如 1024x576）同样原样保留
    const se2 = pickRemakeShortEdge(1024, 576);
    assert.equal(remakeCanvas(1024, 576, se2).kept, true);
});

test("1080p 源片不会被压到 480，而是保住 736 短边", () => {
    const se = pickRemakeShortEdge(1920, 1080);
    assert.equal(se, 736, "不能再用 480，否则细节损失过半");
    const canvas = remakeCanvas(1920, 1080, se);
    assert.equal(canvas.height, 736);
    assert.ok(canvas.width > 832, "宽度也应大于旧的 832");
});

// ── 图像画布必须跟随源片朝向 ──────────────────────────────────────────
//
// 现场缺陷：图像画布写死 832x480（横屏）。竖屏 1080x1878 的源片被
// force_original_aspect_ratio=increase + crop 裁成 832x480，只留下画面
// 中间约 27% 的高度 —— 正是胸口领带那一条，人脸完全没了。图像门在这种
// 「无脸图」上仍判通过（整幅框下没有框外像素可比），于是送进视频模型的
// 是一张领带特写，模型只好凭空编一个新场景（实测编出了钢铁侠）。

test("竖屏源片不能裁成横屏条带（人脸会丢）", () => {
  const canvas = pickImageCanvas(1080, 1878);
  assert.ok(canvas.height > canvas.width, `竖屏必须是竖向画布，实得 ${canvas.width}x${canvas.height}`);
  // 比例要贴近源片，偏差超过 5% 就会裁掉大片画面
  const srcAspect = 1080 / 1878;
  const canvasAspect = canvas.width / canvas.height;
  assert.ok(
    Math.abs(canvasAspect - srcAspect) / srcAspect < 0.05,
    `宽高比失真过大：源 ${srcAspect.toFixed(3)} vs 画布 ${canvasAspect.toFixed(3)}`,
  );
});

test("横屏源片仍出横屏画布", () => {
  const canvas = pickImageCanvas(1920, 1080);
  assert.ok(canvas.width > canvas.height);
  assert.ok(Math.abs(canvas.width / canvas.height - 1920 / 1080) / (1920 / 1080) < 0.05);
});

test("方形源片出方形画布", () => {
  const canvas = pickImageCanvas(1080, 1080);
  assert.equal(canvas.width, canvas.height);
});

test("图像画布两边都是 32 的倍数（模型对对齐敏感）", () => {
  for (const [w, h] of [[1080, 1878], [1920, 1080], [720, 1280], [1080, 1080], [640, 360]]) {
    const canvas = pickImageCanvas(w, h);
    assert.equal(canvas.width % 32, 0, `${w}x${h} 宽未对齐: ${canvas.width}`);
    assert.equal(canvas.height % 32, 0, `${w}x${h} 高未对齐: ${canvas.height}`);
  }
});

test("图像画布面积不超预算太多（显存可控）", () => {
  for (const [w, h] of [[1080, 1878], [1920, 1080], [720, 1280]]) {
    const canvas = pickImageCanvas(w, h);
    const mp = (canvas.width * canvas.height) / 1e6;
    assert.ok(mp <= 1.15, `${w}x${h} 超预算: ${mp.toFixed(2)}MP`);
    assert.ok(mp >= 0.9, `${w}x${h} 分辨率过低: ${mp.toFixed(2)}MP`);
  }
});

test("源尺寸未知时退回横屏兜底，不报错", () => {
  assert.deepEqual(pickImageCanvas(0, 0), { width: 832, height: 480 });
  assert.deepEqual(pickImageCanvas(null, undefined), { width: 832, height: 480 });
});
