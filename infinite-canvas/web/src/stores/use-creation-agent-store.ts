/** 创作 Agent 的会话、运行态与审批完全独立于画布聊天；只共用模型配置和画布能力。 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { localForageStorage } from "@/lib/localforage-storage";
import { persistChatMessage } from "@/lib/agent-chat-history";
import type { AgentChatMessageItem } from "@/components/agent/agent-chat-message";

export type CreationConversation = {
    id: string;
    projectNodeId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: AgentChatMessageItem[];
    status: "draft" | "running" | "ready" | "error";
    progress: string;
    lastError?: string;
};

export type CreationRunState = {
    conversationId: string;
    projectNodeId: string;
    step: number;
    startedAt: number;
    phase: "executing" | "waiting_media";
    pendingApproval: { summary: string } | null;
};

type CreationAgentStore = {
    conversations: CreationConversation[];
    hydrated: boolean;
    /** 按工作台节点隔离，不能用一个 running 覆盖另一项目。 */
    runs: Record<string, CreationRunState>;
    confirmBeforeApply: boolean;
    setConfirmBeforeApply: (value: boolean) => void;
    setHydrated: (value: boolean) => void;
    conversationFor: (projectNodeId: string) => CreationConversation | null;
    ensureConversation: (projectNodeId: string, title: string) => string;
    appendMessage: (conversationId: string, message: AgentChatMessageItem) => void;
    patchMessage: (conversationId: string, messageId: string, patch: Partial<AgentChatMessageItem>) => void;
    setProgress: (conversationId: string, patch: Pick<CreationConversation, "status" | "progress"> & { lastError?: string }) => void;
    startRun: (conversationId: string, projectNodeId: string) => void;
    bumpStep: (projectNodeId: string) => void;
    setRunPhase: (projectNodeId: string, phase: CreationRunState["phase"]) => void;
    endRun: (projectNodeId: string) => void;
    setPendingApproval: (projectNodeId: string, value: { summary: string } | null) => void;
};

export const useCreationAgentStore = create<CreationAgentStore>()(
    persist(
        (set, get) => ({
            conversations: [],
            hydrated: false,
            runs: {},
            confirmBeforeApply: false,
            setConfirmBeforeApply: (confirmBeforeApply) => set({ confirmBeforeApply }),
            setHydrated: (hydrated) => set({ hydrated }),
            conversationFor: (projectNodeId) => get().conversations.find((item) => item.projectNodeId === projectNodeId) || null,
            ensureConversation: (projectNodeId, title) => {
                const existing = get().conversationFor(projectNodeId);
                if (existing) return existing.id;
                const now = Date.now();
                const conversation: CreationConversation = {
                    id: `creation-${now}-${Math.random().toString(36).slice(2, 9)}`,
                    projectNodeId, title: title.trim().slice(0, 80) || "无限创作",
                    createdAt: now, updatedAt: now, messages: [], status: "draft", progress: "",
                };
                // 不按数量截断：仍在后台执行的项目必须始终能找到自己的会话。
                set((state) => ({ conversations: [conversation, ...state.conversations] }));
                return conversation.id;
            },
            appendMessage: (conversationId, message) => set((state) => ({
                conversations: state.conversations.map((item) => item.id === conversationId
                    ? { ...item, updatedAt: Date.now(), messages: [...item.messages, message] } : item),
            })),
            patchMessage: (conversationId, messageId, patch) => set((state) => ({
                conversations: state.conversations.map((item) => item.id === conversationId
                    ? { ...item, updatedAt: Date.now(), messages: item.messages.map((m) => m.id === messageId ? { ...m, ...patch } : m) } : item),
            })),
            setProgress: (conversationId, patch) => set((state) => ({
                conversations: state.conversations.map((item) => item.id === conversationId ? { ...item, ...patch, updatedAt: Date.now() } : item),
            })),
            startRun: (conversationId, projectNodeId) => set((state) => ({
                runs: { ...state.runs, [projectNodeId]: { conversationId, projectNodeId, step: 0, startedAt: Date.now(), phase: "executing", pendingApproval: null } },
            })),
            bumpStep: (projectNodeId) => set((state) => {
                const run = state.runs[projectNodeId];
                return run ? { runs: { ...state.runs, [projectNodeId]: { ...run, step: run.step + 1 } } } : {};
            }),
            setRunPhase: (projectNodeId, phase) => set(state => {
                const run = state.runs[projectNodeId];
                return run && run.phase !== phase ? { runs: { ...state.runs, [projectNodeId]: { ...run, phase } } } : {};
            }),
            endRun: (projectNodeId) => set((state) => {
                const runs = { ...state.runs };
                delete runs[projectNodeId];
                return { runs };
            }),
            setPendingApproval: (projectNodeId, pendingApproval) => set((state) => {
                const run = state.runs[projectNodeId];
                return run ? { runs: { ...state.runs, [projectNodeId]: { ...run, pendingApproval } } } : {};
            }),
        }),
        {
            name: "infinite-canvas:creation_agent_store",
            storage: createJSONStorage(() => localForageStorage),
            // 执行状态和流式标识不能恢复为真正在跑；刷新后保留历史，允许续跑。
            partialize: (state) => ({
                conversations: state.conversations.map((item) => ({ ...item, messages: item.messages.map(persistChatMessage) })),
                confirmBeforeApply: state.confirmBeforeApply,
            }),
            onRehydrateStorage: () => (state) => state?.setHydrated(true),
        },
    ),
);

export function isProjectRunning(projectNodeId: string) {
    return Boolean(useCreationAgentStore.getState().runs[projectNodeId]);
}
