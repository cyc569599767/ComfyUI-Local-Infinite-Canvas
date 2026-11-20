import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import i18n from "@/i18n";
import { useAgentStore } from "@/stores/use-agent-store";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasConnection, CanvasNodeData, ContextMenuState, ViewportTransform } from "@/types/canvas";

type GenerateNodeRef = MutableRefObject<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>;

/** One Agent turn may rewrite a lot of nodes, but a single batch must stay inspectable and undoable. */
export const MAX_AGENT_OPS_PER_APPLY = 48;
/** Generation is expensive and slow: never fan out more than a few renders from one batch. */
export const MAX_AGENT_GENERATIONS_PER_APPLY = 4;

type AgentBridgeParams = {
    projectId: string;
    title: string | undefined;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    viewport: ViewportTransform;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    viewportRef: MutableRefObject<ViewportTransform>;
    generateNodeRef: GenerateNodeRef;
    isGenerationActive?: (nodeId: string) => boolean;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
};

/**
 * Bridge between the canvas and local Agent: publish the current snapshot and apply/undo capabilities
 * to the Agent store for the local Codex panel. All members except applyAgentOps are internal.
 */
export function useAgentBridge(params: AgentBridgeParams) {
    const { projectId, title, nodes, connections, selectedNodeIds, viewport, nodesRef, connectionsRef, selectedNodeIdsRef, viewportRef, generateNodeRef, setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setViewport, setContextMenu } =
        params;
    const setAgentCanvasContext = useAgentStore((state) => state.setCanvasContext);
    const dispatches = useRef(new Set<string>());
    const activeCheck = useRef(params.isGenerationActive);
    activeCheck.current = params.isGenerationActive;
    const isGenerationActive = useCallback((nodeId: string) => dispatches.current.has(`${projectId}:${nodeId}`) || Boolean(activeCheck.current?.(nodeId)), [projectId]);
    const [agentUndoSnapshot, setAgentUndoSnapshot] = useState<CanvasAgentSnapshot | null>(null);
    const projectTitle = title || i18n.t("canvas.project.untitled");

    const agentSnapshot = useMemo<CanvasAgentSnapshot>(() => ({ projectId, title: projectTitle, nodes, connections, selectedNodeIds: Array.from(selectedNodeIds), viewport }), [connections, projectTitle, nodes, projectId, selectedNodeIds, viewport]);
    const applyAgentOps = useCallback(
        (ops?: CanvasAgentOp[]) => {
            const safeOps = Array.isArray(ops) ? ops.filter((op) => op?.type) : [];
            const generationOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation" && Boolean(op.nodeId));
            const mutationCount = safeOps.filter((op) => op.type !== "layout_creation").length;
            if (mutationCount > MAX_AGENT_OPS_PER_APPLY) throw new Error(`一次提交 ${mutationCount} 个画布操作，超过单批上限 ${MAX_AGENT_OPS_PER_APPLY}。请拆成更小的批次后重试。`);
            if (generationOps.length > MAX_AGENT_GENERATIONS_PER_APPLY) throw new Error(`一次触发 ${generationOps.length} 个生成任务，超过单批上限 ${MAX_AGENT_GENERATIONS_PER_APPLY}。请先提交少量镜头，等结果返回后再继续。`);
            const before = { projectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: Array.from(selectedNodeIdsRef.current), viewport: viewportRef.current };
            const next = applyCanvasAgentOps(
                before,
                safeOps.filter((op) => op.type !== "run_generation"),
            );
            if (generationOps.length) {
                if (!generateNodeRef.current) throw new Error("生成入口尚未就绪，未提交任务。");
                const ids = new Set<string>();
                for (const op of generationOps) {
                    if (ids.has(op.nodeId) || isGenerationActive(op.nodeId)) throw new Error("该节点已有活动生成请求，不能重复提交。");
                    if (!next.nodes.some(node => node.id === op.nodeId)) throw new Error(`生成节点不存在：${op.nodeId}`);
                    ids.add(op.nodeId);
                }
            }
            nodesRef.current = next.nodes;
            connectionsRef.current = next.connections;
            selectedNodeIdsRef.current = new Set(next.selectedNodeIds);
            viewportRef.current = next.viewport;
            setAgentUndoSnapshot(before);
            const progressOnly = safeOps.length > 0 && safeOps.every(op => op.type === "update_node" && !op.patch && Object.keys(op.metadata || {}).every(key => key === "agentCreation" || key === "agentCreationProgress"));
            // Progress may arrive in the same React batch as a media callback.
            // Rebase this host-only patch instead of replacing pending media state.
            setNodes(progressOnly ? current => applyCanvasAgentOps({ ...before, nodes: current }, safeOps).nodes : next.nodes);
            setConnections(next.connections);
            setSelectedNodeIds(new Set(next.selectedNodeIds));
            setSelectedConnectionId(null);
            setViewport(next.viewport);
            setContextMenu(null);
            for (const op of generationOps) {
                const key = `${projectId}:${op.nodeId}`;
                dispatches.current.add(key);
                queueMicrotask(async () => {
                    let failure = "";
                    try {
                        const live = useAgentStore.getState().canvasContext;
                        if (!live || live.snapshot.projectId !== projectId) return;
                        const target = nodesRef.current.find(node => node.id === op.nodeId);
                        if (!target) throw new Error("生成节点已移除，未提交任务。");
                        const revision = target.metadata?.creationOutput;
                        if (revision?.revisionKind && (revision.revisionKind !== "candidate" || nodesRef.current.find(n => n.id === revision.projectNodeId)?.metadata?.creationPipeline?.review?.candidateNodeId !== target.id)) throw new Error("候选已变化，未提交生成。");
                        const generate = generateNodeRef.current;
                        if (!generate) throw new Error("生成入口尚未就绪，未提交任务。");
                        const prompt = op.prompt?.trim() ? op.prompt : (target.metadata?.composerContent ?? target.metadata?.prompt ?? "");
                        await generate(op.nodeId, op.mode || target.metadata?.generationMode || "image", prompt);
                    } catch (error) {
                        failure = error instanceof Error ? error.message : "生成入口执行失败。";
                    } finally {
                        dispatches.current.delete(key);
                        if (useAgentStore.getState().canvasContext?.snapshot.projectId === projectId) {
                            setNodes(current => current.map(node => {
                                if (node.id !== op.nodeId || !node.metadata?.creationOutput || activeCheck.current?.(node.id)) return node;
                                if (!failure && ["success", "error"].includes(node.metadata.status || "")) return node;
                                return { ...node, metadata: { ...node.metadata, status: "error", generationStartedAt: undefined, errorDetails: failure || "生成入口已结束，但没有收到媒体结果。请检查配置或错误后再继续，不能继续空等。" } };
                            }));
                        }
                    }
                });
            }
            return { ...next, projectId, title: projectTitle };
        },
        [projectTitle, projectId, isGenerationActive],
    );
    const undoAgentOps = useCallback(() => {
        if (!agentUndoSnapshot) return null;
        if (agentUndoSnapshot.projectId !== projectId) {
            setAgentUndoSnapshot(null);
            return null;
        }
        nodesRef.current = agentUndoSnapshot.nodes;
        connectionsRef.current = agentUndoSnapshot.connections;
        selectedNodeIdsRef.current = new Set(agentUndoSnapshot.selectedNodeIds);
        viewportRef.current = agentUndoSnapshot.viewport;
        setNodes(agentUndoSnapshot.nodes);
        setConnections(agentUndoSnapshot.connections);
        setSelectedNodeIds(new Set(agentUndoSnapshot.selectedNodeIds));
        setSelectedConnectionId(null);
        setViewport(agentUndoSnapshot.viewport);
        setContextMenu(null);
        setAgentUndoSnapshot(null);
        return { ...agentUndoSnapshot, projectId, title: projectTitle };
    }, [agentUndoSnapshot, projectTitle, projectId]);

    useEffect(() => {
        setAgentUndoSnapshot(null);
    }, [projectId]);

    useEffect(() => {
        setAgentCanvasContext({ snapshot: agentSnapshot, applyOps: applyAgentOps, undoOps: undoAgentOps, canUndo: agentUndoSnapshot?.projectId === projectId, isGenerationActive });
        return () => setAgentCanvasContext(null);
    }, [agentSnapshot, applyAgentOps, agentUndoSnapshot, projectId, setAgentCanvasContext, undoAgentOps, isGenerationActive]);

    return { applyAgentOps };
}
