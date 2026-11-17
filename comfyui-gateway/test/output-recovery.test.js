import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { collectOutputFiles } from "../src/runner.js";

// 「已经生成、但取回失败」的任务靠 promptId 找回产物。
// 恢复接口用的就是这条路径：history 里挑出 output 类型文件，再从本地目录读回来。
test("恢复用的输出收集只认 output 类型，不会把源视频当结果", () => {
  const history = {
    status: { status_str: "success", completed: true },
    outputs: {
      1: { images: [{ filename: "source.mp4", subfolder: "", type: "input" }] },
      9: { images: [{ filename: "relayvsr-upscale_00002_.mp4", subfolder: "video", type: "output" }] },
    },
  };
  const files = collectOutputFiles(history, {});
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, "relayvsr-upscale_00002_.mp4");
  assert.equal(files[0].type, "output");
  assert.equal(files[0].subfolder, "video");
});

test("收集输出时预览图默认不混进结果", () => {
  const history = {
    outputs: {
      5: { images: [{ filename: "preview.png", type: "temp" }] },
      9: { images: [{ filename: "final.mp4", type: "output", subfolder: "video" }] },
    },
  };
  const files = collectOutputFiles(history, {});
  assert.deepEqual(files.map((file) => file.filename), ["final.mp4"]);
});

test("空输出不会伪造文件，恢复接口据此报「找不到产物」", () => {
  assert.deepEqual(collectOutputFiles(null, {}), []);
  assert.deepEqual(collectOutputFiles({ outputs: {} }, {}), []);
});

test("真实目录结构下能按 subfolder 找回视频产物", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "comfy-recover-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, "output", "video"), { recursive: true });
  await fsp.writeFile(path.join(root, "output", "video", "clip.mp4"), Buffer.from("recovered"));

  const { createLocalOutputReader } = await import("../src/local-output.js");
  const readLocalOutput = createLocalOutputReader({ comfyDir: root });
  const files = collectOutputFiles({ outputs: { 9: { images: [{ filename: "clip.mp4", subfolder: "video", type: "output" }] } } }, {});
  const local = await readLocalOutput(files[0]);
  assert.equal(local?.buffer.toString(), "recovered");
});
