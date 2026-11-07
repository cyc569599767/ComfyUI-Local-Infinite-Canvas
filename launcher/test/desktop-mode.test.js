import assert from "node:assert/strict";
import { fork, spawn, execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DESKTOP_COMFY_BOOTSTRAP, comfyPythonArguments, comfySpawnEnvironment, desktopLocalUrl, isDesktopGatewayHealth, isDesktopCanvasConfig, isDesktopCanvasIndex, resolveDesktopComfyPlan } from "../desktop-protocol.mjs";

const launcherDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = '<!doctype html><title>无界工作台</title><div id="root"></div><script type="module" src="/assets/index.js"></script><script src="/config.js"></script>';
const stats = { system: { ram_total: 2048, ram_free: 1024 }, devices: [{ name: "Fixture", type: "cpu", vram_total: 0, vram_free: 0 }] };
const health = (comfyUrl) => ({ status: "ok", comfy: { url: comfyUrl, reachable: true }, tasks: { count: 0 }, workflows: { count: 0 } });
const configJs = (gatewayUrl) => `window.__RUNTIME_CONFIG__ = ${JSON.stringify({ LOCAL_GATEWAY_URL: `${gatewayUrl}/v1` })};\n`;
const timeout = (ms) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  timer.unref();
});
const bounded = (promise, ms = 12000) => Promise.race([promise, timeout(ms)]);

async function serverFixture(t, handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  });
  return { server, calls, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

async function freePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function comfyFixture(t) {
  return serverFixture(t, (req, res) => {
    res.writeHead(req.url === "/system_stats" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/system_stats" ? stats : {}));
  });
}

async function gatewayFixture(t, comfyUrl, override) {
  return serverFixture(t, override || ((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/health" ? health(comfyUrl) : {}));
  }));
}

async function canvasFixture(t, gatewayUrl, override) {
  return serverFixture(t, override || ((req, res) => {
    res.setHeader("content-type", req.url === "/config.js" ? "text/javascript" : "text/html");
    res.end(req.url === "/config.js" ? configJs(gatewayUrl) : indexHtml);
  }));
}

const gatewayScript = `
import http from 'node:http';
import fs from 'node:fs';
const snapshot = { EXEC_PATH: process.execPath, ...Object.fromEntries(['PORT','HOST','ALLOW_REMOTE','DISABLE_NODE_BOOTSTRAP','LAUNCHER_CONTROL_URL','CORS_ORIGINS','ELECTRON_RUN_AS_NODE','COMFY_URL'].map(k => [k, process.env[k]])) };
fs.writeFileSync('spawn-env.json', JSON.stringify(snapshot));
let ready = process.env.FIXTURE_GATEWAY_DELAY !== '1';
const server = http.createServer((req,res) => {
  if (req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(ready ? {status:'ok',comfy:{url:process.env.COMFY_URL,reachable:true},tasks:{count:0},workflows:{count:0}} : {status:'starting'}));
  } else {
    fs.appendFileSync('unexpected-requests.txt', req.method + ' ' + req.url + '\\n');
    res.writeHead(404); res.end();
  }
});
server.listen(Number(process.env.PORT), process.env.HOST, () => console.log('fixture-gateway-listening'));
`;

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-launcher-"));
  // Never execute the workspace launcher: even failure paths use this private copy.
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "launcher"), { recursive: true });
  for (const name of ["start.mjs", "desktop-protocol.mjs", "bootstrap-nodes.mjs", "desktop-comfy-bootstrap.py"]) {
    await fs.copyFile(path.join(launcherDir, name), path.join(root, "launcher", name));
  }
  await fs.mkdir(path.join(root, "gateway", "src"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(root, "gateway", "src", "server.js"), gatewayScript);
  await fs.mkdir(path.join(root, "canvas"), { recursive: true });
  await fs.writeFile(path.join(root, "canvas", "index.html"), indexHtml);
  await fs.writeFile(path.join(root, "canvas", "config.js"), "// MUST NOT BE MODIFIED\n");
  // Tripwires: desktop may not bootstrap/extract these even in managed mode.
  await fs.mkdir(path.join(root, "assistant"), { recursive: true });
  await fs.writeFile(path.join(root, "assistant", "runtime.zip"), "not a zip");
  const config = {
    comfyUrl: `http://127.0.0.1:${await freePort()}`,
    comfyDir: path.join(root, "no-comfy-install"), gatewayDir: "gateway", canvasDist: "canvas",
    gatewayPort: await freePort(), canvasPort: await freePort(), controlPort: await freePort(),
    gatewayStartTimeoutSec: 3, comfyStartTimeoutSec: 1,
    allowLan: true, gatewayHost: "0.0.0.0", canvasHost: "0.0.0.0", gatewayPublicHost: "other.example",
    closeCanvasStopsBackend: true, stopAdoptedComfyOnCanvasClose: true, openBrowser: true,
    ...overrides,
  };
  const configPath = path.join(root, "launcher", "config.json");
  const originalConfig = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(configPath, originalConfig);
  return {
    root, config, entry: path.join(root, "launcher", "start.mjs"),
    async unchanged() {
      assert.equal(await fs.readFile(configPath, "utf8"), originalConfig);
      assert.equal(await fs.readFile(path.join(root, "canvas", "config.js"), "utf8"), "// MUST NOT BE MODIFIED\n");
      for (const file of ["launcher/launcher.log", "assistant/runtime.json", "gateway/unexpected-requests.txt"]) {
        await assert.rejects(fs.access(path.join(root, file)), { code: "ENOENT" });
      }
    },
  };
}

