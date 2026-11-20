import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { before, after, test } from "node:test";
import { createGatewayApp, stopGateway } from "../src/server.js";
import { ALL_CREATION_WORKFLOWS as CREATION_WORKFLOWS } from "../src/creation-workflows.js";
import { MODEL_LOADER_SPECS } from "../src/model-loaders.js";

process.env.DISABLE_NODE_BOOTSTRAP = "1";
let root, gateway, server, url;
let submitted = [];
let uploads = [];
const info = {};
let captureSubmission;

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "creation-http-"));
  const workflows = path.join(root, "workflows");
  await fsp.mkdir(workflows);
  await fsp.writeFile(path.join(workflows, "registry.json"), JSON.stringify({ version: 1, workflows: CREATION_WORKFLOWS }));
  for (const entry of CREATION_WORKFLOWS) {
    const source = path.resolve(import.meta.dirname, "../workflows", entry.file);
    await fsp.copyFile(source, path.join(workflows, entry.file));
    const graph = JSON.parse(await fsp.readFile(source, "utf8"));
    for (const node of Object.values(graph)) {
      const required = (info[node.class_type] ??= { input: { required: {} } }).input.required;
      for (const spec of MODEL_LOADER_SPECS.filter((spec) => spec.classType === node.class_type)) {
        if (typeof node.inputs[spec.input] !== "string") continue;
        const options = (required[spec.input] ??= [[]])[0];
        if (!options.includes(node.inputs[spec.input])) options.push(node.inputs[spec.input]);
      }
    }
  }
  for (const type of ["LoadImage", "LoadAudio", "LoadVideo"]) info[type] ??= { input: { required: {} } };
  gateway = await createGatewayApp({
    comfyUrl: "http://127.0.0.1:1", comfyDir: "", comfyFrontendDir: "", comfyWorkflowsDir: "", workflowDir: workflows,
    desktopDistribution: true, scanOnStart: false, watchWorkflows: false, updateEnabled: false,
    resourcesIndexUrl: "", resourcesIndexUrlBackup: "", dataDir: path.join(root, "data"), outputDir: path.join(root, "data", "outputs"),
    requestTimeoutMs: 5000, videoTimeoutMs: 5000, pollIntervalMs: 1,
  });
  Object.assign(gateway.comfy, {
    systemStats: async () => ({}), objectInfo: async () => info, folderPaths: async () => ({}),
    uploadImage: async (_buffer, filename, mime) => {
      const uploaded = { name: filename, subfolder: "creation/uploaded", type: "input" };
      uploads.push({ ...uploaded, mime });
      return uploaded;
    },
    submit: async (workflow) => {
      submitted.push(workflow);
      captureSubmission?.(workflow);
      return { promptId: String(submitted.length) };
    },
    history: async (id) => {
      const graph = submitted[Number(id) - 1];
      const type = Object.values(graph).some((node) => node.class_type === "SaveVideo") ? "video" : Object.values(graph).some((node) => node.class_type.startsWith("SaveAudio")) ? "audio" : "image";
      const ext = { video: "mp4", audio: "flac", image: "png" }[type];
      const key = { video: "videos", audio: "audio", image: "images" }[type];
      return { status: { completed: true }, outputs: { result: { [key]: [{ filename: `test.${ext}`, type: "output" }] } } };
    },
    view: async (file) => ({ buffer: Buffer.from("仅测试桩，不执行 GPU"), mimeType: file.filename.endsWith("mp4") ? "video/mp4" : file.filename.endsWith("png") ? "image/png" : "audio/flac" }),
  });
  await gateway.setup.scan();
  server = gateway.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (gateway) await stopGateway(gateway);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (root) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function post(endpoint, body) {
  const response = await fetch(`${url}${endpoint}`, {
    method: "POST", ...(body instanceof FormData ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
function file(form, field, index) {
  const type = { images: "image/png", audios: "audio/flac", videos: "video/mp4" }[field];
  const ext = { images: "png", audios: "flac", videos: "mp4" }[field];
  form.append(field, new Blob([`素材${index}`], { type }), `${index}.${ext}`);
}

test("HTTP 七个指定 ID 可通过模型列表发现", async () => {
  const response = await fetch(`${url}/v1/models`);
  const data = await response.json();
  for (const entry of CREATION_WORKFLOWS) {
    const model = data.data.find((model) => model.id === entry.id);
    assert.ok(model, entry.id);
    if (entry.type === "video") assert.equal(model.metadata.imageInputs, 9);
  }
});

test("HTTP 完整Qwen2.1编辑链绑定三图且使用匹配模型VAE编码器和9步采样", async () => {
  const form = new FormData();
  form.set("model", "creation-image-qwen21-edit");
  form.set("prompt", "外套改成蓝色，面容不变");
  form.set("params", JSON.stringify({ seed: 56, resolution: "1080P" }));
  for (let i = 0; i < 3; i++) file(form, "images", i);
  const result = await post("/v1/images/edits", form);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const graph = submitted.at(-1);
  assert.equal(graph["430"].class_type, "TextEncodeQwenImage21");
  assert.equal(graph["430"].inputs.prompt, "外套改成蓝色，面容不变");
  assert.equal(graph["430"].inputs.resolution, 1024);
  assert.equal(graph["456"].inputs.noise_seed, 56);
  assert.match(graph["460"].inputs.unet_name, /qwen_image_2.1_turbo_int8_convrot/);
  assert.equal(graph["452"].inputs.clip_name, "qwen3vl_8b_int8_convrot.safetensors");
  assert.equal(graph["453"].inputs.vae_name, "qwen_image_2.1_vae_bf16.safetensors");
  assert.equal(graph["459"].inputs.strength_model, 0.48);
  assert.equal(graph["467"].inputs.sigmas.split(",").length - 1, 9);
  assert.deepEqual(graph["444"].inputs.latent_image, ["430", 2]);
  for (let i = 1; i <= 3; i++) assert.equal(graph[graph["430"].inputs[`images.image_${i}`][0]].class_type, "LoadImage");
  assert.equal(graph["170:169"], undefined);
});

test("HTTP Qwen2.1拒绝空参考和超出3图而不静默截断", async () => {
  const before = submitted.length;
  for (const count of [0,4]) {
    const form = new FormData();form.set("model","creation-image-qwen21-edit");form.set("prompt","修改服装");
    for(let i=0;i<count;i++)file(form,"images",i);
    const result = await post("/v1/images/edits",form);
    assert.equal(result.status,400,JSON.stringify(result.data));
  }
  assert.equal(submitted.length,before);
});

test("HTTP 创作图像编辑音频和视频保存使用中文素材名而非提示词", async()=>{
 const prompt="极长镜头和材质细节提示词不应成为文件名";
 let result=await post("/v1/images/generations",{model:"creation-image-krea2",prompt,response_format:"url",params:{assetName:"陆明",filenamePrefix:"../../bad"}});
 assert.equal(result.status,200,JSON.stringify(result.data));
 assert.match(submitted.at(-1)["95"].inputs.filename_prefix,/^creation\/陆明_[a-f0-9-]+$/);
 assert.ok(decodeURIComponent(result.data.data[0].url).includes("陆明_img_"));
 const download=await fetch(`${url}${new URL(result.data.data[0].url).pathname}`);assert.equal(download.status,200);assert.ok((await download.arrayBuffer()).byteLength>0);
 assert.equal(result.data.data[0].url.includes(prompt),false);
 const form=new FormData();form.set("model","creation-image-qwen21-edit");form.set("prompt",prompt);form.set("params",JSON.stringify({assetName:"陆明-蓝衣"}));form.set("response_format","url");file(form,"images",0);
 result=await post("/v1/images/edits",form);assert.equal(result.status,200,JSON.stringify(result.data));
 assert.match(submitted.at(-1)["422"].inputs.filename_prefix,/^creation\/陆明-蓝衣_/);
 assert.ok(decodeURIComponent(result.data.data[0].url).includes("陆明-蓝衣_img_"));
 result=await post("/v1/audio/speech",{model:"creation-audio-voice-design",mode:"voice-design",input:prompt,voice_description:"低沉男声",response_format:"url",params:{assetName:"陆明-音色"}});
 assert.equal(result.status,200,JSON.stringify(result.data));assert.match(submitted.at(-1)["3"].inputs.filename_prefix,/^creation\/陆明-音色_/);
 assert.ok(decodeURIComponent(result.data.data[0].url).includes("陆明-音色_aud_"));
 const video=new FormData();video.set("model","creation-video-h3-768");video.set("prompt",prompt);video.set("params",JSON.stringify({assetName:"灯塔重逢-视频"}));file(video,"images",0);
 const pending=new Promise(resolve=>{captureSubmission=resolve;});
 result=await post("/v1/videos",video);assert.equal(result.status,200,JSON.stringify(result.data));
 const graph=await pending;captureSubmission=null;assert.match(graph["12"].inputs.filename_prefix,/^creation\/灯塔重逢-视频_/);
 const taskId=result.data.id;
 let completed;
 for (let attempt=0;attempt<100;attempt++) {
  const response=await fetch(`${url}/v1/videos/${taskId}`);completed=await response.json();
  if (["completed","failed"].includes(completed.status)) break;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(completed.status,"completed",JSON.stringify(completed));
 assert.ok(decodeURIComponent(completed.url).includes("灯塔重逢-视频_"));
 const videoDownload=await fetch(`${url}${new URL(completed.url).pathname}`);
 assert.equal(videoDownload.status,200);assert.ok((await videoDownload.arrayBuffer()).byteLength>0);
 const stored=await fsp.readdir(gateway.config.outputDir);
 for (const label of ["陆明_img_","陆明-蓝衣_img_","陆明-音色_aud_","灯塔重逢-视频_"]) assert.ok(stored.some(name=>name.startsWith(label)),label);
 for (const unsafe of ["..\\secret","bad/name","CON:bad",".hidden"]) {
  const rejected=await fetch(`${url}/files/${encodeURIComponent(unsafe)}`);assert.equal(rejected.status,400,unsafe);
 }
});

test("HTTP Krea2 JSON 与 Qwen multipart 参数绑定", async () => {
  let result = await post("/v1/images/generations", { model: "creation-image-krea2", prompt: "测试画面", size: "1920x1080", params: { seed: 31 } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(submitted.at(-1)["102"].inputs.text, "测试画面");
  assert.equal(submitted.at(-1)["96"].inputs.seed, 31);
  const form = new FormData();
  form.set("model", "creation-image-qwen-edit");
  form.set("prompt", "修改背景");
  form.set("params", JSON.stringify({ seed: 42 }));
  file(form, "images", 0);
  result = await post("/v1/images/edits", form);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(submitted.at(-1)["170:151"].inputs.prompt, "修改背景");
  assert.equal(submitted.at(-1)["170:169"].inputs.seed, 42);
  assert.equal(submitted.at(-1)["41"].inputs.image, `creation/uploaded/${uploads.at(-1).name}`);
});

for (const [id, node] of [["creation-video-h3-768", "2"], ["creation-video-h3-1080", "256"]]) {
  test(`HTTP ${id} 接收全部15个媒体并保留编号和上传路径`, { timeout: 5000 }, async () => {
    const form = new FormData();
    form.set("model", id);
    form.set("prompt", "__MINIMAX_H3_REF_1__参考声音，画面缓慢移动");
    form.set("seconds", "6");
    const references = [
      ...Array.from({ length: 3 }, (_, index) => ({ type: "audio", index })),
      ...Array.from({ length: 9 }, (_, index) => ({ type: "image", index })),
      ...Array.from({ length: 3 }, (_, index) => ({ type: "video", index })),
    ];
    form.set("params", JSON.stringify({ seed: 93, aspect_ratio: "9:16", references }));
    for (let i = 0; i < 9; i++) file(form, "images", i);
    for (let i = 0; i < 3; i++) file(form, "audios", i);
    for (let i = 0; i < 3; i++) file(form, "videos", i);
    const pending = new Promise((resolve) => { captureSubmission = resolve; });
    const result = await post("/v1/videos", form);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.ok(result.data.id);
    const graph = await pending;
    captureSubmission = null;
    assert.equal(graph[node].inputs.aspect_ratio, "9:16");
    assert.equal(graph[node].inputs.resolution, "768P");
    assert.equal(graph[node].inputs.seconds, 6);
    assert.equal(graph[node].inputs.media_type_1, "audio");
    assert.equal(graph[node].inputs.media_type_15, "video");
    assert.equal(Object.values(graph).filter((item) => item.class_type === "LoadImage").length, 9);
    assert.equal(Object.values(graph).filter((item) => item.class_type === "LoadAudio").length, 3);
    assert.equal(Object.values(graph).filter((item) => item.class_type === "LoadVideo").length, 3);
    const video = graph[graph[node].inputs.media_15[0]];
    assert.match(video.inputs.file, /^creation\/uploaded\/.+\.mp4$/);
  });
}

for (const resolution of ["360P", "480P", "540P", "720P", "768P", "1080P"]) {
  test(`HTTP H3 ${resolution} 选择写入对应专用工作流`, { timeout: 5000 }, async () => {
    const upscale = resolution === "1080P";
    const form = new FormData();
    form.set("model", upscale ? "creation-video-h3-1080" : "creation-video-h3-768");
    form.set("prompt", "测试分辨率");
    form.set("params", JSON.stringify({ seed: 42, resolution: resolution.toLowerCase(), scale: 4 }));
    file(form, "images", 0);
    const pending = new Promise((resolve) => { captureSubmission = resolve; });
    try {
      const result = await post("/v1/videos", form);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      const graph = await pending;
      assert.equal(graph[upscale ? "256" : "2"].inputs.resolution, upscale ? "768P" : resolution);
      if (upscale) {
        assert.equal(graph["210"].inputs["mode.scale"], 1.4);
        assert.equal(graph["258"].class_type, "MiniMaxH3EasySecondPassConditioning");
      } else {
        assert.equal(graph["210"], undefined);
      }
    } finally {
      captureSubmission = null;
    }
  });
}

test("HTTP 音色设计、克隆、无歌词音乐传到指定节点", async () => {
  let result = await post("/v1/audio/speech", {
    model: "creation-audio-voice-design", mode: "voice-design", input: "测试台词", voice_description: "温和清晰的成年嗓音", params: { seed: 9 },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(submitted.at(-1)["2"].inputs.voice_description, "温和清晰的成年嗓音");
  const form = new FormData();
  form.set("model", "creation-audio-voice-clone");
  form.set("mode", "voice-clone");
  form.set("input", "测试克隆台词");
  form.set("params", JSON.stringify({ seed: 10 }));
  file(form, "audios", 0);
  result = await post("/v1/audio/speech", form);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(submitted.at(-1)["42"].inputs.text, "测试克隆台词");
  assert.deepEqual(submitted.at(-1)["42"].inputs.ref_text, ["40", 0]);
  result = await post("/v1/audio/speech", {
    model: "creation-audio-music", mode: "music", input: "平静器乐", lyrics: "", params: { seed: 11, maxDuration: 12 },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(submitted.at(-1)["37:13"].inputs.lyrics, " ");
  assert.equal(submitted.at(-1)["37:13"].inputs.max_duration, 12);
});

test("HTTP 音色设计拒绝静默中性音色兜底，接受 params 描述", async () => {
  let result = await post("/v1/audio/speech", { model: "creation-audio-voice-design", mode: "voice-design", input: "测试" });
  assert.equal(result.status, 400);
  assert.equal(result.data.error.code, "missing_parameter");
  result = await post("/v1/audio/speech", { model: "creation-audio-voice-design", mode: "voice-design", input: "测试", params: { voiceDescription: "清晰的成年嗓音", seed: 3 } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(submitted.at(-1)["2"].inputs.voice_description, "清晰的成年嗓音");
});

test("HTTP 超额媒体和缺少动态 LoadVideo 时在提交前拒绝", async () => {
  const form = new FormData();
  form.set("model", "creation-video-h3-768");
  form.set("prompt", "测试");
  for (let i = 0; i < 10; i++) file(form, "images", i);
  let result = await post("/v1/videos", form);
  assert.equal(result.status, 400);
  assert.equal(result.data.error.code, "too_many_reference_media");
  const saved = info.LoadVideo;
  delete info.LoadVideo;
  await gateway.setup.scan();
  const video = new FormData();
  video.set("model", "creation-video-h3-768");
  video.set("prompt", "测试");
  file(video, "videos", 0);
  const count = submitted.length;
  result = await post("/v1/videos", video);
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.equal(result.data.error.code, "workflow_unavailable");
  assert.equal(submitted.length, count);
  info.LoadVideo = saved;
  await gateway.setup.scan();
});

test("HTTP 缺 ASR 不降级免转录，精确底模缺失不换量化", async () => {
  const saved = info.Qwen3TTSSenseVoiceASR;
  delete info.Qwen3TTSSenseVoiceASR;
  const unets = info.UNETLoader.input.required.unet_name[0];
  const original = [...unets];
  info.UNETLoader.input.required.unet_name[0] = unets.map((name) => name === "krea2_turbo_fp8.safetensors" ? "krea2_turbo_fp8_scaled.safetensors" : name);
  await gateway.setup.scan();
  const count = submitted.length;
  const clone = await post("/v1/audio/speech", { model: "creation-audio-voice-clone", mode: "voice-clone", input: "测试" });
  assert.equal(clone.status, 409);
  assert.match(JSON.stringify(clone.data), /Qwen3TTSSenseVoiceASR/);
  const image = await post("/v1/images/generations", { model: "creation-image-krea2", prompt: "测试" });
  assert.equal(image.status, 409);
  assert.match(JSON.stringify(image.data), /krea2_turbo_fp8/);
  assert.equal(submitted.length, count);
  info.Qwen3TTSSenseVoiceASR = saved;
  info.UNETLoader.input.required.unet_name[0] = original;
  await gateway.setup.scan();
});
