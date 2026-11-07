import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyBindings, buildContext } from "../src/bindings.js";
import { createRegistry, inferBindings } from "../src/registry.js";
import { inferQwenOutputSize } from "../src/qwen-output-size.js";
import { runWorkflow } from "../src/runner.js";

const root = path.resolve(import.meta.dirname, "..");
const legacy = JSON.parse(await fs.readFile(path.join(root, "workflows/_archive/image-qwen21-t2i.json"), "utf8"));
const expected = { node: "13", latentNode: "10", latentInput: "latent_image", latentSource: "14", fromSize: true, skipNativeSquare: true };
const legacyRow = { id: "image-qwen21-t2i", name: "image-qwen21-t2i", type: "image", file: "image-qwen21-t2i.json", bindings: inferBindings(legacy), defaults: {} };

async function fixture(t, rows = [legacyRow]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qwen-size-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await fs.writeFile(path.join(dir, legacyRow.file), JSON.stringify(legacy));
  await fs.writeFile(path.join(dir, "registry.json"), JSON.stringify({ version: 1, workflows: rows }));
  const registry = createRegistry({ dir });
  await registry.load();
  return { dir, registry };
}

test("legacy import/reload infers a runtime-only output canvas without rewriting user files", async (t) => {
  const { dir, registry } = await fixture(t);
  const before = await Promise.all(["registry.json", legacyRow.file].map((file) => fs.readFile(path.join(dir, file))));
  const entry = registry.resolve(legacyRow.id);
  assert.deepEqual(entry.outputSize, expected);
  assert.deepEqual(entry.workflow, legacy);
  assert.deepEqual(entry.bindings, legacyRow.bindings);
  const graphBefore = structuredClone(entry.workflow);
  for (const size of ["1024x1024", "2048x2048", "1536x864", "864x1536", "2048x1360", "1360x2048", "3840x2160", "1280x720"]) {
    const [width, height] = size.split("x").map(Number);
    const out = applyBindings(entry.workflow, entry, buildContext({ prompt: "size fixture", size, params: { resolution: 2048 } }));
    if (size === "1024x1024") {
      assert.deepEqual(out["10"].inputs.latent_image, ["5", 2]);
    } else {
      assert.equal(out["13"].inputs.width, width);
      assert.equal(out["13"].inputs.height, height);
      assert.deepEqual(out["10"].inputs.latent_image, ["14", 0]);
      assert.deepEqual(out["14"].inputs.pixels, ["13", 0]);
      assert.deepEqual(out["14"].inputs.vae, out["5"].inputs.vae);
    }
    assert.equal(out["5"].inputs.resolution, 1024, "unbound reference resolution cannot silently control output size");
    assert.equal(out["5"].inputs.prompt, "size fixture");
    assert.equal(out["12"].inputs.filename_prefix, "Qwen21T2I");
  }
  assert.deepEqual(entry.workflow, graphBefore);
  await registry.load();
  assert.deepEqual(registry.resolve(legacyRow.id).outputSize, expected);
  for (const [index, file] of ["registry.json", legacyRow.file].entries()) assert.deepEqual(await fs.readFile(path.join(dir, file)), before[index]);
});

test("newly imported graph gets the same size policy without persisting inferred metadata", async (t) => {
  const { dir, registry } = await fixture(t, []);
  const result = await registry.importWorkflow({ json: legacy, name: "image-my-qwen" });
  const entry = registry.resolve(result.workflow.id);
  assert.deepEqual(entry.outputSize, expected);
  const stored = JSON.parse(await fs.readFile(path.join(dir, "registry.json"), "utf8"));
  assert.equal(stored.workflows[0].outputSize, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, entry.file), "utf8")), legacy);
});

test("legacy T2I variant is inferred without changing reference edit mode", async (t) => {
  const edited = structuredClone(legacy);
  edited["5"].inputs["images.image_1"] = ["90", 0];
  edited["90"] = { class_type: "LoadImage", inputs: { image: "user.png" } };
  const row = { ...legacyRow, file: "edit.json", variants: { t2i: { file: legacyRow.file } } };
  const { dir, registry } = await fixture(t, []);
  await fs.writeFile(path.join(dir, "edit.json"), JSON.stringify(edited));
  await fs.writeFile(path.join(dir, "registry.json"), JSON.stringify({ workflows: [row] }));
  await registry.load();
  const base = registry.resolve(row.id);
  assert.equal(base.outputSize, undefined);
  assert.deepEqual(registry.resolveForMode(base, "t2i").outputSize, expected);
});