function startLauncher(t, fx, args = ["--desktop", "--connect-only"], extraEnv = {}, execPath = process.execPath) {
  const env = { ...process.env };
  for (const key of ["COMFY_URL", "COMFYUI_DIR", "CANVAS_PORT", "GATEWAY_PORT", "LAUNCHER_CONTROL_PORT", "COMFY_PORT_SCAN", "COMFY_WORKFLOWS_DIR"]) delete env[key];
  Object.assign(env, { ELECTRON_RUN_AS_NODE: "1", ...extraEnv });
  const child = fork(fx.entry, args, { cwd: fx.root, env, stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [], execPath });
  const messages = [];
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const exited = once(child, "exit");
  child.on("message", (message) => messages.push(message));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ type: "desktop:shutdown" });
    try { await bounded(exited, 5000); } catch {
      if (process.platform === "win32") await new Promise((resolve) => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], resolve));
      else child.kill("SIGKILL");
      await bounded(exited, 5000);
    }
  });
  return {
    child, messages, exited,
    async message(type, predicate = () => true) {
      const found = messages.find((m) => m.type === type && predicate(m));
      if (found) return found;
      return bounded(new Promise((resolve, reject) => {
        const onMessage = (m) => {
          if (m.type === type && predicate(m)) { cleanup(); resolve(m); }
        };
        const onExit = () => { cleanup(); reject(new Error(`Exited before ${type}: ${output}`)); };
        const cleanup = () => { child.off("message", onMessage); child.off("exit", onExit); };
        child.on("message", onMessage); child.once("exit", onExit);
      }));
    },
    async stop(disconnect = false) {
      if (disconnect) child.disconnect();
      else child.send({ type: "desktop:shutdown" });
      const [code] = await bounded(exited);
      assert.equal(code, 0, output);
    },
  };
}

async function closed(url) {
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
}

function assertReadOnlyCalls(...fixtures) {
  for (const fx of fixtures) assert.ok(fx.calls.every((call) => call.method === "GET"), JSON.stringify(fx.calls));
}

