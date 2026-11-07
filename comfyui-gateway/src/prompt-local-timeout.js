import { truncate } from "./util.js";

export const DEFAULT_LOCAL_PROMPT_TIMEOUT_SECONDS = 600;
export const MIN_LOCAL_PROMPT_TIMEOUT_SECONDS = 30;
export const MAX_LOCAL_PROMPT_TIMEOUT_SECONDS = 1800;
const CANCEL_TIMEOUT_MS = 10000;

class LocalPromptError extends Error {
  constructor(message, { status = 500, code, details, cause } = {}) {
    super(message, { cause });
    this.name = "LocalPromptError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Match the cloud setting, including multipart strings, without coercing bools,
// arrays, fractions, hex or exponent notation into a valid timeout.
export function normalizeLocalPromptTimeoutSeconds(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_LOCAL_PROMPT_TIMEOUT_SECONDS;
  const seconds = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(seconds) || seconds < MIN_LOCAL_PROMPT_TIMEOUT_SECONDS || seconds > MAX_LOCAL_PROMPT_TIMEOUT_SECONDS) {
    throw new LocalPromptError("本地模型超时必须为 30～1800 秒的整数", { status: 400, code: "local_invalid_timeout" });
  }
  return seconds;
}

function historyCompleted(history) {
  if (!history) return false;
  if (history.status?.completed === true || history.status?.status_str === "success") return true;
  // Output nodes (notably TE_H3_Prompt_Enhancer) can publish intermediate
  // templates before inference finishes. Outputs alone never prove completion.
  return Array.isArray(history.status?.messages)
    && history.status.messages.some((message) => Array.isArray(message) && message[0] === "execution_success");
}

function historyError(history) {
  const messages = Array.isArray(history?.status?.messages) ? history.status.messages : [];
  const terminalErrors = messages.filter((message) => Array.isArray(message)
    && ["execution_error", "execution_interrupted"].includes(message[0]));
  if (history?.status?.status_str !== "error" && !terminalErrors.length) return "";
  return (terminalErrors.length ? terminalErrors : messages).flat()
    .map((item) => typeof item === "string" ? item : item?.message || JSON.stringify(item))
    .filter(Boolean).join("；") || "ComfyUI 执行失败";
}

function createDeadline(timeoutMs, signal, timeoutError) {
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  const timeout = () => controller.abort(timeoutError());
  const cancelled = () => controller.abort(new LocalPromptError("本地提示词请求已取消", { status: 400, code: "cancelled" }));
  const timer = setTimeout(timeout, timeoutMs);
  if (signal?.aborted) cancelled();
  else signal?.addEventListener("abort", cancelled, { once: true });
  const throwIfAborted = () => {
    if (!controller.signal.aborted && Date.now() >= expiresAt) timeout();
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return {
    signal: controller.signal,
    throwIfAborted,
    run(operation) {
      return new Promise((resolve, reject) => {
        try { throwIfAborted(); } catch (error) { reject(error); return; }
        const cleanup = () => controller.signal.removeEventListener("abort", aborted);
        const aborted = () => { cleanup(); reject(controller.signal.reason); };
        controller.signal.addEventListener("abort", aborted, { once: true });
        // Observe both eventual outcomes even if the hard race has already
        // rejected. Check again before starting work after a user cancellation.
        Promise.resolve().then(() => { throwIfAborted(); return operation(); }).then((value) => {
          cleanup();
          try { throwIfAborted(); resolve(value); } catch (error) { reject(error); }
        }, (error) => { cleanup(); reject(controller.signal.aborted ? controller.signal.reason : error); });
      });
    },
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
    },
  };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

// One execution budget covers preflight, submission, history requests and poll
// delays. Cancellation has a separate bounded 10s cleanup allowance: using the
// expired execution signal would prevent the targeted cancellation from sending.
// Cancelling a prompt requests termination; third-party nodes may not immediately
// stop or unload their models. Never globally interrupt/free other users' work.
export async function executeLocalPrompt({ comfy, workflow, timeoutSeconds, signal, preflight, logger }) {
  const timeoutMs = normalizeLocalPromptTimeoutSeconds(timeoutSeconds) * 1000;
  const started = Date.now();
  const deadline = createDeadline(timeoutMs, signal, () => new LocalPromptError("本地提示词执行超时", { status: 504, code: "local_prompt_timeout" }));
  let promptId;
  let submitResult;
  let cancelPromise;
  let finished = false;

  const cancel = () => {
    if (!promptId || finished) return Promise.resolve();
    // Memoize before invoking the client: the abort/submit acknowledgement race
    // and the outer catch must all await the exact same cancellation operation.
    if (!cancelPromise) cancelPromise = Promise.resolve().then(async () => {
      const cleanup = createDeadline(CANCEL_TIMEOUT_MS, undefined, () => new Error("取消请求超过 10 秒仍未完成"));
      try {
        await cleanup.run(() => {
          if (typeof comfy.cancel === "function") return comfy.cancel(promptId, { signal: cleanup.signal });
          if (typeof comfy.interrupt === "function") return comfy.interrupt(promptId, { signal: cleanup.signal });
          throw new Error("ComfyUI 客户端不支持按 promptId 取消");
        });
      } catch (cause) {
        throw new LocalPromptError(`本地提示词取消失败：${truncate(String(cause?.message || cause), 500)}`, {
          status: 502, code: "local_cancel_failed", details: { promptId }, cause,
        });
      } finally {
        cleanup.dispose();
      }
    });
    return cancelPromise;
  };

  try {
    if (preflight) await deadline.run(() => preflight({ signal: deadline.signal }));
    await deadline.run(() => {
      submitResult = Promise.resolve(comfy.submit(workflow, { signal: deadline.signal })).then(async (submitted) => {
        promptId = submitted?.promptId;
        // A client may ignore AbortSignal and acknowledge after the hard race
        // rejected. Keep this continuation alive to cancel only that late ID.
        if (deadline.signal.aborted && promptId) await cancel();
        return submitted;
      });
      return submitResult;
    });
    if (!promptId) throw new LocalPromptError("ComfyUI 未返回 prompt_id", { status: 502, code: "no_prompt_id" });
    for (;;) {
      const history = await deadline.run(() => comfy.history(promptId, { signal: deadline.signal }));
      const failure = historyError(history);
      if (failure) {
        finished = true;
        throw new LocalPromptError(`本地提示词执行失败：${truncate(failure, 1200)}`, {
          status: 502, code: "comfy_execution_failed", details: failure,
        });
      }
      if (historyCompleted(history)) {
        deadline.throwIfAborted();
        finished = true;
        return { history, promptId, elapsedMs: Date.now() - started };
      }
      await deadline.run(() => delay(1000, deadline.signal));
    }
  } catch (error) {
    if (deadline.signal.aborted) {
      const reason = deadline.signal.reason;
      if (promptId) {
        try { await cancel(); } catch (cancelError) {
          cancelError.details.reason = reason.code;
          throw cancelError;
        }
      } else if (submitResult) {
        // The response cannot await an unknowable acknowledgement forever.
        // Expose late cleanup to internal callers; report its failure explicitly
        // because an already-returned timeout cannot be replaced retroactively.
        const cleanup = submitResult.catch((lateError) => {
          if (lateError?.code !== "local_cancel_failed") return;
          const message = `[local_cancel_failed] 迟到的本地提交 ${lateError.details.promptId} 取消失败；未全局中断或确认模型卸载：${lateError.message}`;
          if (typeof logger?.error === "function") logger.error(message);
          else console.error(message);
          throw lateError;
        });
        cleanup.catch(() => {}); // The rejection is logged and remains observable.
        Object.defineProperty(reason, "cleanup", { value: cleanup });
      }
      throw reason;
    }
    // A broken history transport is not proof the submitted task stopped. Do
    // not strand it after returning an error; only explicit terminal histories
    // and successful completion skip targeted cleanup. Never resubmit work.
    if (promptId && !finished) {
      try { await cancel(); } catch (cancelError) {
        cancelError.details.reason = error?.code || error?.name || "local_execution_failed";
        throw cancelError;
      }
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}
