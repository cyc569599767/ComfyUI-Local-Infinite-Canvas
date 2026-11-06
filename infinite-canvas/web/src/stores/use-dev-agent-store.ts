import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AgentTransport } from "@/lib/agent-cloud-config";

export type DevAgentStatus = "idle" | "checking" | "connected" | "error";

export const PI_AGENT_BASE_URL = "http://127.0.0.1:18800";
export const PI_AGENT_NORMAL_MODEL = "openclaw/canvas-agent";
export const PI_AGENT_DEV_MODEL = "openclaw/canvas-dev";

type DevAgentStore = {
    enabled: boolean;
    transport: AgentTransport;
    localBaseUrl: string;
    setTransport: (transport: AgentTransport) => void;
    setLocalBaseUrl: (localBaseUrl: string) => void;
    status: DevAgentStatus;
    error: string;
    setEnabled: (enabled: boolean) => void;
    setStatus: (status: DevAgentStatus, error?: string) => void;
};

export const useDevAgentStore = create<DevAgentStore>()(
    persist(
        (set) => ({
            enabled: false,
            transport: "cloud",
            localBaseUrl: PI_AGENT_BASE_URL,
            setTransport: (transport) => set({ transport, status: "idle", error: "" }),
            setLocalBaseUrl: (localBaseUrl) => set({ localBaseUrl, status: "idle", error: "" }),
            status: "idle",
            error: "",
            setEnabled: (enabled) => set({ enabled }),
            setStatus: (status, error = "") => set({ status, error }),
        }),
        {
            name: "infinite-canvas:dev_agent_store",
            partialize: (state) => ({ enabled: state.enabled, transport: state.transport, localBaseUrl: state.localBaseUrl }),
        },
    ),
);
