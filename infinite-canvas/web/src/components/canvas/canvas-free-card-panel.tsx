import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { App, Button, InputNumber, Modal, Popover, Select } from "antd";
import { Archive, CopyPlus, ExternalLink, GripVertical, RefreshCw, Settings2, Sparkles, Square, ArrowUp } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasNodeReferenceBar } from "@/components/canvas/canvas-node-reference-bar";
import { PromptOptimizeOptions } from "@/components/canvas/prompt-optimize-options";
import { ImageSettingsPanel, ImageSettingsTheme, OptionPill } from "@/components/image-settings-panel";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { normalizePixelSize } from "@/lib/media-size";
import { requestImagePromptOptimize } from "@/services/api/image";
import { usePromptCapabilities } from "@/hooks/use-prompt-capabilities";
import {
    archiveFreeWorkflow,
    duplicateFreeWorkflow,
    fetchFreeWorkflow,
    fetchFreeWorkflowGraph,
    fetchFreeWorkflowSources,
    freeWorkflowComfyUrl,
    importFreeWorkflow,
    saveFreeWorkflowBindings,
    syncFreeWorkflow,
    type FreeWorkflowGraph,
    type FreeWorkflowPreset,
    type FreeWorkflowSource,
    type FreeWorkflowSummary,
    type FreeWorkflowOutputType,
} from "@/services/api/free-workflow";
import { FreeCardGraphPanel } from "@/components/canvas/free-card-graph-panel";
import { buildFreeCardSnapshot, customKey, mergePinned, mergeTextInputs, pinnedColumnSpan, reorderPinned, savePinnedLayout, splitBySurface, PINNED_GRID_COLUMNS, type PinnedItem } from "@/lib/canvas/free-card-pinned";
import { canvasPopupContainer } from "@/lib/canvas/canvas-popup";
import { CanvasNodeType, isAudioNodeType, type CanvasFreeCardInfo, type CanvasFreeCardOutputType, type CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

type CanvasFreeCardPanelProps = {
    node: CanvasNodeData;
    nodes: CanvasNodeData[];
    connectedNodes: CanvasNodeData[];
    isRunning: boolean;
    onChange: (patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, prompt: string, texts?: Array<{ node: string; input: string; value: string }>, values?: Array<{ node: string; input: string; value: string | number | boolean }>) => void;
    onStop: (nodeId: string) => void;
    onDisconnectReference: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection: (nodeId: string) => void;
};

const RATIO_ORDER = ["1:1", "2:3", "3:2", "4:3", "3:4", "16:9", "9:16", "21:9", "9:21"];
/** 设置弹窗里拖动固定项用的类型，和节点图弹窗的重排互不干扰。 */
const PINNED_REORDER_TYPE = "application/x-free-card-pinned-reorder";

// Reuse one named ComfyUI window for this tab so repeated clicks do not pile
// up editor tabs. Browsers keep the name across reloads of the canvas page.
let comfyEditorWindow: Window | null = null;
let comfyEditorUrl = "";

const FREE_CARD_OUTPUT_LABEL_KEY: Record<CanvasFreeCardOutputType, string> = {
    image: "canvas.freeCard.imageWorkflow",
    video: "canvas.freeCard.videoWorkflow",
    audio: "canvas.freeCard.audioWorkflow",
    other: "canvas.freeCard.otherWorkflow",
};

/** 自由卡片输出类型对应的 i18n key；各处显示类型都走这里，避免漏掉新增类型。 */
export function freeCardOutputLabelKey(outputType: CanvasFreeCardOutputType | FreeWorkflowOutputType | null | undefined): string {
    return (outputType && FREE_CARD_OUTPUT_LABEL_KEY[outputType as CanvasFreeCardOutputType]) || FREE_CARD_OUTPUT_LABEL_KEY.other;
}

export function freeCardInfoFromSummary(summary: FreeWorkflowSummary): CanvasFreeCardInfo {
    return {
        id: summary.id,
        name: summary.name,
        sourceRel: summary.sourceRel,
        sourceFormat: summary.sourceFormat,
        outputType: summary.outputType === "video" ? "video" : summary.outputType === "image" ? "image" : summary.outputType === "audio" ? "audio" : "other",
        prompt: summary.prompt,
        textInputs: summary.textInputs || [],
        imageInputs: summary.imageInputs,
        audioInputs: summary.audioInputs || 0,
        size: summary.size,
        aspectRatio: summary.aspectRatio,
        aspectRatios: summary.aspectRatios,
        count: summary.count,
        hasSeed: summary.hasSeed,
        seed: summary.seed,
        warnings: summary.warnings,
        archived: summary.archived,
    };
}

function pixelSize(size: string | undefined) {
    const match = String(size || "").match(/^(\d+)x(\d+)$/i);
    return match ? `${match[1]}×${match[2]}` : size || "";
}

function settingsSizeLabel(size: string | undefined) {
    const normalized = normalizePixelSize(size);
    if (normalized && normalized !== size) return `${size} → ${pixelSize(normalized)}`;
    return pixelSize(size);
}

export function CanvasFreeCardPanel({ node, nodes, connectedNodes, isRunning, onChange, onGenerate, onStop, onDisconnectReference, onStartReferenceSelection }: CanvasFreeCardPanelProps) {
    const { t } = useTranslation();
    // 下拉和弹层挂到画布变换层里，跟随平移与缩放（和节点里的文字表现一致）。
    const popupContainer = useCallback((trigger: HTMLElement) => canvasPopupContainer(trigger), []);
    const { message } = App.useApp();
    const theme = useCanvasTheme();
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const { engineAvailable } = usePromptCapabilities();
    const info = node.metadata?.freeCard;
    const [sources, setSources] = useState<FreeWorkflowSource[]>([]);
    const [sourcesLoading, setSourcesLoading] = useState(false);
    const [sourcesError, setSourcesError] = useState("");
    const [summary, setSummary] = useState<FreeWorkflowSummary | null>(null);
    const [prompt, setPrompt] = useState(node.metadata?.prompt || "");
    const [textValues, setTextValues] = useState<Record<string, string>>(node.metadata?.freeCardTextValues || {});
    const promptInitRef = useRef("");
    const [importing, setImporting] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [archiving, setArchiving] = useState(false);
    const archiveBusyRef = useRef(false);
    const [savingBindings, setSavingBindings] = useState(false);
    const savingBindingsRef = useRef(false);
    /** 复制成新条目也在转，和归档分开——两个按钮并存，共用一个状态会让对方也转圈。 */
    const [duplicating, setDuplicating] = useState(false);
    const [optimizing, setOptimizing] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [optimizeOptionsOpen, setOptimizeOptionsOpen] = useState(false);
    // 固定配置项：把工作流里某个节点的某个输入拖到卡片上，作为一个可编辑字段。
    // 绑定关系存在卡片条目上（网关落盘），每个节点的取值存在节点 metadata 里，
    // 因为同一张卡片在不同画布节点上往往要给不同的值。
    const [graphOpen, setGraphOpen] = useState(false);
    const [graph, setGraph] = useState<FreeWorkflowGraph | null>(null);
    const [graphLoading, setGraphLoading] = useState(false);
    const [graphError, setGraphError] = useState("");
    const [graphHeight, setGraphHeight] = useState(420);
    const [pinned, setPinned] = useState<PinnedItem[]>([]);
    const [customValues, setCustomValues] = useState<Record<string, string | number | boolean>>(node.metadata?.freeCardValues || {});
    const optimizeEngine = config.promptApiEngine === "cloud" ? "cloud" : "local";
    const optimizeLanguage = config.promptOptimizeLanguage === "en" ? "en" : "zh";
    const optimizeCloudReady = Boolean((config.promptCloudBaseUrl || "").trim() && (config.promptCloudApiKey || "").trim() && (config.promptCloudModel || "").trim());

    useEffect(() => {
        setPrompt(node.metadata?.prompt || "");
    }, [node.id, node.metadata?.prompt]);

    useEffect(() => {
        setTextValues(node.metadata?.freeCardTextValues || {});
    }, [node.id, node.metadata?.freeCardTextValues]);

    useEffect(() => {
        setCustomValues(node.metadata?.freeCardValues || {});
    }, [node.id, node.metadata?.freeCardValues]);

    const loadSources = useCallback(async () => {
        setSourcesLoading(true);
        setSourcesError("");
        try {
            setSources(await fetchFreeWorkflowSources(config));
        } catch (error) {
            setSources([]);
            setSourcesError(error instanceof Error ? error.message : t("canvas.freeCard.sourcesFailed"));
        } finally {
            setSourcesLoading(false);
        }
    }, [config, t]);

    useEffect(() => {
        void loadSources();
    }, [loadSources]);

    // 目录保存/资源刷新后自由工作流源会变化：事件或重新聚焦时补拉一次，不做轮询。
    useEffect(() => {
        let lastLoadedAt = 0;
        const refreshSources = () => {
            const now = Date.now();
            if (now - lastLoadedAt < 1500) return;
            lastLoadedAt = now;
            void loadSources();
        };
        const refreshWhenVisible = () => {
            if (document.visibilityState === "visible") refreshSources();
        };
        window.addEventListener("local-gateway-refresh-models", refreshSources);
        window.addEventListener("local-gateway-refresh-resources", refreshSources);
        window.addEventListener("focus", refreshWhenVisible);
        document.addEventListener("visibilitychange", refreshWhenVisible);
        return () => {
            window.removeEventListener("local-gateway-refresh-models", refreshSources);
            window.removeEventListener("local-gateway-refresh-resources", refreshSources);
            window.removeEventListener("focus", refreshWhenVisible);
            document.removeEventListener("visibilitychange", refreshWhenVisible);
        };
    }, [loadSources]);

    useEffect(() => {
        if (!info?.id) {
            setSummary(null);
            return;
        }
        let canceled = false;
        void fetchFreeWorkflow(config, info.id)
            .then((next) => {
                if (!canceled) setSummary(next);
            })
            .catch(() => {
                if (!canceled) setSummary(null);
            });
        return () => {
            canceled = true;
        };
    }, [config, info?.id]);

    // Existing cards were created before null output types were distinguished
    // from images; reconcile them with the gateway summary after load.
    useEffect(() => {
        if (!summary || !info) return;
        const normalized = summary.outputType === "video" ? "video" : summary.outputType === "image" ? "image" : summary.outputType === "audio" ? "audio" : "other";
        if (info.outputType !== normalized) onChange({ freeCard: { ...info, outputType: normalized } });
    }, [summary, info, onChange]);

    const textInputs = useMemo(() => summary?.textInputs ?? info?.textInputs ?? [], [summary?.textInputs, info?.textInputs]);
    const primaryText = textInputs[0];

    // 新导入/首次打开时，把主文本框填成工作流自带文本；之后保留用户输入。
    useEffect(() => {
        const id = info?.id || "";
        if (!id || !textInputs.length || promptInitRef.current === id) return;
        promptInitRef.current = id;
        if (!node.metadata?.prompt) {
            const initial = textInputs[0]?.default || "";
            if (initial) {
                setPrompt(initial);
                onChange({ prompt: initial, composerContent: initial });
            }
        }
    }, [info?.id, node.metadata?.prompt, onChange, textInputs]);

    const imageConnectedNodes = useMemo(() => connectedNodes.filter((item) => item.type === CanvasNodeType.Image || item.type === CanvasNodeType.Group), [connectedNodes]);
    const imageReferences = useMemo(() => {
        const resources = connectedNodes.flatMap((item) => (item.type === CanvasNodeType.Group ? getGroupResourceNodes(item.id, nodes) : [item]));
        return resources
            .filter((item) => item.type === CanvasNodeType.Image && item.metadata?.content)
            .map((item): ReferenceImage => ({
                id: item.id,
                name: `${item.title || item.id}.png`,
                type: item.metadata?.mimeType || "image/png",
                dataUrl: item.metadata?.content || "",
                storageKey: item.metadata?.storageKey,
            }));
    }, [connectedNodes, nodes]);

    // 参考音频（音色克隆）：连入的音频节点就是参考音色。
    // 缺了它 ComfyUI 会拿工作流里写死的占位文件名做校验并报 "Custom validation failed"，
    // 所以在卡片上明确提示，别让用户跑一趟才发现。
    const audioReferences = useMemo(() => {
        const resources = connectedNodes.flatMap((item) => (item.type === CanvasNodeType.Group ? getGroupResourceNodes(item.id, nodes) : [item]));
        return resources.filter((item) => isAudioNodeType(item.type) && item.metadata?.content);
    }, [connectedNodes, nodes]);

    const sizeText = node.metadata?.size || (info?.size ? `${info.size.width}x${info.size.height}` : "");
    const countValue = node.metadata?.count ?? info?.count ?? 1;
    const seedValue = node.metadata?.seed || info?.seed || "";
    const seedFixed = node.metadata?.seedFixed || "false";
    const ratioOptions = useMemo(() => {
        const available = new Set(info?.aspectRatios || []);
        const ordered = RATIO_ORDER.filter((ratio) => available.has(ratio));
        const extra = [...available].filter((ratio) => !RATIO_ORDER.includes(ratio));
        return [...ordered, ...extra];
    }, [info?.aspectRatios]);
    const ratioValue = node.metadata?.aspectRatio || info?.aspectRatio || ratioOptions[0] || "";
    const sourceMissing = Boolean(summary?.sourceMissing);
    const hasSeedSetting = Boolean(info && (info.hasSeed || info.seed != null));
    // 设置弹窗始终可打开：即使工作流本身没有尺寸/种子，用户仍要从这里点「选择配置」。
    const hasSettings = Boolean(info);
    const settingsSummary = [
        info?.size && sizeText ? settingsSizeLabel(sizeText) : "",
        ratioOptions.length && ratioValue ? ratioValue : "",
        info?.count != null ? t("canvas.freeCard.countSummary", { count: countValue }) : "",
        hasSeedSetting && seedFixed === "true" && seedValue ? t("canvas.freeCard.seedSummary", { seed: seedValue }) : "",
    ]
        .filter(Boolean)
        .join(" · ");
    // 所有自动文本（包括主文本）与手动配置统一布局，主文本的优化功能保留。
    const primaryKey = primaryText ? customKey(primaryText) : "";
    const allPinned = useMemo(
        () => mergeTextInputs(pinned, textInputs, graph, "", summary?.customBindings || []),
        [pinned, textInputs, graph, summary?.customBindings],
    );
    const pinnedBySurface = useMemo(() => splitBySurface(allPinned), [allPinned]);
    const cardPinned = pinnedBySurface.card;
    const settingsPinned = pinnedBySurface.settings;
    const pinnedValues = useMemo(() => {
        const out: Record<string, string | number | boolean> = { ...customValues };
        for (const [index, item] of textInputs.entries()) {
            const key = customKey(item);
            out[key] = index === 0 ? prompt : textValues[`${item.node}:${item.input}`] ?? String(customValues[key] ?? item.default);
        }
        return out;
    }, [customValues, textValues, textInputs, prompt]);
    const buildSnapshot = () => buildFreeCardSnapshot({ pinned: allPinned, textInputs, prompt, textValues, customValues });

    const setCard = (next: FreeWorkflowSummary, { resetSettings = false } = {}) => {
        const card = freeCardInfoFromSummary(next);
        const patch: Partial<CanvasNodeData["metadata"]> = { freeCard: card };
        const current = node.metadata || {};
        if (resetSettings) {
            patch.size = next.size ? `${next.size.width}x${next.size.height}` : undefined;
            patch.aspectRatio = card.aspectRatio || "";
            patch.count = next.count ?? 1;
            patch.seed = next.seed || "";
            patch.seedFixed = current.seedFixed || "false";
            const initialPrompt = next.textInputs?.[0]?.default || "";
            patch.prompt = initialPrompt;
            patch.composerContent = initialPrompt;
            patch.freeCardTextValues = {};
        } else {
            if (!current.size && next.size) patch.size = `${next.size.width}x${next.size.height}`;
            if (!current.aspectRatio && card.aspectRatio) patch.aspectRatio = card.aspectRatio;
            if (current.count == null && next.count != null) patch.count = next.count;
            if (!current.seed && next.seed) patch.seed = next.seed;
        }
        onChange(patch);
        setSummary(next);
    };

    const selectSource = async (relative: string) => {
        if (!relative) return;
        setImporting(true);
        try {
            const next = await importFreeWorkflow(config, relative);
            setCard(next, { resetSettings: true });
            message.success(t("canvas.freeCard.imported"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.freeCard.importFailed"));
        } finally {
            setImporting(false);
        }
    };

    /**
     * 拉取节点图 + 已固定的配置项。
     *
     * 面板一打开就要拉：固定的项要直接显示成可编辑控件，不能等用户点开节点图才出现。
     * graph 同时供节点图弹窗使用，一次请求两边共享。
     */
    const loadGraph = useCallback(async () => {
        const id = info?.id;
        if (!id) {
            setGraph(null);
            setPinned([]);
            return;
        }
        setGraphLoading(true);
        setGraphError("");
        try {
            const result = await fetchFreeWorkflowGraph(config, id);
            setGraph(result.graph);
            setPinned(mergePinned(result.customBindings, result.graph));
        } catch (error) {
            setGraphError(error instanceof Error ? error.message : t("canvas.freeCard.graphLoadFailed"));
        } finally {
            setGraphLoading(false);
        }
    }, [config, info?.id, t]);

    // 卡片或来源变化时重新拉：固定项属于卡片条目，换一张卡就得换一份列表。
    useEffect(() => {
        void loadGraph();
    }, [loadGraph]);

    const openGraph = () => {
        setGraphOpen(true);
        // 已加载过就不重复请求；失败过则重试，否则用户只能关掉重开面板。
        if (!graph || graphError) void loadGraph();
    };

    /** 保存固定列表到条目。网关会丢掉无效项，回写的结果才是真相。 */
    // 只关心「哪几项、什么顺序、放哪儿」，不要求调用方提供 kind/options 这些渲染辅助字段。
    // 乐观更新时把这些字段按 key 从现有列表补回来，避免卡片上的控件短暂塌成文本框。
    const commitPinned = async (next: Array<Pick<PinnedItem, "node" | "input" | "label" | "surface">>) => {
        if (!info?.id || savingBindingsRef.current || archiveBusyRef.current) return;
        savingBindingsRef.current = true;
        setSavingBindings(true);
        const known = new Map(allPinned.map((item) => [customKey(item), item]));
        const optimistic = next.map((item) => ({
            kind: "text" as const, options: [], integer: false, value: "",
            ...known.get(customKey(item)), ...item,
        }));
        const bindings = savePinnedLayout(next, allPinned, summary?.customBindings || []);
        setPinned(optimistic);
        setSummary((current) => current ? { ...current, customBindings: bindings } : current);
        try {
            const updated = await saveFreeWorkflowBindings(
                config,
                info.id,
                // 含自动文本的取消固定标记，重载时不能再自动追加。
                bindings,
            );
            const effective = mergePinned(updated.customBindings || [], graph);
            setPinned(effective);
            setSummary(updated);
            onChange({ freeCard: freeCardInfoFromSummary(updated) });
            // 侧栏的卡片列表存着各条目的 summary 快照，从库里再拖一张卡片就按它建节点。
            // 不通知它，用户保存完配置后拖出来的新卡片带的还是旧配置。
            window.dispatchEvent(new Event("local-gateway-free-cards-changed"));
        } catch (error) {
            setSummary(summary);
            message.error(error instanceof Error ? error.message : t("canvas.freeCard.pinnedSaveFailed"));
            void loadGraph();
        } finally {
            savingBindingsRef.current = false;
            setSavingBindings(false);
        }
    };

    /**
     * 改一个固定项的值。
     *
     * 文本输入和普通配置项走不同的存储：前者是 texts 通道（也用于主提示词联动），
     * 后者是 values 通道。混着存会让执行时发错字段，所以这里按 item.text 分流。
     */
    const commitCustomValue = (item: PinnedItem, value: string | number | boolean) => {
        if (item.text) {
            const key = `${item.node}:${item.input}`;
            const text = String(value ?? "");
            const next = { ...textValues, [key]: text };
            setTextValues(next);
            if (customKey(item) === primaryKey) {
                setPrompt(text);
                onChange({ prompt: text, composerContent: text, freeCardTextValues: next });
            } else {
                onChange({ freeCardTextValues: next });
            }
            return;
        }
        const key = customKey(item);
        const next = { ...customValues, [key]: value };
        setCustomValues(next);
        onChange({ freeCardValues: next });
    };

    /**
     * 重排固定项。
     *
     * 基于合并后的列表（含文本输入）算新顺序，再把完整顺序写进 customBindings——
     * 只写手动固定项的话，文本输入的位置改动会随刷新丢掉。
     */
    const reorderPinnedByKey = (fromKey: string, toKey: string, placement: "before" | "after") => {
        const next = reorderPinned(allPinned, fromKey, toKey, placement);
        if (next === allPinned) return;
        void commitPinned(next.map(({ node, input, label, surface }) => ({ node, input, label, surface })));
    };

    /** 手动同步源工作流；它与保存当前参数的“更新归档”是两个不同操作。 */
    const syncCard = async ({ silent = false }: { silent?: boolean } = {}): Promise<FreeWorkflowSummary | null> => {
        if (!info?.id) return null;
        setSyncing(true);
        try {
            const result = await syncFreeWorkflow(config, info.id);
            setCard(result.workflow);
            await loadGraph();
            // 同步会重新扫描工作流，输入/输出结构可能变了；侧栏列表也要跟着更新。
            if (result.changed) window.dispatchEvent(new Event("local-gateway-free-cards-changed"));
            if (!silent) message.success(result.changed ? t("canvas.freeCard.synced") : t("canvas.freeCard.noChange"));
            return result.workflow;
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.freeCard.saveFailed"));
            return null;
        } finally {
            setSyncing(false);
        }
    };

    /**
     * 归档 / 重新归档。
     *
     * 已归档时不禁用而是继续可点：归档保存的是「当前参数快照」，用户改了尺寸、种子之后
     * 需要能再存一次覆盖旧快照。以前这里直接 return 并禁用按钮，表现是「点了没反应」，
     * 而按钮上又写着「归档」，看起来像坏了。
     */
    const archiveCard = async ({ silent = false, snapshot = buildSnapshot() } = {}): Promise<FreeWorkflowSummary | null> => {
        if (!info?.id || archiveBusyRef.current || savingBindingsRef.current || graphLoading || graphError || syncing) return null;
        archiveBusyRef.current = true;
        const preset: FreeWorkflowPreset = {
            size: info.size ? normalizePixelSize(sizeText) || undefined : undefined,
            aspectRatio: ratioOptions.length ? ratioValue || undefined : undefined,
            count: info.count != null ? countValue : undefined,
            seed: hasSeedSetting ? seedValue || undefined : undefined,
            seedFixed,
        };
        setArchiving(true);
        try {
            const next = await archiveFreeWorkflow(config, info.id, true, preset, snapshot);
            setCard(next);
            window.dispatchEvent(new Event("local-gateway-free-cards-changed"));
            if (!silent) message.success(t(info.archived ? "canvas.freeCard.cardRearchived" : "canvas.freeCard.cardArchived"));
            return next;
        } catch (error) {
            message.error(silent ? t("canvas.freeCard.syncBeforeGenerateFailed") : error instanceof Error ? error.message : t("canvas.freeCard.saveFailed"));
            return null;
        } finally {
            archiveBusyRef.current = false;
            setArchiving(false);
        }
    };

    /**
     * 新增归档：把当前卡片另存成一条新条目。
     *
     * 和「更新归档」互补——那个覆盖原条目，这个保留原条目、生成一条带当前参数的副本。
     * 卡片键跟着换成副本：用户刚点完「新增」，视线自然期待自己正在看这条新的，
     * 而原卡片仍留在库里，随时可以再选回来。
     */
    const duplicateCard = async () => {
        if (!info?.id || archiveBusyRef.current || savingBindingsRef.current || duplicating || graphLoading || graphError || syncing) return;
        const preset: FreeWorkflowPreset = {
            size: info.size ? normalizePixelSize(sizeText) || undefined : undefined,
            aspectRatio: ratioOptions.length ? ratioValue || undefined : undefined,
            count: info.count != null ? countValue : undefined,
            seed: hasSeedSetting ? seedValue || undefined : undefined,
            seedFixed,
        };
        setDuplicating(true);
        try {
            // 提示词和固定项取值一起带上，新卡片打开时才是用户此刻看到的参数。
            const copy = await duplicateFreeWorkflow(config, info.id, preset, buildSnapshot());
            setCard(copy);
            // 侧栏的归档列表是懒加载的，不通知就会一直显示旧的。
            window.dispatchEvent(new Event("local-gateway-free-cards-changed"));
            message.success(t("canvas.freeCard.cardDuplicated", { name: copy.name }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.freeCard.saveFailed"));
        } finally {
            setDuplicating(false);
        }
    };

    const openComfyUI = async () => {
        if (!info?.id) return;
        try {
            const target = await freeWorkflowComfyUrl(config, info.id);
            if (comfyEditorWindow && !comfyEditorWindow.closed) {
                if (comfyEditorUrl !== target.url) {
                    comfyEditorWindow.location.href = target.url;
                    comfyEditorUrl = target.url;
                }
                comfyEditorWindow.focus();
            } else {
                const nextWindow = window.open(target.url, "infinite-canvas-comfyui");
                if (!nextWindow) {
                    message.warning(t("canvas.freeCard.openBlocked"));
                    return;
                }
                comfyEditorWindow = nextWindow;
                comfyEditorUrl = target.url;
                nextWindow.focus();
            }
            if (target.bridge) message.info(t("canvas.freeCard.openHint", { name: target.name || info.name }));
            else message.warning(t("canvas.freeCard.openBridgeMissing", { name: target.name || info.name, reason: target.bridgeReason || "" }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.freeCard.saveFailed"));
        }
    };

    const optimizePrompt = async () => {
        const text = prompt.trim();
        if (!text) {
            message.warning(t("canvas.freeCard.needPrompt"));
            return;
        }
        setOptimizeOptionsOpen(false);
        const useCloud = optimizeEngine === "cloud";
        const references = info && info.imageInputs > 0 ? imageReferences.slice(0, info.imageInputs) : [];
        setOptimizing(true);
        try {
            const result = await requestImagePromptOptimize(config, {
                prompt: text,
                mode: references.length ? "image" : "text",
                language: optimizeLanguage,
                images: useCloud ? [] : references,
                imageCount: references.length,
                engine: optimizeEngine,
                cloud: useCloud
                    ? {
                          baseUrl: (config.promptCloudBaseUrl || "").trim(),
                          apiKey: (config.promptCloudApiKey || "").trim(),
                          model: (config.promptCloudModel || "").trim(),
                      }
                    : undefined,
            });
            setPrompt(result.prompt);
            onChange({ prompt: result.prompt, composerContent: result.prompt });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.freeCard.saveFailed"));
        } finally {
            setOptimizing(false);
        }
    };

    const commitPrompt = () => {
        if (prompt !== (node.metadata?.prompt || "")) onChange({ prompt, composerContent: prompt });
    };

    const generate = async () => {
        if (!info) {
            message.warning(t("canvas.freeCard.selectFirst"));
            return;
        }
        if (info.outputType === "other") {
            message.warning(t("canvas.freeCard.otherWorkflowHint"));
            return;
        }
        if (syncing || isRunning || archiveBusyRef.current || savingBindingsRef.current) return;
        if (info.prompt && !prompt.trim()) {
            message.warning(t("canvas.freeCard.needPrompt"));
            return;
        }
        // 捕获当前编辑值；归档成功后提交完全相同的快照，不依赖异步 setState。
        // 不强制同步源文件，避免覆盖当前参数，也允许导入包/源文件缺失的快照继续生成。
        const snapshot = buildSnapshot();
        const fresh = await archiveCard({ silent: true, snapshot });
        if (!fresh) return;
        onChange({
            prompt, composerContent: prompt,
            freeCardTextValues: Object.fromEntries(snapshot.texts.map((item) => [`${item.node}:${item.input}`, item.value])),
            freeCardValues: customValues,
        });
        onGenerate(node.id, prompt.trim(), snapshot.texts.length ? snapshot.texts : undefined, snapshot.values.length ? snapshot.values : undefined);
    };

    const promptAction = (item: PinnedItem) => customKey(item) === primaryKey ? (
        <Button size="small" type="text" icon={<Sparkles className="size-3.5" />} loading={optimizing} onClick={() => setOptimizeOptionsOpen((open) => !open)}>
            {optimizing ? t("canvas.freeCard.optimizing") : t("canvas.freeCard.optimize")}
        </Button>
    ) : null;

    const sourceOptions = useMemo(
        () =>
            sources.map((source) => ({
                value: source.relative,
                label: `${source.name}${source.folder ? ` · ${source.folder}` : ""}${source.format === "ui" ? " · UI" : source.format === "api" ? " · API" : ` · ${t("canvas.freeCard.unavailable")}`}`,
                disabled: source.format === "invalid",
            })),
        [sources, t],
    );

    const settingsConfig = {
        ...config,
        size: sizeText || "auto",
        count: String(countValue),
        seed: seedValue,
        seedFixed,
    };
    const warnings = [...(info?.warnings || []), ...(summary?.warnings || [])].filter((item, index, list) => list.indexOf(item) === index);
    const ratioBlock = ratioOptions.length ? (
        <div className="space-y-2">
            <div className="text-xs font-medium" style={{ color: theme.node.muted }}>
                {t("canvas.freeCard.aspectRatio")}
            </div>
            <div className="grid grid-cols-4 gap-2">
                {ratioOptions.map((ratio) => (
                    <OptionPill key={ratio} selected={ratioValue === ratio} theme={theme} onClick={() => onChange({ aspectRatio: ratio })}>
                        {ratio}
                    </OptionPill>
                ))}
            </div>
            <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                {t("canvas.freeCard.aspectRatioHint")}
            </div>
        </div>
    ) : null;

    return (
        <ImageSettingsTheme theme={theme}>
            <div
                className="thin-scrollbar min-h-0 max-h-full w-[540px] space-y-3 overflow-y-auto rounded-2xl border px-4 py-4 shadow-[0_18px_50px_rgba(28,25,23,.18)]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <div className="flex items-center gap-2">
                    <Sparkles className="size-4" style={{ color: theme.node.text }} />
                    <span className="text-sm font-semibold">{t("canvas.freeCard.title")}</span>
                    <span className="min-w-0 truncate text-xs" style={{ color: theme.node.muted }}>
                        {info?.name || t("canvas.freeCard.emptyTitle")}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    <Select
                        className="min-w-0 flex-1"
                        showSearch
                        optionFilterProp="label"
                        value={info?.sourceRel}
                        placeholder={t("canvas.freeCard.selectWorkflow")}
                        options={sourceOptions}
                        loading={sourcesLoading || importing}
                        disabled={archiving || syncing || duplicating || isRunning || savingBindings}
                        onChange={(value) => void selectSource(value)}
                        getPopupContainer={popupContainer}
                        notFoundContent={sourcesLoading ? t("canvas.freeCard.loadingSources") : sourcesError || t("canvas.freeCard.sourcesEmpty")}
                    />
                    <Button size="small" icon={<RefreshCw className={`size-3.5 ${sourcesLoading ? "animate-spin" : ""}`} />} title={t("canvas.freeCard.refreshSources")} disabled={importing} onClick={() => void loadSources()} />
                    {info ? (
                        <Button size="small" icon={<RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />} disabled={syncing || archiving || duplicating || savingBindings || isRunning || sourceMissing} title={sourceMissing ? t("canvas.freeCard.sourceMissing") : undefined} onClick={() => void syncCard()}>
                            {syncing ? t("canvas.freeCard.syncing") : t("canvas.freeCard.sync")}
                        </Button>
                    ) : null}
                </div>
                <div className="text-[11px]" style={{ color: sourcesError ? "#f87171" : theme.node.muted }}>
                    {sourcesError || t("canvas.freeCard.sourceHint")}
                </div>

                {info ? (
                    <>
                        <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: theme.node.muted }}>
                            <span>{t(freeCardOutputLabelKey(info.outputType))}</span>
                            <span>·</span>
                            <span>{info.sourceFormat.toUpperCase()}</span>
                            {info.archived ? <span>· {t("canvas.freeCard.archived")}</span> : null}
                            {sourceMissing ? <span className="text-red-400">· {t("canvas.freeCard.sourceMissing")}</span> : summary?.sourceChanged ? <span className="text-amber-500">· {t("canvas.freeCard.sourceChanged")}</span> : null}
                        </div>
                        {sourceMissing ? (
                            <div className="rounded-lg px-2.5 py-2 text-[11px] leading-5" style={{ background: theme.node.fill, color: "#f87171" }}>
                                {t("canvas.freeCard.sourceMissingHint")}
                            </div>
                        ) : null}

                        {graphError ? (
                            <div className="flex items-center gap-2 text-xs text-red-500">
                                <span>{graphError}</span>
                                <Button size="small" onClick={() => void loadGraph()}>{t("canvas.freeCard.refreshSources")}</Button>
                            </div>
                        ) : null}
                        {/* 固定配置项：从工作流图里挑出来的参数，直接在这里编辑。
                            「选择配置」入口在下方设置弹窗里——卡片上只留控件本身。 */}
                        {cardPinned.length ? (
                            <div className="space-y-2">
                                <PinnedFields items={cardPinned} values={pinnedValues} onChangeValue={commitCustomValue} theme={theme} popupContainer={popupContainer} onReorder={savingBindings ? undefined : reorderPinnedByKey} renderAction={promptAction} />
                            </div>
                        ) : null}

                        {info.prompt && !textInputs.length ? (
                            <textarea
                                className="min-h-20 w-full resize-y rounded-xl border bg-transparent px-3 py-2 text-sm outline-none"
                                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                value={prompt}
                                placeholder={t("canvas.freeCard.promptPlaceholder")}
                                onChange={(event) => setPrompt(event.target.value)}
                                onBlur={commitPrompt}
                            />
                        ) : null}
                        {optimizeOptionsOpen ? (
                                    <PromptOptimizeOptions
                                        className="mt-2"
                                        title={t("canvas.promptPanel.optimizeImageTitle")}
                                        engine={optimizeEngine}
                                        language={optimizeLanguage}
                                        cloudReady={optimizeCloudReady}
                                        cloudModel={config.promptCloudModel}
                                        localReady={engineAvailable("imagePe")}
                                        disabled={optimizing}
                                        onEngineChange={(engine) => updateConfig("promptApiEngine", engine)}
                                        onLanguageChange={(language) => updateConfig("promptOptimizeLanguage", language)}
                                        onOpenSettings={() => openConfigDialog(true, "cloud-api")}
                                        onOpenLocalSettings={() => openConfigDialog(false, "resources")}
                                        onStart={() => void optimizePrompt()}
                                        onClose={() => setOptimizeOptionsOpen(false)}
                                    />
                        ) : null}

                        {info.imageInputs > 0 ? (
                            <div>
                                <div className="mb-1 flex items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                                    <span>{t("canvas.freeCard.imageInputs")}</span>
                                    <span>
                                        {imageReferences.length}/{info.imageInputs}
                                    </span>
                                </div>
                                <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={imageConnectedNodes} onDisconnect={onDisconnectReference} onStartSelection={onStartReferenceSelection} />
                            </div>
                        ) : null}

                        {(info.audioInputs || 0) > 0 ? (
                            <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: audioReferences.length ? theme.node.muted : "#f59e0b" }}>
                                <span>{t("canvas.freeCard.audioInputs")}</span>
                                <span>
                                    {audioReferences.length}/{info.audioInputs}
                                </span>
                                {audioReferences.length ? null : <span>· {t("canvas.freeCard.audioInputsHint")}</span>}
                            </div>
                        ) : null}

                        {warnings.length ? (
                            <div className="rounded-lg px-2.5 py-2 text-[11px] leading-5" style={{ background: theme.node.fill, color: theme.node.muted }}>
                                <div className="mb-0.5 font-medium">{t("canvas.freeCard.warnings")}</div>
                                {warnings.slice(0, 3).map((warning) => (
                                    <div key={warning}>· {warning}</div>
                                ))}
                            </div>
                        ) : null}

                        {/* 工具按钮单独占一行并允许换行，生成按钮独占下面一行。
                            五个按钮挤在一行时，窄面板下会把左侧参数摘要完全挤出可见区。 */}
                        <div className="space-y-2 pt-1">
                            <div className="flex flex-wrap items-center gap-2">
                                {hasSettings ? (
                                    <Popover
                                        trigger="click"
                                        open={settingsOpen}
                                        onOpenChange={setSettingsOpen}
                                        placement="topLeft"
                                        // 挂到画布变换层：拖动/缩放画布时设置窗口跟着卡片走。
                                        getPopupContainer={popupContainer}
                                        content={
                                            // 限高 + 内部滚动：面板本身就在屏幕下半部，内容一多弹窗会顶出视口，
                                            // 最上面的固定项就点不到了。弹窗挂在画布变换层里，会被再乘一次
                                            // 画布缩放，所以 70vh 要乘 --canvas-inverse-scale 才是屏幕上的 70vh；
                                            // 不折算的话放大到 1.8 倍后弹窗高 1000px 以上，顶部直接被切掉。
                                            //
                                            // 弹窗要明显地浮在面板之上：两者底色原本是同一个半透明值，看起来会连成
                                            // 一片，分不清哪块是弹窗。这里改用不透明底色 + 边框 + 更重的投影，
                                            // 让它有明确边界。不透明也顺带解决了面板文字透过弹窗的观感问题。
                                            <div
                                                className="space-y-4 overflow-y-auto rounded-xl border px-3 py-3 shadow-[0_20px_60px_rgba(0,0,0,.45)]"
                                                style={{
                                                    maxHeight: `min(calc(560px * var(--canvas-inverse-scale, 1)), calc(70vh * var(--canvas-inverse-scale, 1)))`,
                                                    background: theme.node.panel,
                                                    borderColor: theme.toolbar.border,
                                                }}
                                                onPointerDown={(event) => event.stopPropagation()}
                                                onMouseDown={(event) => event.stopPropagation()}
                                            >
                                                {ratioBlock}
                                                {/* 固定项里选了「生成设置」的那些，收在这里，避免卡片越铺越长。
                                                    两列栅格 + 可拖拽：窄控件能并排，拖手柄可换位置。 */}
                                                {settingsPinned.length ? (
                                                    <div className="space-y-2">
                                                        <div className="flex items-center justify-between gap-2">
                                                            <span className="text-xs font-medium" style={{ color: theme.node.muted }}>
                                                                {t("canvas.freeCard.settingsPinned")}
                                                            </span>
                                                            {settingsPinned.length > 1 ? <span className="text-[10px] opacity-50">{t("canvas.freeCard.pinnedReorderHint")}</span> : null}
                                                        </div>
                                                        <PinnedFields
                                                            items={settingsPinned}
                                                            values={pinnedValues}
                                                            onChangeValue={commitCustomValue}
                                                            theme={theme}
                                                            popupContainer={popupContainer}
                                                            compact
                                                            columns={PINNED_GRID_COLUMNS}
                                                            onReorder={savingBindings ? undefined : reorderPinnedByKey}
                                                            renderAction={promptAction}
                                                        />
                                                    </div>
                                                ) : null}
                                                <ImageSettingsPanel
                                                    config={settingsConfig}
                                                    onConfigChange={(key, value) => {
                                                        if (key === "count") onChange({ count: Number(value) || 1 });
                                                        else if (key === "seed") onChange({ seed: value });
                                                        else if (key === "seedFixed") onChange({ seedFixed: value });
                                                        else if (key === "size") onChange({ size: value });
                                                    }}
                                                    theme={theme}
                                                    showTitle={false}
                                                    showSize={Boolean(info.size)}
                                                    showTransparent={false}
                                                    showCount={info.count != null}
                                                    showSeed={hasSeedSetting}
                                                    className="w-[320px] space-y-4"
                                                />
                                                {/* 选择配置的入口放在弹窗最下方：卡片上不再占一行按钮。 */}
                                                <div className="flex items-center justify-between gap-2 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                                                    <span className="text-[11px]" style={{ color: theme.node.muted }}>
                                                        {allPinned.length ? t("canvas.freeCard.pinnedCount", { count: allPinned.length }) : t("canvas.freeCard.pinnedEmptyShort")}
                                                    </span>
                                                    <Button size="small" icon={<GripVertical className="size-3.5" />} disabled={archiving || savingBindings} onClick={openGraph}>
                                                        {t("canvas.freeCard.pinnedOpen")}
                                                    </Button>
                                                </div>
                                            </div>
                                        }
                                    >
                                        <Button
                                            size="small"
                                            icon={<Settings2 className="size-3.5" />}
                                            title={settingsSummary ? `${t("canvas.freeCard.settings")} · ${settingsSummary}` : undefined}
                                        >
                                            {/* 设置项全空但里面有固定项时，按钮上要能看出来——否则像个空按钮。 */}
                                            {settingsSummary || `${t("canvas.freeCard.settings")}${settingsPinned.length ? ` · ${settingsPinned.length}` : ""}`}
                                        </Button>
                                    </Popover>
                                ) : null}
                                <Button size="small" icon={<ExternalLink className="size-3.5" />} disabled={isRunning || sourceMissing} title={sourceMissing ? t("canvas.freeCard.sourceMissing") : undefined} onClick={() => void openComfyUI()}>
                                    {t("canvas.freeCard.openInComfy")}
                                </Button>
                                <Button
                                    size="small"
                                    icon={<Archive className="size-3.5" />}
                                    loading={archiving}
                                    // 已归档仍可点：再存一次会覆盖旧快照，等于「更新归档」。
                                    disabled={isRunning || syncing || savingBindings || archiving || duplicating || graphLoading || Boolean(graphError)}
                                    title={info.archived ? t("canvas.freeCard.archiveUpdateHint") : undefined}
                                    onClick={() => void archiveCard()}
                                >
                                    {info.archived ? t("canvas.freeCard.archiveUpdate") : t("canvas.freeCard.archive")}
                                </Button>
                                {/* 另存一条新条目：原卡片不动，适合「同一工作流存两套参数」。 */}
                                <Button
                                    size="small"
                                    icon={<CopyPlus className="size-3.5" />}
                                    loading={duplicating}
                                    disabled={isRunning || syncing || savingBindings || archiving || duplicating || graphLoading || Boolean(graphError)}
                                    title={t("canvas.freeCard.archiveNewHint")}
                                    onClick={() => void duplicateCard()}
                                >
                                    {t("canvas.freeCard.archiveNew")}
                                </Button>
                            </div>
                            {isRunning ? (
                                <Button danger block icon={<Square className="size-3.5" />} onClick={() => onStop(node.id)}>
                                    {t("canvas.freeCard.stop")}
                                </Button>
                            ) : (
                                <Button type="primary" block icon={<ArrowUp className="size-3.5" />} loading={archiving} disabled={info.outputType === "other" || syncing || savingBindings || duplicating || graphLoading || Boolean(graphError)} title={info.outputType === "other" ? t("canvas.freeCard.otherWorkflowHint") : undefined} onClick={() => void generate()}>
                                    {t("canvas.freeCard.generate")}
                                </Button>
                            )}
                        </div>
                    </>
                ) : null}
            </div>
            {/* 节点图放在 Modal 里：面板只有 540px，铺不开一张能拖拽的图。 */}
            <Modal
                title={t("canvas.freeCard.graphTitle")}
                open={graphOpen}
                onCancel={() => setGraphOpen(false)}
                footer={null}
                width={1040}
                destroyOnHidden
                // 高度跟着图走：图只有两三列时写死高度会留一大片空白。
                styles={{ body: { height: graphHeight, display: "flex", flexDirection: "column" } }}
            >
                <div className="mb-2 text-[11px] opacity-55">{t("canvas.freeCard.graphHint")}</div>
                <FreeCardGraphPanel graph={graph} loading={graphLoading || savingBindings} error={graphError} pinned={allPinned} onPinnedChange={(next) => void commitPinned(next)} onContentHeight={setGraphHeight} />
            </Modal>
        </ImageSettingsTheme>
    );
}

/**
 * 固定配置项的编辑控件。
 *
 * 卡片上和「生成设置」里都要渲染同一批控件，所以抽出来复用——复制两份的话，
 * 以后改一个控件（比如数字的精度处理）必然漏掉另一份，同一个参数在两处表现不一样。
 */
function PinnedFields({
    items,
    values,
    onChangeValue,
    theme,
    popupContainer,
    compact = false,
    columns = 1,
    onReorder,
    renderAction,
}: {
    items: PinnedItem[];
    values: Record<string, string | number | boolean>;
    onChangeValue: (item: PinnedItem, value: string | number | boolean) => void;
    theme: ReturnType<typeof useCanvasTheme>;
    /** 下拉挂到画布变换层，才能跟着画布平移。 */
    popupContainer?: (trigger: HTMLElement) => HTMLElement;
    /** 弹层里宽度有限，文本域矮一点。 */
    compact?: boolean;
    /** 一行排几列。1 = 每项独占一行（卡片上保持原样），2 = 窄控件并排。 */
    columns?: number;
    /** 传入即启用拖拽排序（弹窗里用）。参数是被拖项和目标项的 key。 */
    onReorder?: (fromKey: string, toKey: string, placement: "before" | "after") => void;
    renderAction?: (item: PinnedItem) => ReactNode;
}) {
    const { t } = useTranslation();
    const [draggingKey, setDraggingKey] = useState<string | null>(null);
    const [dropTarget, setDropTarget] = useState<{ key: string; placement: "before" | "after" } | null>(null);
    return (
        <div className={columns > 1 ? "grid gap-2" : "space-y-2"} style={columns > 1 ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
            {items.map((item) => {
                const key = customKey(item);
                const value = key in values ? values[key] : item.value;
                // 文本类占满整行：半宽的文本框连一行提示词都看不全。
                const span = columns > 1 ? pinnedColumnSpan(item) : 1;
                const draggable = Boolean(onReorder);
                const dropIndicator = dropTarget?.key === key && draggingKey !== key ? dropTarget.placement : null;
                return (
                    <div
                        key={key}
                        onDragOver={(event) => {
                            // types 在部分浏览器是 DOMStringList，没有 includes，必须先转成数组。
                            if (!onReorder || !Array.from(event.dataTransfer.types).includes(PINNED_REORDER_TYPE)) return;
                            event.preventDefault();
                            event.stopPropagation();
                            const bounds = event.currentTarget.getBoundingClientRect();
                            setDropTarget({ key, placement: event.clientY > bounds.top + bounds.height / 2 ? "after" : "before" });
                        }}
                        onDragLeave={() => setDropTarget((current) => (current?.key === key ? null : current))}
                        onDrop={(event) => {
                            if (!onReorder) return;
                            const fromKey = event.dataTransfer.getData(PINNED_REORDER_TYPE);
                            if (!fromKey) return;
                            event.preventDefault();
                            event.stopPropagation();
                            const bounds = event.currentTarget.getBoundingClientRect();
                            onReorder(fromKey, key, event.clientY > bounds.top + bounds.height / 2 ? "after" : "before");
                            setDraggingKey(null);
                            setDropTarget(null);
                        }}
                        className={`min-w-0 space-y-1 rounded-lg transition ${draggable ? "p-1" : ""} ${draggingKey === key ? "opacity-40" : ""} ${dropIndicator ? "bg-sky-500/10" : ""}`}
                        // 插入位置用内阴影标出，不用 border：加边框会让行高跳一下，鼠标就抖出去了。
                        style={{
                            ...(span > 1 ? { gridColumn: `span ${span}` } : {}),
                            boxShadow: dropIndicator ? `inset 0 ${dropIndicator === "after" ? "-2px" : "2px"} 0 0 #0ea5e9` : undefined,
                        }}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-1 text-xs font-medium" style={{ color: theme.node.muted }}>
                                {/* 只有手柄可拖：整块 draggable 会抢走文本框里的选字手势。 */}
                                {draggable ? (
                                    <span
                                        draggable
                                        onDragStart={(event) => {
                                            event.dataTransfer.setData(PINNED_REORDER_TYPE, key);
                                            event.dataTransfer.effectAllowed = "move";
                                            setDraggingKey(key);
                                        }}
                                        onDragEnd={() => {
                                            setDraggingKey(null);
                                            setDropTarget(null);
                                        }}
                                        className="shrink-0 cursor-grab opacity-40 hover:opacity-80"
                                        title={t("canvas.freeCard.pinnedReorderHint")}
                                    >
                                        <GripVertical className="size-3" />
                                    </span>
                                ) : null}
                                <span className="min-w-0 truncate">{item.label}</span>
                                {/* 文本项是工作流自动探测出来的，不是用户手动固定的；
                                    标出来才知道这一项的来源，负向提示词也不容易被误当正向。 */}
                                {item.text ? (
                                    <span className="shrink-0 rounded px-1 text-[10px] leading-4 opacity-45" style={{ background: theme.node.panel }}>
                                        {t(`canvas.freeCard.pinnedTextRole.${["positive", "negative", "shared"].includes(item.role || "") ? item.role : "unknown"}`)}
                                    </span>
                                ) : null}
                            </span>
                            <span className="shrink-0 text-[10px] opacity-40">
                                #{item.node} · {item.input}
                            </span>
                            {renderAction?.(item)}
                        </div>
                        {item.kind === "combo" ? (
                            <Select
                                className="w-full"
                                size="small"
                                value={String(value)}
                                options={item.options.map((option) => ({ value: option, label: option }))}
                                getPopupContainer={popupContainer}
                                // 选项为空说明本地没装对应模型，别让下拉看起来像坏了。
                                notFoundContent={<span className="text-[11px] opacity-60">{t("canvas.freeCard.comboEmpty")}</span>}
                                onChange={(next) => onChangeValue(item, next)}
                            />
                        ) : item.kind === "number" ? (
                            <InputNumber
                                className="w-full"
                                size="small"
                                value={typeof value === "number" ? value : Number(value) || 0}
                                precision={item.integer ? 0 : undefined}
                                onChange={(next) => onChangeValue(item, next ?? 0)}
                            />
                        ) : item.kind === "boolean" ? (
                            <Select
                                className="w-full"
                                size="small"
                                value={String(value) === "true" ? "true" : "false"}
                                options={[
                                    { value: "true", label: t("common.yes") },
                                    { value: "false", label: t("common.no") },
                                ]}
                                getPopupContainer={popupContainer}
                                onChange={(next) => onChangeValue(item, next === "true")}
                            />
                        ) : (
                            <textarea
                                className={`w-full resize-y rounded-xl border bg-transparent px-3 py-2 text-sm outline-none ${compact ? "min-h-12" : "min-h-16"}`}
                                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                value={String(value ?? "")}
                                onChange={(event) => onChangeValue(item, event.target.value)}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
}