test("adopted gateway binding overrides configured Comfy URL without probing a different installation", async (t) => {
  const actual = await comfyFixture(t);
  const unrelated = await comfyFixture(t);
  const gateway = await gatewayFixture(t, actual.url);
  const fx = await fixture(t, { comfyUrl: unrelated.url, gatewayPort: gateway.port });
  const run = startLauncher(t, fx, ["--desktop"]);
  const { services } = await run.message("desktop:ready");
  assert.deepEqual(services.comfy, { url: actual.url, mode: "adopt" });
  assert.equal(unrelated.calls.length, 0);
  await run.stop();
  assert.equal((await fetch(`${actual.url}/system_stats`)).ok, true);
  assertReadOnlyCalls(actual, unrelated, gateway); await fx.unchanged();
});

test("adopted gateway with missing Comfy remains missing even if another configured instance is available", async (t) => {
  const unrelated = await comfyFixture(t);
  const missing = `http://127.0.0.1:${await freePort()}`;
  const gateway = await gatewayFixture(t, missing);
  const fx = await fixture(t, { comfyUrl: unrelated.url, gatewayPort: gateway.port });
  const run = startLauncher(t, fx, ["--desktop"]);
  const { services } = await run.message("desktop:ready");
  assert.deepEqual(services.comfy, { url: missing, mode: "missing" });
  assert.equal(unrelated.calls.length, 0);
  await run.stop();
  assertReadOnlyCalls(unrelated, gateway); await fx.unchanged();
});

test("Electron executable runs copied launcher and mock gateway as Node with IPC", async (t) => {
  const executable = process.env.DESKTOP_TEST_ELECTRON;
  if (!executable) return t.skip("Set DESKTOP_TEST_ELECTRON to opt into the installed Electron executable");
  const comfy = await comfyFixture(t);
  const fx = await fixture(t, { comfyUrl: comfy.url });
  const run = startLauncher(t, fx, ["--desktop"], {}, executable);
  const { services } = await run.message("desktop:ready");
  assert.equal(services.gateway.mode, "started");
  const env = JSON.parse(await fs.readFile(path.join(fx.root, "gateway", "spawn-env.json"), "utf8"));
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(path.resolve(env.EXEC_PATH).toLowerCase(), path.resolve(executable).toLowerCase());
  await run.stop();
  await closed(services.gateway.url); await closed(services.canvas.url);
  assert.equal((await fetch(`${comfy.url}/system_stats`)).ok, true);
  assertReadOnlyCalls(comfy); await fx.unchanged();
});

test("nonlocal configured or adopted Comfy bindings fail before probe or spawn", async (t) => {
  const gateway = await gatewayFixture(t, "http://remote.example");
  const fx = await fixture(t, { gatewayPort: gateway.port });
  const run = startLauncher(t, fx, ["--desktop"]);
  assert.match((await run.message("desktop:error")).message, /本机 HTTP 根 URL/);
  assert.equal((await bounded(run.exited))[0], 1);
  await assert.rejects(fs.access(path.join(fx.root, "gateway", "spawn-env.json")), { code: "ENOENT" });
  assertReadOnlyCalls(gateway); await fx.unchanged();
  const configured = await fixture(t, { comfyUrl: "http://remote.example", gatewayPort: gateway.port });
  const before = gateway.calls.length;
  const invalid = startLauncher(t, configured, ["--desktop"]);
  assert.match((await invalid.message("desktop:error")).message, /本机 HTTP 根 URL/);
  assert.equal((await bounded(invalid.exited))[0], 1);
  assert.equal(gateway.calls.length, before);
  await configured.unchanged();
});

