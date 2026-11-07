import type { CanvasAgentOp, CanvasAgentSnapshot } from "./canvas/canvas-agent-ops";
import { persistChatMessage, type HistoryMessage } from "./agent-chat-history";

export const AGENT_CHAT_RECOVERY_KEY = "infinite-canvas:agent_chat_recovery";

/** Coalesce stream deltas, retaining a bounded save interval even during a long response. */
export function createChatPersistence<T>({ save, delayMs = 350, schedule = setTimeout, cancel = clearTimeout }: {
    save: (id: string, messages: T[]) => void;
    delayMs?: number;
    schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
    cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
    let pending: { id: string; messages: T[] } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
        if (timer !== null) cancel(timer);
        timer = null;
        const next = pending;
        pending = null;
        if (next) save(next.id, next.messages);
    };
    return {
        stage: (id: string, messages: T[]) => {
            if (pending && pending.id !== id) flush();
            pending = { id, messages };
            if (timer === null) timer = schedule(flush, delayMs);
        },
        flush,
    };
}

/** The unload checkpoint is small, synchronous and sanitized like the persisted store. */
export function encodeChatRecoveryCheckpoint<T extends HistoryMessage>(id: string, updatedAt: number, messages: T[]): string {
    const serialized = JSON.stringify({ version: 1, id, updatedAt, messages: messages.map(persistChatMessage) });
    // Recovery is best-effort and must not synchronously serialize/write huge history.
    return serialized.length <= 1024 * 1024 ? serialized : "";
}

export function recoverChatCheckpoint(raw: string | null, conversations: Array<{ id: string; updatedAt: number }>): { id: string; messages: HistoryMessage[] } | null {
    if (!raw) return null;
    try {
        const checkpoint = JSON.parse(raw);
        if (checkpoint?.version !== 1 || typeof checkpoint.id !== "string" || !Number.isFinite(checkpoint.updatedAt) || !Array.isArray(checkpoint.messages)) return null;
        const conversation = conversations.find(item => item.id === checkpoint.id);
        // Do not resurrect a deleted conversation or overwrite a newer saved revision.
        if (!conversation || conversation.updatedAt > checkpoint.updatedAt) return null;
        if (!checkpoint.messages.every((item: HistoryMessage) => item && typeof item.id === "string" && typeof item.text === "string" && ["user", "assistant", "system", "tool", "error"].includes(item.role))) return null;
        return { id: checkpoint.id, messages: checkpoint.messages.map(persistChatMessage) };
    } catch {
        return null;
    }
}

type CanvasToolContext = {
    snapshot: Pick<CanvasAgentSnapshot, "projectId">;
    applyOps: (ops: CanvasAgentOp[]) => CanvasAgentSnapshot;
};

/** Approval belongs to one project, not the callback/snapshot that existed when it opened. */
export async function applyApprovedCanvasOps({ ops, summary, confirmTools, readContext, requestApproval, signal }: {
    ops: CanvasAgentOp[];
    summary: string;
    confirmTools: boolean;
    readContext: () => CanvasToolContext | null;
    requestApproval: (summary: string) => Promise<boolean>;
    signal: AbortSignal;
}): Promise<{ snapshot: CanvasAgentSnapshot } | { error: string }> {
    const context = readContext();
    if (!context) return { error: "当前不在画布页面，请先打开一个画布。" };
    const projectId = context.snapshot.projectId;
    const checkAbort = () => {
        if (signal.aborted) throw new DOMException("Canceled", "AbortError");
    };
    checkAbort();
    if (confirmTools) {
        const approved = await requestApproval(summary);
        checkAbort();
        if (!approved) return { error: "用户拒绝了本次画布操作。" };
    }
    // Navigation can replace the canvas while approval is pending. Never execute on
    // either the old canvas or a different current project, even after acceptance.
    const current = readContext();
    if (!current || current.snapshot.projectId !== projectId) {
        return { error: "画布已切换，本次操作已取消。请在目标画布中重新发起操作。" };
    }
    checkAbort();
    return { snapshot: current.applyOps(ops) };
}
