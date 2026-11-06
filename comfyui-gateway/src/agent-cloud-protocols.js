// Pure protocol adapters. No networking, credentials storage, logging, or provider SDKs.
export class AgentCloudError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new AgentCloudError(code, message, status); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const formats = new Set(["openai", "responses", "gemini", "anthropic", "grok"]);
const fields = new Set(["model", "messages", "tools", "tool_choice", "stream", "temperature", "max_tokens", "max_completion_tokens", "top_p", "stop", "parallel_tool_calls"]);
const invalid = () => fail("invalid_response", "模型 API 返回了无效的协议响应", 502);
const upstreamError = () => fail("upstream_status", "模型 API 返回了错误响应", 502);
const toolLimit = 128;

export function parseAgentCloudFormat(value = "openai") {
  if (typeof value !== "string" || !formats.has(value)) fail("invalid_api_format", "不支持的模型 API 协议");
  return value;
}

// Called only after the transport's URL/security validation. The sole generated query is alt=sse.
export function applyAgentCloudEndpoint(url, operation, apiFormat = "openai", request = {}) {
  const format = parseAgentCloudFormat(apiFormat);
  let base = url.pathname.replace(/\/+$/, "");
  const fullGemini = base.match(/\/models\/([^/]+):(streamGenerateContent|generateContent)$/i);
  base = base.replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/i, "")
    .replace(/\/(?:chat\/completions|responses|messages|models)$/i, "");
  if (!base) base = format === "gemini" ? "/v1beta" : "/v1";
  if (operation === "models") url.pathname = `${base}/models`;
  else if (format === "gemini") {
    const rawModel = request.model || (fullGemini ? decodeURIComponent(fullGemini[1]) : "");
    const model = typeof rawModel === "string" ? rawModel.replace(/^models\//, "") : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(model)) fail("invalid_model", "Gemini 模型名称无效");
    url.pathname = `${base}/models/${model}:${request.stream ? "streamGenerateContent" : "generateContent"}`;
    if (request.stream) url.search = "?alt=sse";
  } else url.pathname = `${base}/${format === "responses" ? "responses" : format === "anthropic" ? "messages" : "chat/completions"}`;
  return url;
}