test("inference is structural, independent of node IDs and workflow names", () => {
  const remapped = Object.fromEntries(Object.entries(legacy).map(([id, node]) => [`n${id}`, { ...node, inputs: Object.fromEntries(Object.entries(node.inputs).map(([key, value]) => [key, Array.isArray(value) ? [`n${value[0]}`, value[1]] : value])) }]));
  assert.deepEqual(inferQwenOutputSize(remapped), { ...expected, node: "n13", latentNode: "n10", latentSource: "n14" });
});

test("custom size policies and ambiguous/shared/edit branches are never repaired speculatively", () => {
  for (const row of [{ outputSize: null }, { outputSize: {} }, { bindings: { width: { from: "size.width" } } }, { defaults: { "13.width": 768 } }, { bindings: { canvas: { node: "10", input: "latent_image", from: "params.custom" } } }, { bindings: { refs: { node: "5", input: "images", from: "image", array: true } } }]) {
    assert.equal(inferQwenOutputSize(legacy, row), undefined);
  }
  for (const change of [
    (g) => { g["5"].inputs["images.image_1"] = ["90", 0]; },
    (g) => { g["20"] = structuredClone(g["14"]); },
    (g) => { g["20"] = { class_type: "PreviewImage", inputs: { images: ["13", 0] } }; },
    (g) => { g["10"].inputs.latent_image = ["14", 0]; },
    (g) => { g["14"].inputs.vae = ["other-vae", 0]; },
    (g) => { g["6"].inputs.positive = ["other-encoder", 0]; },
    (g) => { delete g["14"]; },
  ]) {
    const graph = structuredClone(legacy);
    change(graph);
    assert.equal(inferQwenOutputSize(graph), undefined);
  }
});

test("auto/absent size preserves the native latent; native-square skip follows the bound encoder", () => {
  const entry = { ...legacyRow, outputSize: expected };
  for (const size of [undefined, "auto"]) {
    const out = applyBindings(legacy, entry, buildContext({ size }));
    assert.deepEqual(out["10"].inputs.latent_image, ["5", 2]);
    assert.equal(out["13"].inputs.width, 1024);
  }
  const custom = structuredClone(legacy);
  custom["5"].inputs.resolution = 1536;
  const out = applyBindings(custom, entry, buildContext({ size: "1024x1024" }));
  assert.deepEqual(out["10"].inputs.latent_image, ["14", 0], "default params must not skip a custom 1536 native latent");
  const explicit = { ...entry, bindings: { ...entry.bindings, resolution: { node: "5", input: "resolution", from: "params.resolution" } } };
  const native = applyBindings(legacy, explicit, buildContext({ size: "2048x2048", params: { resolution: 2048 } }));
  assert.deepEqual(native["10"].inputs.latent_image, ["5", 2]);
  assert.equal(native["5"].inputs.resolution, 2048);
});

test("bundled v2 T2I preserves explicit 16px sizes, edit canvas retains its 32px policy", async () => {
  const registry = createRegistry({ dir: path.join(root, "workflows") });
  await registry.load();
  const base = registry.resolve("image-qwen21");
  const t2i = registry.resolveForMode(base, "t2i");
  const out = applyBindings(t2i.workflow, t2i, buildContext({ size: "2048x1360", mode: "t2i" }));
  assert.equal(out["502"].inputs.width, 2048);
  assert.equal(out["502"].inputs.height, 1360);
  assert.deepEqual(out["482"].inputs.latent_image, ["502", 0]);
  const edit = registry.resolveForMode(base, "edit");
  const editOut = applyBindings(edit.workflow, edit, buildContext({ size: "2048x1360", uploadedImages: [{ name: "input.png" }], mode: "edit", params: { editCanvasSize: "1360x1008" } }));
  assert.equal(editOut["445"].inputs.width, 1376);
  assert.equal(editOut["445"].inputs.height, 1024);
});

test("runner hands the requested canvas and latent link to a fake Comfy client only", async (t) => {
  const { registry } = await fixture(t);
  let submitted;
  await runWorkflow({
    entry: registry.resolve(legacyRow.id),
    context: buildContext({ prompt: "offline fixture", size: "2048x1360" }),
    comfy: {
      submit: async (graph) => { submitted = graph; return { promptId: "offline-fixture" }; },
      history: async () => ({ status: { completed: true }, outputs: { 12: { images: [{ filename: "fixture.png", type: "output" }] } } }),
      view: async () => ({ buffer: Buffer.from("fixture"), contentType: "image/png" }),
    },
  });
  assert.deepEqual(submitted["10"].inputs.latent_image, ["14", 0]);
  assert.deepEqual([submitted["13"].inputs.width, submitted["13"].inputs.height], [2048, 1360]);
});
