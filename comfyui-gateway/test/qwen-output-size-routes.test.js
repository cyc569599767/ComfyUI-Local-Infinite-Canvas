import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { createGatewayApp, stopGateway } from "../src/server.js";
import { inferBindings } from "../src/registry.js";

// A real HTTP route and registry, but every Comfy method is an in-process fake.
// The network guard rejects even accidental access to a live Comfy instance.
test("generation HTTP route forwards sizes to an inferred Qwen canvas without touching stored graphs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qwen-size-routes-"));
  const originalFetch = globalThis.fetch;
  const originalBootstrap = process.env.DISABLE_NODE_BOOTSTRAP;
  process.env.DISABLE_NODE_BOOTSTRAP = "1";
  let gateway, server, origin;
  globalThis.fetch = (url, ...args) => {
    assert.ok(origin && new URL(String(url)).origin === origin, `Unexpected network request: ${url}`);
    return originalFetch(url, ...args);
  };
  try {
    const workflowDir = path.join(root, "workflows");
    await fs.mkdir(workflowDir);
    const graph = await fs.readFile(new URL("../workflows/_archive/image-qwen21-t2i.json", import.meta.url));
    const row = { id: "image-qwen21-t2i", name: "image-qwen21-t2i", type: "image", file: "legacy.json", bindings: inferBindings(JSON.parse(graph)) };
    const registry = JSON.stringify({ workflows: [row] });
    await fs.writeFile(path.join(workflowDir, "legacy.json"), graph);
    await fs.writeFile(path.join(workflowDir, "registry.json"), registry);
    gateway = await createGatewayApp({ desktopDistribution: true, kvmem: { enabled: false },
      comfyUrl: "http://127.0.0.1:1", comfyDir: "", comfyWorkflowsDir: "", comfyFrontendDir: "",
      launcherConfigPath: path.join(root, "launcher.json"), canvasDist: path.join(root, "dist"),
      dataDir: path.join(root, "data"), outputDir: path.join(root, "outputs"), workflowDir,
      scanOnStart: false, watchWorkflows: false, updateEnabled: false, resourcesIndexUrl: "", resourcesIndexUrlBackup: "" });
    gateway.setup.registrySnapshotCurrent = () => true;
    gateway.setup.workflowStatus = () => ({ available: true });
    gateway.setup.loaderOptions = () => ({});
    gateway.setup.loraNames = () => [];
    gateway.setup.modelAliasFor = () => "";
    const submissions = [];
    gateway.comfy.submit = async (graph) => { submissions.push(graph); return { promptId: "fake-qwen" }; };
    gateway.comfy.history = async () => ({ status: { completed: true }, outputs: { 12: { images: [{ filename: "fake.png", type: "output" }] } } });
    gateway.comfy.view = async () => ({ buffer: Buffer.from("offline"), contentType: "image/png" });
    server = http.createServer(gateway.app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    for (const size of ["2048x2048", "2048x1360", "864x1536", "1280x720"]) {
      const response = await fetch(`${origin}/v1/images/generations`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: row.id, prompt: "offline", size, n: 1, params: { resolution: 2048 } }) });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.equal(payload.data.length, 1);
      const bound = submissions.at(-1);
      assert.deepEqual([bound["13"].inputs.width, bound["13"].inputs.height], size.split("x").map(Number));
      assert.deepEqual(bound["10"].inputs.latent_image, ["14", 0]);
    }
    assert.equal(submissions.length, 4);
    assert.deepEqual(await fs.readFile(path.join(workflowDir, "legacy.json")), graph);
    assert.equal(await fs.readFile(path.join(workflowDir, "registry.json"), "utf8"), registry);
  } finally {
    if (gateway) await stopGateway({ ...gateway, server });
    server?.closeAllConnections();
    globalThis.fetch = originalFetch;
    if (originalBootstrap === undefined) delete process.env.DISABLE_NODE_BOOTSTRAP;
    else process.env.DISABLE_NODE_BOOTSTRAP = originalBootstrap;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