test("strict identity rejects generic, malformed and mismatched service responses", () => {
  for (const value of ["http://127.0.0.1:12345", "http://localhost:12345/", "http://[::1]:12345"]) assert.ok(desktopLocalUrl(value));
  for (const value of ["http://remote.example", "https://127.0.0.1", "http://user:pass@127.0.0.1", "http://127.0.0.1/path", "http://127.0.0.1/?x=1", "http://127.0.0.1/#hash"]) assert.throws(() => desktopLocalUrl(value));
  assert.equal(isDesktopGatewayHealth(health("http://127.0.0.1:12345")), true);
  for (const value of [{ status: "ok" }, { ...health("http://x"), tasks: [] }, { ...health("http://x"), comfy: { url: "no", reachable: true } }]) {
    assert.equal(isDesktopGatewayHealth(value), false);
  }
  assert.equal(isDesktopCanvasIndex(indexHtml), true);
  assert.equal(isDesktopCanvasIndex('<div id="root"></div>'), false);
  assert.equal(isDesktopCanvasConfig(configJs("http://127.0.0.1:12345"), "http://127.0.0.1:12345"), true);
  assert.equal(isDesktopCanvasConfig(configJs("http://unrelated.test"), "http://127.0.0.1:12345"), false);
  const input = { ELECTRON_RUN_AS_NODE: "1", electron_run_as_node: "1", KEEP: "yes" };
  assert.deepEqual(comfySpawnEnvironment(input), { KEEP: "yes", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" });
  assert.equal(input.ELECTRON_RUN_AS_NODE, "1");
});

test("--desktop refuses non-IPC execution before reading/writing config", async (t) => {
  const fx = await fixture(t);
  const child = spawn(process.execPath, [fx.entry, "--desktop"], { cwd: fx.root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stderr.on("data", (d) => { output += d; }); child.stdout.resume();
  const [code] = await bounded(once(child, "exit"));
  assert.equal(code, 1); assert.match(output, /process.send IPC/);
  await fx.unchanged();
});

test("connect-only ready adopts verified fixtures; shutdown never stops external services", async (t) => {
  const comfy = await comfyFixture(t);
  const gateway = await gatewayFixture(t, comfy.url);
  const canvas = await canvasFixture(t, gateway.url);
  const fx = await fixture(t, { comfyUrl: comfy.url, gatewayPort: gateway.port, canvasPort: canvas.port });
  const run = startLauncher(t, fx);
  const ready = await run.message("desktop:ready");
  assert.deepEqual(ready.services, { canvas: { url: canvas.url, mode: "adopt" }, gateway: { url: gateway.url, mode: "adopt" }, comfy: { url: comfy.url, mode: "adopt" } });
  assert.ok(run.messages.some((m) => m.type === "desktop:log" && m.level === "INFO"));
  await run.stop();
  for (const [url, route] of [[comfy.url, "/system_stats"], [gateway.url, "/health"], [canvas.url, "/"]]) assert.equal((await fetch(url + route)).ok, true);
  assertReadOnlyCalls(comfy, gateway, canvas);
  assert.equal(gateway.calls.some((call) => call.url.startsWith("/api/session/")), false);
  await fx.unchanged();
});

test("connect-only missing Comfy degrades and hosts canvas; disconnect cleans only owned servers", async (t) => {
  const missing = `http://127.0.0.1:${await freePort()}`;
  const gateway = await gatewayFixture(t, missing);
  const occupied = await serverFixture(t, (_req, res) => res.end("not our canvas"));
  const controlOccupied = await serverFixture(t, (_req, res) => res.end("not our control"));
  const fx = await fixture(t, { comfyUrl: missing, gatewayPort: gateway.port, canvasPort: occupied.port, controlPort: controlOccupied.port });
  const run = startLauncher(t, fx);
  const { services } = await run.message("desktop:ready");
  assert.equal(services.comfy.mode, "missing");
  assert.equal(services.gateway.mode, "adopt");
  assert.equal(services.canvas.mode, "started");
  assert.notEqual(services.canvas.url, occupied.url);
  assert.equal(new URL(services.canvas.url).hostname, "127.0.0.1");
  const config = await (await fetch(`${services.canvas.url}/config.js`)).text();
  assert.equal(isDesktopCanvasConfig(config, gateway.url), true);
  const controlMessage = run.messages.find((m) => m.message?.includes("Desktop 私有控制接口"));
  const controlUrl = controlMessage.message.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  assert.notEqual(controlUrl, controlOccupied.url);
  assert.equal((await fetch(`${controlUrl}/restart-comfy`, { method: "POST" })).status, 403);
  await run.stop(true);
  await closed(services.canvas.url); await closed(controlUrl);
  assert.equal((await fetch(`${gateway.url}/health`)).ok, true);
  assert.equal(await (await fetch(occupied.url)).text(), "not our canvas");
  assert.equal(await (await fetch(controlOccupied.url)).text(), "not our control");
  assertReadOnlyCalls(gateway, occupied, controlOccupied);
  await fx.unchanged();
});

test("desktop portable BAT preserves original Python/Comfy options and suppresses automatic browser launch", async (t) => {
  const fx = await fixture(t);
  const cwd = path.join(fx.root, "portable with spaces");
  await fs.mkdir(cwd, { recursive: true });
  const bat = path.join(cwd, "run_nvidia_gpu.bat");
  const original = '@echo off\r\nrem Standard portable ComfyUI\r\n".\\python_embeded\\python.exe" -s "ComfyUI\\main.py" --windows-standalone-build --auto-launch --reserve-vram 2\r\necho If ComfyUI did not start, check the GPU driver.\r\npause\r\n';
  await fs.writeFile(bat, original);
  const install = { dir: path.join(cwd, "ComfyUI"), pythonExe: path.join(cwd, "python_embeded", "python.exe"),
    mainPy: path.join(cwd, "ComfyUI", "main.py"), scripts: [bat] };
  const plan = resolveDesktopComfyPlan(install, { kind: "script", file: bat, cwd });
  assert.equal(plan.kind, "python"); assert.equal(plan.cwd, cwd);
  const argv = comfyPythonArguments(plan, 18188, true);
  assert.deepEqual(argv, ["-s", DESKTOP_COMFY_BOOTSTRAP, install.mainPy, "--windows-standalone-build", "--auto-launch", "--reserve-vram", "2",
    "--port", "18188", "--listen", "127.0.0.1", "--disable-auto-launch"]);
  assert.equal(await fs.readFile(bat, "utf8"), original, "installed BAT must stay unchanged");
  assert.equal(comfyPythonArguments({ mainPy: install.mainPy }, 8188).includes("--disable-auto-launch"), false, "legacy CLI behavior stays unchanged");
  assert.equal(comfyPythonArguments({ mainPy: install.mainPy }, 8188, true).at(-1), "--disable-auto-launch");
});

test("desktop launch refuses unknown BAT environment/browser side effects instead of bypassing setup", async (t) => {
  const fx = await fixture(t);
  const bat = path.join(fx.root, "vendor.bat");
  const install = { dir: fx.root, pythonExe: path.join(fx.root, "python.exe"), mainPy: path.join(fx.root, "main.py"), scripts: [bat] };
  for (const content of [
    'set CUDA_VISIBLE_DEVICES=0\r\npython.exe main.py\r\n',
    'python.exe main.py\r\nstart http://127.0.0.1:8188\r\n',
    'rem %*\r\necho %*\r\nnode mock.mjs\r\n',
    'python.exe -c "print(1)" main.py\r\n',
    'python.exe main.py & start http://127.0.0.1:8188\r\n',
    'python.exe main.py -- --auto-launch\r\n',
  ]) {
    await fs.writeFile(bat, content);
    assert.throws(() => resolveDesktopComfyPlan(install, {kind:"script", file:bat, cwd:fx.root}), /启动脚本/);
  }
  assert.throws(() => resolveDesktopComfyPlan({}, {kind:"desktop", file:"ComfyUI.exe"}), /无浏览器/);
});

test("desktop portable BAT handles controlled dp0 paths and forwarded args without executing BAT", async (t) => {
  const fx = await fixture(t); const bat = path.join(fx.root, "standard.bat");
  await fs.writeFile(bat, '@echo off\r\n"%~dp0python.exe" -u "%~dp0main.py" --windows-standalone-build %*\r\n');
  const install = {pythonExe:path.join(fx.root,"python.exe"),mainPy:path.join(fx.root,"main.py"),dir:fx.root};
  const plan = resolveDesktopComfyPlan(install, {kind:"script",file:bat,cwd:fx.root});
  assert.deepEqual(plan.pythonArgs, ["-u"]);
  assert.deepEqual(plan.args, ["--windows-standalone-build"]);
  assert.equal(comfyPythonArguments(plan, 8188, true).at(-1), "--disable-auto-launch");
});

test("managed mode leaves unsupported browser-opening vendor scripts untouched and does not run them", async (t) => {
  const fx = await fixture(t);
  const comfyDir = fx.config.comfyDir;
  await fs.mkdir(comfyDir, { recursive: true });
  const marker = path.join(comfyDir, "must-not-run.txt");
  const original = `@echo off\r\nrem main.py -- fixture marker only\r\necho browser-side-effect > "${marker}"\r\n`;
  await fs.writeFile(path.join(comfyDir, "run_fixture.bat"), original);
  const run = startLauncher(t, fx, ["--desktop"]);
  const {services} = await run.message("desktop:ready");
  assert.deepEqual(services.comfy, {url:fx.config.comfyUrl, mode:"missing"});
  assert.ok(run.messages.some(message => /未自动启动 ComfyUI/.test(message.message || "")));
  await assert.rejects(fs.access(marker), {code:"ENOENT"});
  assert.equal(await fs.readFile(path.join(comfyDir,"run_fixture.bat"),"utf8"), original);
  await run.stop();
  await closed(services.gateway.url); await closed(services.canvas.url);
  await fx.unchanged();
});

test("desktop Python output is UTF-8 and a crashing Comfy process does not take canvas/gateway down", async (t) => {
  const python = process.env.DESKTOP_TEST_PYTHON;
  if (!python) return t.skip("Set DESKTOP_TEST_PYTHON to exercise real Python process startup");
  const fx = await fixture(t, { comfyStartTimeoutSec: 3 });
  const comfyDir = fx.config.comfyDir;
  await fs.mkdir(comfyDir, { recursive: true });
  const pythonCode = `import sys, json, faulthandler\nfaulthandler.enable(file=sys.stderr)\nprint('Unicode startup: \\u4e2d\\u6587 \\u2705', flush=True)\nprint('fixture startup error: \\u4e2d\\u6587 \\u2705', file=sys.stderr, flush=True)\nopen('comfy-stdio.json','w',encoding='utf-8').write(json.dumps({'stdout':sys.stdout.encoding,'stderr':sys.stderr.encoding,'argv':sys.argv}))\nsys.exit(7)\n`;
  await fs.writeFile(path.join(comfyDir, "main.py"), pythonCode);
  await fs.writeFile(path.join(comfyDir, "run_fixture.bat"), `@echo off\r\n"${python}" -s "${path.join(comfyDir, "main.py")}" --windows-standalone-build\r\n`);
  // Discovery selects this wrapper as Python, while its -c probe reports Python 3.
  // Use a dedicated launcher entry to bind this fixture's external interpreter.
  let launcher = await fs.readFile(fx.entry, "utf8");
  launcher = launcher.replace('const pythonCandidates = [', `const pythonCandidates = [${JSON.stringify(python)},`);
  await fs.writeFile(fx.entry, launcher);
  const run = startLauncher(t, fx, ["--desktop"], { PYTHONIOENCODING: "gbk", PYTHONUTF8: "0" });
  const { services } = await run.message("desktop:ready");
  assert.equal(services.comfy.mode, "missing");
  assert.equal(services.gateway.mode, "started"); assert.equal(services.canvas.mode, "started");
  assert.equal((await fetch(services.canvas.url)).status, 200);
  assert.equal((await fetch(`${services.gateway.url}/health`)).status, 200);
  const captured = JSON.parse(await fs.readFile(path.join(comfyDir, "comfy-stdio.json"), "utf8"));
  assert.equal(captured.stdout.toLowerCase(), "utf-8"); assert.equal(captured.stderr.toLowerCase(), "utf-8");
  assert.ok(captured.argv.includes("--disable-auto-launch"));
  assert.ok(run.messages.some(message => message.message?.includes("Unicode startup: 中文 ✅")));
  assert.ok(run.messages.some(message => /code=7/.test(message.message || "")));
  assert.ok(run.messages.some(message => /保留画布与网关/.test(message.message || "")));
  assert.equal(run.messages.some(message => message.type === "desktop:error"), false);
  await run.stop(); await closed(services.canvas.url); await closed(services.gateway.url);
  await fx.unchanged();
});

test("managed mode starts fixture gateway with safe environment and stops owned PID only", async (t) => {
  const comfy = await comfyFixture(t);
  const fx = await fixture(t, { comfyUrl: comfy.url });
  const run = startLauncher(t, fx, ["--desktop"], { ALLOW_REMOTE: "1", CORS_ORIGINS: "http://remote.test" });
  const { services } = await run.message("desktop:ready");
  assert.equal(services.gateway.mode, "started"); assert.equal(services.canvas.mode, "started");
  const env = JSON.parse(await fs.readFile(path.join(fx.root, "gateway", "spawn-env.json"), "utf8"));
  assert.equal(env.HOST, "127.0.0.1"); assert.equal(env.ALLOW_REMOTE, "0");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1"); assert.equal(env.DISABLE_NODE_BOOTSTRAP, "1");
  assert.equal(env.COMFY_URL, comfy.url);
  assert.ok(env.CORS_ORIGINS.split(",").includes(services.canvas.url));
  assert.ok(env.CORS_ORIGINS.split(",").includes(comfy.url));
  assert.ok(env.CORS_ORIGINS.split(",").includes(`http://127.0.0.1:${fx.config.canvasPort + 10}`));
  assert.notEqual(new URL(env.LAUNCHER_CONTROL_URL).port, "0");
  assert.notEqual(Number(new URL(env.LAUNCHER_CONTROL_URL).port), fx.config.controlPort);
  await run.stop();
  await closed(services.gateway.url); await closed(services.canvas.url); await closed(env.LAUNCHER_CONTROL_URL);
  assert.equal((await fetch(`${comfy.url}/system_stats`)).ok, true);
  assertReadOnlyCalls(comfy); await fx.unchanged();
});

test("managed startup rejects a non-gateway occupant without starting or touching it", async (t) => {
  const comfy = await comfyFixture(t);
  const other = await gatewayFixture(t, comfy.url, (_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"status":"ok"}'); });
  const fx = await fixture(t, { comfyUrl: comfy.url, gatewayPort: other.port });
  const run = startLauncher(t, fx, ["--desktop"]);
  const error = await run.message("desktop:error");
  assert.match(error.message, /端口.*不可用|非网关/);
  assert.equal((await bounded(run.exited))[0], 1);
  await assert.rejects(fs.access(path.join(fx.root, "gateway", "spawn-env.json")), { code: "ENOENT" });
  assert.equal((await fetch(`${other.url}/health`)).ok, true);
  assertReadOnlyCalls(comfy, other); await fx.unchanged();
});

test("missing launcher configuration is never created in desktop mode", async (t) => {
  const fx = await fixture(t);
  const configPath = path.join(fx.root, "launcher", "config.json");
  await fs.rm(configPath);
  const run = startLauncher(t, fx, ["--desktop", "--connect-only"], {
    GATEWAY_PORT: String(fx.config.gatewayPort), CANVAS_PORT: String(fx.config.canvasPort), COMFY_URL: fx.config.comfyUrl,
  });
  await run.message("desktop:error");
  assert.equal((await bounded(run.exited))[0], 1);
  await assert.rejects(fs.access(configPath), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(fx.root, "launcher", "launcher.log")), { code: "ENOENT" });
});

test("connect-only requires an existing verified gateway and never starts one", async (t) => {
  const fx = await fixture(t);
  const run = startLauncher(t, fx);
  const error = await run.message("desktop:error");
  assert.match(error.message, /connect-only.*网关/);
  assert.equal((await bounded(run.exited))[0], 1);
  assert.equal(run.messages.some((m) => m.type === "desktop:ready"), false);
  await assert.rejects(fs.access(path.join(fx.root, "gateway", "spawn-env.json")), { code: "ENOENT" });
  await fx.unchanged();
});

for (const disconnect of [false, true]) {
  test(`${disconnect ? "disconnect" : "shutdown"} during early probe cannot spawn later services`, async (t) => {
    let release;
    let seen;
    const requested = new Promise((resolve) => { seen = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const gateway = await gatewayFixture(t, "http://127.0.0.1:1", async (_req, res) => {
      seen(); await gate;
      if (!res.destroyed) res.end(JSON.stringify(health("http://127.0.0.1:1")));
    });
    const fx = await fixture(t, { gatewayPort: gateway.port });
    const run = startLauncher(t, fx, ["--desktop"]);
    await bounded(requested);
    await run.stop(disconnect);
    release();
    assert.equal(run.messages.some((m) => m.type === "desktop:ready"), false);
    await assert.rejects(fs.access(path.join(fx.root, "gateway", "spawn-env.json")), { code: "ENOENT" });
    assert.equal((await fetch(`${gateway.url}/health`)).ok, true);
    assertReadOnlyCalls(gateway); await fx.unchanged();
  });

  test(`${disconnect ? "disconnect" : "shutdown"} during gateway startup removes owned child before ready`, async (t) => {
    const comfy = await comfyFixture(t);
    const fx = await fixture(t, { comfyUrl: comfy.url, gatewayStartTimeoutSec: 20 });
    const run = startLauncher(t, fx, ["--desktop"], { FIXTURE_GATEWAY_DELAY: "1" });
    await run.message("desktop:log", (m) => m.message.includes("fixture-gateway-listening"));
    await run.stop(disconnect);
    assert.equal(run.messages.some((m) => m.type === "desktop:ready"), false);
    await closed(`http://127.0.0.1:${fx.config.gatewayPort}`);
    await closed(`http://127.0.0.1:${fx.config.canvasPort}`);
    assert.equal((await fetch(`${comfy.url}/system_stats`)).ok, true);
    assertReadOnlyCalls(comfy); await fx.unchanged();
  });
}

test("gateway redirects fail identity without contacting the redirect destination", async (t) => {
  const destination = await gatewayFixture(t, "http://127.0.0.1:1");
  const redirect = await serverFixture(t, (_req, res) => { res.writeHead(302, { location: `${destination.url}/health` }); res.end(); });
  const fx = await fixture(t, { gatewayPort: redirect.port });
  const run = startLauncher(t, fx);
  await run.message("desktop:error");
  assert.equal((await bounded(run.exited))[0], 1);
  assert.equal(destination.calls.length, 0);
  assertReadOnlyCalls(redirect); await fx.unchanged();
});

test("canvas mismatched config is not adopted and its service is preserved", async (t) => {
  const comfy = await comfyFixture(t);
  const gateway = await gatewayFixture(t, comfy.url);
  const canvas = await canvasFixture(t, "http://unrelated.test");
  const fx = await fixture(t, { comfyUrl: comfy.url, gatewayPort: gateway.port, canvasPort: canvas.port });
  const run = startLauncher(t, fx);
  const { services } = await run.message("desktop:ready");
  assert.equal(services.canvas.mode, "started"); assert.notEqual(services.canvas.url, canvas.url);
  await run.stop();
  assert.equal((await fetch(`${canvas.url}/index.html`)).ok, true);
  assertReadOnlyCalls(comfy, gateway, canvas); await fx.unchanged();
});