export function agentCloudAuthHeaders(apiFormat, apiKey) {
  const format = parseAgentCloudFormat(apiFormat);
  if (format === "anthropic") return { "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey } : {}) };
  return apiKey ? { [format === "gemini" ? "x-goog-api-key" : "authorization"]: format === "gemini" ? apiKey : `Bearer ${apiKey}` } : {};
}

function checkTree(value, depth = 0) {
  if (depth > 64) fail("invalid_request", "模型请求嵌套过深");
  if (Array.isArray(value)) value.forEach((item) => checkTree(item, depth + 1));
  else if (object(value)) Object.values(value).forEach((item) => checkTree(item, depth + 1));
}
function parts(message) {
  if (message.content === undefined || message.content === null) return [];
  if (typeof message.content === "string") return message.content ? [{ type: "text", text: message.content }] : [];
  if (!Array.isArray(message.content) || message.content.length > 256) fail("invalid_messages", "消息内容格式无效");
  return message.content.map((part) => {
    if (!object(part)) fail("invalid_messages", "消息内容格式无效");
    if (part.type === "text" && typeof part.text === "string") return part;
    if (part.type === "image_url" && object(part.image_url) && typeof part.image_url.url === "string") return part;
    fail("invalid_messages", "消息只支持文本与图片内容");
  });
}
function text(message) { return parts(message).map((part) => { if (part.type !== "text") fail("invalid_messages", "此消息只支持文本"); return part.text; }).join("\n"); }
function args(call) {
  try { const result = JSON.parse(call.function.arguments || "{}"); if (object(result)) return result; } catch { /* fixed public error */ }
  fail("invalid_tools", "工具调用参数必须是 JSON 对象");
}
function dataImage(url) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match || match[2].length % 4 !== 0) fail("invalid_image", "此协议的图片必须为有效的 PNG/JPEG/WebP/GIF base64 data URL");
  return { mimeType: match[1], data: match[2] };
}
function validateRequest(input) {
  if (!object(input)) fail("invalid_request", "缺少模型请求");
  checkTree(input);
  if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 256) fail("invalid_model", "模型名称无效");
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 256) fail("invalid_messages", "消息列表无效或超过限制");
  for (const message of input.messages) {
    if (!object(message) || !["system", "developer", "user", "assistant", "tool"].includes(message.role)) fail("invalid_messages", "消息角色无效");
    parts(message);
    if (message.provider_metadata !== undefined && !object(message.provider_metadata)) fail("invalid_messages", "消息延续元数据无效");
    if (message.role === "tool" && (typeof message.tool_call_id !== "string" || !message.tool_call_id)) fail("invalid_tools", "工具结果缺少调用标识");
    if (message.tool_calls !== undefined) {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length > toolLimit) fail("invalid_tools", "工具调用列表无效");
      for (const call of message.tool_calls) {
        if (!object(call) || (call.type !== undefined && call.type !== "function") || typeof call.id !== "string" || !call.id || !object(call.function) || typeof call.function.name !== "string" || !call.function.name || typeof call.function.arguments !== "string") fail("invalid_tools", "工具调用格式无效");
        args(call);
        if (call.function.thoughtSignature !== undefined && typeof call.function.thoughtSignature !== "string") fail("invalid_tools", "工具调用签名无效");
      }
    }
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools) || input.tools.length > 64) fail("invalid_tools", "工具列表无效或超过限制");
    for (const tool of input.tools) {
      if (!object(tool) || tool.type !== "function" || !object(tool.function) || typeof tool.function.name !== "string" || !tool.function.name || tool.function.name.length > 128 || (tool.function.description !== undefined && typeof tool.function.description !== "string") || (tool.function.parameters !== undefined && !object(tool.function.parameters))) fail("invalid_tools", "仅支持标准 function 工具");
    }
  }
  if (input.stream !== undefined && typeof input.stream !== "boolean") fail("invalid_stream", "stream 必须为布尔值");
  for (const key of ["temperature", "top_p", "max_tokens", "max_completion_tokens"]) if (input[key] !== undefined && (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] < 0 || (key.startsWith("max_") && (!Number.isInteger(input[key]) || input[key] === 0)))) fail("invalid_request", "模型参数格式无效");
  if (input.parallel_tool_calls !== undefined && typeof input.parallel_tool_calls !== "boolean") fail("invalid_tools", "parallel_tool_calls 必须为布尔值");
  if (input.stop !== undefined && typeof input.stop !== "string" && (!Array.isArray(input.stop) || input.stop.length > 16 || input.stop.some((value) => typeof value !== "string"))) fail("invalid_request", "stop 格式无效");
  const choice = input.tool_choice;
  if (choice !== undefined && !["auto", "none", "required"].includes(choice) && !(object(choice) && choice.type === "function" && object(choice.function) && typeof choice.function.name === "string" && choice.function.name)) fail("invalid_tools", "tool_choice 格式无效");
  return Object.fromEntries(Object.entries(input).filter(([key]) => fields.has(key)));
}
function metadata(message, provider, field) {
  const value = message.provider_metadata?.[provider]?.[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1024 || value.some((item) => !object(item))) fail("invalid_messages", "消息延续元数据无效");
  return value;
}
const stopList = (value) => typeof value === "string" ? [value] : value;
function combine(messages, role, content, field) {
  if (!content.length) return;
  if (messages.at(-1)?.role === role) messages.at(-1)[field].push(...content);
  else messages.push({ role, [field]: content });
}
function responsesContent(message) {
  return parts(message).map((part) => part.type === "text"
    ? { type: message.role === "assistant" ? "output_text" : "input_text", text: part.text }
    : { type: "input_image", image_url: part.image_url.url });
}
function responseItems(items, input = false) {
  return items.filter((item) => {
    if (!object(item)) input ? fail("invalid_messages", "Responses 延续数据无效") : invalid();
    if (!["reasoning", "message", "function_call"].includes(item.type)) {
      if (input) fail("invalid_messages", "Responses 延续数据只支持消息、推理与 function_call");
      // Built-in code/search tools are deliberately not converted into canvas tools.
      return false;
    }
    if (item.type === "message" && item.role !== "assistant") input ? fail("invalid_messages", "Responses 延续消息角色无效") : invalid();
    return true;
  });
}
export function prepareAgentCloudRequest(input, apiFormat = "openai") {
  const format = parseAgentCloudFormat(apiFormat);
  const request = validateRequest(input);
  if (format === "openai" || format === "grok") return request;
  if (format === "responses") {
    const result = { model: request.model, input: [], store: false, include: ["reasoning.encrypted_content"] };
    for (const message of request.messages) {
      if (message.role === "tool") result.input.push({ type: "function_call_output", call_id: message.tool_call_id, output: text(message) });
      else {
        const native = message.role === "assistant" ? metadata(message, "responses", "output") : undefined;
        if (native?.length) { result.input.push(...responseItems(native, true)); continue; }
        const content = responsesContent(message);
        if (content.length) result.input.push({ role: message.role, content });
        for (const call of message.tool_calls || []) result.input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
    for (const key of ["stream", "temperature", "top_p", "parallel_tool_calls"]) if (request[key] !== undefined) result[key] = request[key];
    if (request.max_completion_tokens ?? request.max_tokens) result.max_output_tokens = request.max_completion_tokens ?? request.max_tokens;
    if (request.tools) result.tools = request.tools.map(({ function: fn }) => ({ type: "function", ...fn }));
    if (request.tool_choice !== undefined) result.tool_choice = object(request.tool_choice) ? { type: "function", name: request.tool_choice.function.name } : request.tool_choice;
    return result;
  }
  if (format === "gemini") {
    const result = { contents: [] };
    const system = [];
    const calls = new Map();
    for (const message of request.messages) {
      if (["system", "developer"].includes(message.role)) { system.push({ text: text(message) }); continue; }
      if (message.role === "tool") {
        const call = calls.get(message.tool_call_id);
        if (!call) fail("invalid_tools", "Gemini 工具结果未找到对应调用");
        let value; try { value = JSON.parse(text(message)); } catch { value = text(message); }
        combine(result.contents, "user", [{ functionResponse: { name: call.name, ...(call.nativeId ? { id: call.nativeId } : {}), response: { result: value } } }], "parts");
        continue;
      }
      const native = message.role === "assistant" ? metadata(message, "gemini", "parts") : undefined;
      let converted = native?.length ? native : parts(message).map((part) => part.type === "text" ? { text: part.text } : { inlineData: dataImage(part.image_url.url) });
      if (native?.length && native.some((part) => !(typeof part.text === "string" || object(part.functionCall) || object(part.inlineData)))) fail("invalid_messages", "Gemini 延续内容格式无效");
      for (const [index, call] of (message.tool_calls || []).entries()) {
        const nativeCall = native?.filter((part) => part.functionCall)[index]?.functionCall;
        calls.set(call.id, { name: call.function.name, nativeId: nativeCall?.id });
        if (!native?.length) converted.push({ functionCall: { name: call.function.name, args: args(call) }, ...(call.function.thoughtSignature ? { thoughtSignature: call.function.thoughtSignature } : {}) });
      }
      combine(result.contents, message.role === "assistant" ? "model" : "user", converted, "parts");
    }
    if (system.length) result.systemInstruction = { parts: system };
    const config = {};
    if (request.temperature !== undefined) config.temperature = request.temperature;
    if (request.top_p !== undefined) config.topP = request.top_p;
    if (request.max_completion_tokens ?? request.max_tokens) config.maxOutputTokens = request.max_completion_tokens ?? request.max_tokens;
    if (request.stop !== undefined) config.stopSequences = stopList(request.stop);
    if (Object.keys(config).length) result.generationConfig = config;
    if (request.tools?.length) result.tools = [{ functionDeclarations: request.tools.map(({ function: fn }) => ({ name: fn.name, ...(fn.description !== undefined ? { description: fn.description } : {}), parameters: fn.parameters || { type: "object", properties: {} } })) }];
    if (request.tool_choice !== undefined) result.toolConfig = { functionCallingConfig: object(request.tool_choice) ? { mode: "ANY", allowedFunctionNames: [request.tool_choice.function.name] } : { mode: { auto: "AUTO", none: "NONE", required: "ANY" }[request.tool_choice] } };
    return result;
  }
  const result = { model: request.model, messages: [], max_tokens: request.max_completion_tokens ?? request.max_tokens ?? 4096 };
  const system = [];
  for (const message of request.messages) {
    if (["system", "developer"].includes(message.role)) { system.push({ type: "text", text: text(message) }); continue; }
    if (message.role === "tool") { combine(result.messages, "user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: text(message) }], "content"); continue; }
    const content = parts(message).map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      const image = dataImage(part.image_url.url);
      return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
    });
    if (message.role === "assistant") {
      const thinking = metadata(message, "anthropic", "thinking") || [];
      if (thinking.some((item) => !["thinking", "redacted_thinking"].includes(item.type))) fail("invalid_messages", "Anthropic 延续内容格式无效");
      content.unshift(...thinking);
    }
    for (const call of message.tool_calls || []) content.push({ type: "tool_use", id: call.id, name: call.function.name, input: args(call) });
    combine(result.messages, message.role, content, "content");
  }
  if (system.length) result.system = system;
  for (const key of ["stream", "temperature", "top_p"]) if (request[key] !== undefined) result[key] = request[key];
  if (request.stop !== undefined) result.stop_sequences = stopList(request.stop);
  if (request.tools) result.tools = request.tools.map(({ function: fn }) => ({ name: fn.name, ...(fn.description !== undefined ? { description: fn.description } : {}), input_schema: fn.parameters || { type: "object", properties: {} } }));
  if (request.tool_choice !== undefined) result.tool_choice = object(request.tool_choice) ? { type: "tool", name: request.tool_choice.function.name } : { type: request.tool_choice === "required" ? "any" : request.tool_choice };
  if (request.parallel_tool_calls !== undefined) result.tool_choice = { ...(result.tool_choice || { type: "auto" }), disable_parallel_tool_use: !request.parallel_tool_calls };
  return result;
}

const chunk = (delta, finish) => ({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] });
const reply = (message, finish = "stop") => ({ choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }] });
const finishReason = (value) => ["tool_use", "tool_calls"].includes(value) ? "tool_calls" : ["MAX_TOKENS", "max_tokens", "max_output_tokens", "length"].includes(value) ? "length" : "stop";
function tool(id, name, argumentsText, index, signature) {
  if (typeof id !== "string" || !id || typeof name !== "string" || !name || typeof argumentsText !== "string") invalid();
  return { ...(index === undefined ? {} : { index }), id, type: "function", function: { name, arguments: argumentsText, ...(signature ? { thoughtSignature: signature } : {}) } };
}
function geminiParts(data) {
  if (!object(data) || data.error || data.promptFeedback?.blockReason) upstreamError();
  if (data.candidates === undefined && data.usageMetadata) return [];
  if (!Array.isArray(data.candidates)) invalid();
  const candidate = data.candidates[0];
  if (!candidate) return [];
  if (candidate.finishReason && !["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) upstreamError();
  const result = candidate.content?.parts || [];
  if (!Array.isArray(result) || result.some((part) => !object(part))) invalid();
  return result;
}
function geminiMessage(native, start = 0, streaming = false) {
  let content = "", reasoning_content = "";
  const tool_calls = [];
  for (const part of native) {
    if (part.text !== undefined) { if (typeof part.text !== "string") invalid(); if (part.thought) reasoning_content += part.text; else content += part.text; }
    if (part.functionCall) {
      const call = part.functionCall;
      if (!object(call) || (call.args !== undefined && !object(call.args)) || (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== "string")) invalid();
      const index = start + tool_calls.length;
      tool_calls.push(tool(call.id || `gemini_call_${index}`, call.name, JSON.stringify(call.args || {}), streaming ? index : undefined, part.thoughtSignature));
    }
  }
  return { content, ...(reasoning_content ? { reasoning_content } : {}), ...(tool_calls.length ? { tool_calls } : {}) };
}
function responsesMessage(data) {
  if (!object(data) || data.error || ["failed", "cancelled"].includes(data.status)) upstreamError();
  if (!Array.isArray(data.output)) invalid();
  const output = responseItems(data.output);
  let content = "", reasoning_content = "";
  const tool_calls = [];
  for (const item of output) {
    if (item.type === "message") {
      if (!Array.isArray(item.content)) invalid();
      for (const part of item.content) if (part.type === "output_text") { if (typeof part.text !== "string") invalid(); content += part.text; }
    } else if (item.type === "reasoning") {
      for (const part of item.summary || []) { if (typeof part.text !== "string") invalid(); reasoning_content += part.text; }
    } else tool_calls.push(tool(item.call_id, item.name, item.arguments || "{}"));
  }
  return { content, ...(reasoning_content ? { reasoning_content } : {}), ...(tool_calls.length ? { tool_calls } : {}), provider_metadata: { responses: { output } } };
}
function anthropicMessage(data) {
  if (!object(data) || data.error) upstreamError();
  if (!Array.isArray(data.content)) invalid();
  let content = "", reasoning_content = "";
  const thinking = [], tool_calls = [];
  for (const block of data.content) {
    if (!object(block)) invalid();
    if (block.type === "text") { if (typeof block.text !== "string") invalid(); content += block.text; }
    if (["thinking", "redacted_thinking"].includes(block.type)) { thinking.push(block); if (block.type === "thinking") reasoning_content += block.thinking || ""; }
    if (block.type === "tool_use") { if (!object(block.input)) invalid(); tool_calls.push(tool(block.id, block.name, JSON.stringify(block.input))); }
  }
  return { content, ...(reasoning_content ? { reasoning_content } : {}), ...(tool_calls.length ? { tool_calls } : {}), ...(thinking.length ? { provider_metadata: { anthropic: { thinking } } } : {}) };
}
export function normalizeAgentCloudModels(data, apiFormat = "openai") {
  if (!object(data) || data.error) upstreamError();
  const gemini = apiFormat === "gemini";
  const models = gemini ? data.models : data.data;
  if (!Array.isArray(models) || models.length > 10000) invalid();
  return { object: "list", data: models.filter((model) => object(model) && (!gemini || (Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent"))))
    .map((model) => gemini && typeof model.name === "string" ? model.name.replace(/^models\//, "") : model.id)
    .filter((id) => typeof id === "string" && id.length > 0 && id.length <= 256).map((id) => ({ id, object: "model" })) };
}

// One normalizer per upstream response; metadata snapshots are emitted once at completion,
// not appended as text. Frontends retain provider_metadata on the next assistant message.
export function createAgentCloudNormalizer(apiFormat = "openai") {
  const format = parseAgentCloudFormat(apiFormat);
  const nativeParts = [], blocks = new Map(), responseOutput = new Map(), calls = new Map();
  let callCount = 0, complete = false, responseContent = false, responseReasoning = false;
  const nextCall = () => { if (callCount >= toolLimit) invalid(); return callCount++; };
  const index = (value) => { if (!Number.isInteger(value) || value < 0 || value >= 1024) invalid(); return value; };
  const finish = () => {
    if (complete || format === "openai" || format === "grok") return [];
    complete = true;
    if (format === "gemini") return nativeParts.length ? [chunk({ provider_metadata: { gemini: { parts: nativeParts } } })] : [];
    if (format === "anthropic") {
      const thinking = [...blocks.values()].filter((block) => ["thinking", "redacted_thinking"].includes(block.type)).map(({ toolIndex, ...block }) => block);
      return thinking.length ? [chunk({ provider_metadata: { anthropic: { thinking } } })] : [];
    }
    return responseOutput.size ? [chunk({ provider_metadata: { responses: { output: responseItems([...responseOutput.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)) } } })] : [];
  };
  return {
    finish,
    json(data) {
      if (format === "openai" || format === "grok") return data;
      if (format === "gemini") { const parts = geminiParts(data); const message = geminiMessage(parts); return reply({ ...message, provider_metadata: { gemini: { parts } } }, message.tool_calls?.length ? "tool_calls" : finishReason(data.candidates?.[0]?.finishReason)); }
      if (format === "responses") { const message = responsesMessage(data); return reply(message, message.tool_calls?.length ? "tool_calls" : finishReason(data.incomplete_details?.reason)); }
      const message = anthropicMessage(data); return reply(message, finishReason(data.stop_reason));
    },
    event(data, eventName = "") {
      if (!object(data)) invalid();
      if (data.error || data.type === "error" || eventName === "error") upstreamError();
      if (format === "openai" || format === "grok") return [data];
      if (format === "gemini") {
        const parts = geminiParts(data);
        const message = geminiMessage(parts, callCount, true);
        for (const unused of message.tool_calls || []) nextCall();
        nativeParts.push(...parts);
        if (nativeParts.length > 1024) invalid();
        return parts.length ? [chunk(message, data.candidates?.[0]?.finishReason ? (callCount ? "tool_calls" : finishReason(data.candidates[0].finishReason)) : undefined)] : [];
      }
      if (format === "anthropic") {
        const type = data.type || eventName;
        if (type === "content_block_start") {
          const key = index(data.index), block = data.content_block;
          if (!object(block) || blocks.has(key)) invalid();
          if (block.type === "tool_use") {
            const toolIndex = nextCall();
            blocks.set(key, { ...block, toolIndex, partial: "" });
            return [chunk({ tool_calls: [tool(block.id, block.name, "", toolIndex)] })];
          }
          blocks.set(key, { ...block });
          return block.type === "text" && block.text ? [chunk({ content: block.text })] : block.type === "thinking" && block.thinking ? [chunk({ reasoning_content: block.thinking })] : [];
        }
        if (type === "content_block_delta") {
          const block = blocks.get(index(data.index)), delta = data.delta;
          if (!block || !object(delta)) invalid();
          if (delta.type === "text_delta") { if (typeof delta.text !== "string" || block.type !== "text") invalid(); return [chunk({ content: delta.text })]; }
          if (delta.type === "input_json_delta") { if (typeof delta.partial_json !== "string" || block.type !== "tool_use") invalid(); block.partial += delta.partial_json; return [chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: delta.partial_json } }] })]; }
          if (delta.type === "thinking_delta") { if (typeof delta.thinking !== "string" || block.type !== "thinking") invalid(); block.thinking = (block.thinking || "") + delta.thinking; return [chunk({ reasoning_content: delta.thinking })]; }
          if (delta.type === "signature_delta") { if (typeof delta.signature !== "string") invalid(); block.signature = (block.signature || "") + delta.signature; }
          return [];
        }
        if (type === "content_block_stop") {
          const block = blocks.get(index(data.index));
          if (!block) invalid();
          if (block.type === "tool_use") {
            if (block.partial) { try { if (!object(JSON.parse(block.partial))) invalid(); } catch { invalid(); } return []; }
            return [chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: JSON.stringify(block.input || {}) } }] })];
          }
          return [];
        }
        if (type === "message_delta") return [chunk({}, finishReason(data.delta?.stop_reason))];
        if (type === "message_stop") return finish();
        return [];
      }
      const type = data.type || eventName;
      if (["response.failed", "response.cancelled"].includes(type)) upstreamError();
      if (type === "response.output_item.added") {
        const key = index(data.output_index), item = data.item;
        if (!object(item)) invalid();
        responseOutput.set(key, item);
        if (item.type === "function_call") {
          if (calls.has(key)) invalid();
          const toolIndex = nextCall(); calls.set(key, { toolIndex, arguments: item.arguments || "", name: item.name, id: item.call_id });
          return [chunk({ tool_calls: [tool(item.call_id, item.name, item.arguments || "", toolIndex)] })];
        }
        return [];
      }
      if (type === "response.output_text.delta" || type === "response.reasoning_summary_text.delta") {
        if (typeof data.delta !== "string") invalid();
        if (type === "response.output_text.delta") responseContent = true; else responseReasoning = true;
        return [chunk({ [type === "response.output_text.delta" ? "content" : "reasoning_content"]: data.delta })];
      }
      if (type === "response.function_call_arguments.delta") {
        const call = calls.get(index(data.output_index));
        if (!call || typeof data.delta !== "string") invalid();
        call.arguments += data.delta;
        const nativeItem = responseOutput.get(data.output_index);
        if (nativeItem) nativeItem.arguments = call.arguments;
        return [chunk({ tool_calls: [{ index: call.toolIndex, function: { arguments: data.delta } }] })];
      }
      if (type === "response.output_item.done") {
        const key = index(data.output_index), item = data.item;
        if (!object(item)) invalid();
        responseOutput.set(key, item);
        if (item.type === "function_call") {
          const call = calls.get(key);
          if (!call) { const toolIndex = nextCall(); calls.set(key, { toolIndex, arguments: item.arguments || "{}", id: item.call_id }); return [chunk({ tool_calls: [tool(item.call_id, item.name, item.arguments || "{}", toolIndex)] })]; }
          if (typeof item.arguments !== "string" || !item.arguments.startsWith(call.arguments)) invalid();
          const rest = item.arguments.slice(call.arguments.length); call.arguments = item.arguments;
          return rest ? [chunk({ tool_calls: [{ index: call.toolIndex, function: { arguments: rest } }] })] : [];
        }
        return [];
      }
      if (type === "response.completed" || type === "response.incomplete") {
        const message = responsesMessage(data.response);
        const events = [];
        // Final-only compatible servers still get normalized without duplicating deltas.
        if (!responseContent && message.content) events.push(chunk({ content: message.content }));
        if (!responseReasoning && message.reasoning_content) events.push(chunk({ reasoning_content: message.reasoning_content }));
        for (const [key, item] of data.response.output.entries()) if (item.type === "function_call") {
          const existing = [...calls.values()].find((call) => call.id === item.call_id);
          if (!existing) {
            const toolIndex = nextCall();
            calls.set(key, { toolIndex, id: item.call_id, arguments: item.arguments || "{}" });
            events.push(chunk({ tool_calls: [tool(item.call_id, item.name, item.arguments || "{}", toolIndex)] }));
          } else {
            if (typeof item.arguments !== "string" || !item.arguments.startsWith(existing.arguments)) invalid();
            const rest = item.arguments.slice(existing.arguments.length);
            if (rest) events.push(chunk({ tool_calls: [{ index: existing.toolIndex, function: { arguments: rest } }] }));
            existing.arguments = item.arguments;
          }
        }
        complete = true;
        events.push(chunk({ provider_metadata: message.provider_metadata }, message.tool_calls?.length ? "tool_calls" : finishReason(data.response.incomplete_details?.reason)));
        return events;
      }
      return [];
    },
  };
}
