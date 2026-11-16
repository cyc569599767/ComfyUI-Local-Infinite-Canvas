import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, Spin } from "antd";
import { Check, GripVertical, Pin, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { FreeWorkflowGraph, FreeWorkflowGraphNode } from "@/services/api/free-workflow";
import type { PinnedItem } from "@/lib/canvas/free-card-pinned";
import { GRAPH_HEADER_HEIGHT, GRAPH_NODE_WIDTH, GRAPH_ROW_HEIGHT, fitGraphColumns, fitGraphScale, graphNodeHeight, layoutWorkflowGraph } from "@/lib/canvas/free-card-graph-layout";

/**
 * 工作流配置项的「固定」界面。
 *
 * 左边是一张按数据流方向自动排布的节点图：节点画成方块、连线画成贝塞尔曲线，
 * 上游在左、下游在右。每个可固定的输入是节点里的一个行，可以直接拖到右侧槽位。
 *
 * 为什么自动布局而不用 ComfyUI 里的原始坐标：网关拿到的是转换后的 API 工作流，
 * 里面没有 pos/size。为两种格式各写一套布局，用户看到的样子会随工作流格式变化。
 * 自动布局只保证「数据流从左往右」，而这正是判断「这个参数会影响什么」需要的信息。
 */

type Props = {
    graph: FreeWorkflowGraph | null;
    loading: boolean;
    error: string;
    /** 已固定的项（从卡片条目读回，已和 graph 合并出 kind/options）。 */
    pinned: PinnedItem[];
    onPinnedChange: (next: PinnedItem[]) => void;
    /** 把内容高度报给弹窗，避免短图底下留一大片空白。 */
    onContentHeight?: (height: number) => void;
};

const DRAG_TYPE = "application/x-free-card-binding";

export function FreeCardGraphPanel({ graph, loading, error, pinned, onPinnedChange, onContentHeight }: Props) {
    const { t } = useTranslation();
    const [dragOver, setDragOver] = useState(false);
    const [activeNodeId, setActiveNodeId] = useState("");
    const [viewport, setViewport] = useState({ width: 0, height: 0 });
    const viewportRef = useRef<HTMLDivElement | null>(null);

    // 先用默认间距排一遍拿到列数，再据此挑一组能塞进可视宽度的间距。
    // 优先收窄列间距而不是缩整张图：缩图会让节点里的字一起变小，而这里要读的正是字。
    const columns = useMemo(() => {
        const probe = layoutWorkflowGraph(graph);
        return probe.nodes.reduce((max, item) => Math.max(max, item.depth + 1), 0);
    }, [graph]);
    const geometry = useMemo(() => fitGraphColumns(columns, viewport.width), [columns, viewport.width]);
    const layout = useMemo(() => layoutWorkflowGraph(graph, geometry), [graph, geometry]);
    // 收窄间距后仍放不下才整体缩放。
    const scale = fitGraphScale(layout, viewport);
    const pinnedKeys = useMemo(() => new Set(pinned.map((item) => `${item.node}\u0000${item.input}`)), [pinned]);

    // 高亮：选中节点时，直接相连的节点和连线一起亮起来，便于确认「这个参数被谁用」。
    const relatedNodes = useMemo(() => {
        const set = new Set<string>();
        if (!activeNodeId) return set;
        for (const edge of layout.edges) {
            if (edge.from === activeNodeId) set.add(edge.to);
            if (edge.to === activeNodeId) set.add(edge.from);
        }
        return set;
    }, [activeNodeId, layout]);

    const isEdgeActive = (from: string, to: string) => Boolean(activeNodeId) && (from === activeNodeId || to === activeNodeId);

    const pin = (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphNode["inputs"][number]) => {
        const key = `${node.id}\u0000${input.name}`;
        if (pinnedKeys.has(key)) return;
        onPinnedChange([
            ...pinned,
            {
                node: node.id,
                input: input.name,
                label: input.name,
                kind: input.kind,
                options: input.options,
                integer: input.integer,
                value: input.value,
            },
        ]);
    };

    const unpin = (index: number) => onPinnedChange(pinned.filter((_, i) => i !== index));

    const move = (index: number, delta: number) => {
        const target = index + delta;
        if (target < 0 || target >= pinned.length) return;
        const next = [...pinned];
        [next[index], next[target]] = [next[target], next[index]];
        onPinnedChange(next);
    };

    const renamePinned = (index: number, label: string) => {
        onPinnedChange(pinned.map((item, i) => (i === index ? { ...item, label } : item)));
    };

    const handleDrop = (event: React.DragEvent) => {
        event.preventDefault();
        setDragOver(false);
        const raw = event.dataTransfer.getData(DRAG_TYPE);
        if (!raw) return;
        try {
            const payload = JSON.parse(raw) as { node: string; input: string };
            const node = graph?.nodes.find((item) => item.id === payload.node);
            const input = node?.inputs.find((item) => item.name === payload.input);
            if (node && input) pin(node, input);
        } catch {
            // 拖的是别的东西，忽略。
        }
    };

    // 图比视口大时靠滚动，不缩放：缩放后节点里的字会小到看不清，而这里要读的正是字。
    useEffect(() => {
        const element = viewportRef.current;
        if (!element) return;
        const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
        update();
        // 弹窗打开时元素尺寸在动画结束后才稳定，用 ResizeObserver 而不是只量一次。
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    // 缩放后仍按缩放前的坐标系排版，靠 transform 整体缩放，节点内部的字才保持清晰。
    const canvasWidth = Math.max(layout.width, 320) + 24;
    const canvasHeight = Math.max(layout.height, 160) + 24;

    useEffect(() => {
        if (!onContentHeight || !layout.nodes.length) return;
        // 图渲染后的实际高度 + 弹窗标题与提示文字占的固定高度。
        onContentHeight(Math.min(560, Math.round(canvasHeight * scale) + 92));
    }, [canvasHeight, layout.nodes.length, onContentHeight, scale]);

    return (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_250px] gap-3 overflow-hidden">
            <div ref={viewportRef} className="thin-scrollbar min-h-0 overflow-auto rounded-xl border border-stone-200 bg-stone-50/60 dark:border-stone-700 dark:bg-stone-900/40">
                {loading ? (
                    <div className="grid h-40 place-items-center">
                        <Spin size="small" />
                    </div>
                ) : error ? (
                    <div className="grid h-40 place-items-center px-4 text-center text-xs opacity-60">{error}</div>
                ) : layout.nodes.length ? (
                    <div style={{ width: canvasWidth * scale, height: canvasHeight * scale }}>
                    <div
                        className="relative origin-top-left"
                        style={{ width: canvasWidth, height: canvasHeight, transform: `scale(${scale})`, transformOrigin: "top left" }}
                    >
                        {/* 连线画在节点下面，避免盖住输入行 */}
                        <svg className="pointer-events-none absolute inset-0" width={canvasWidth} height={canvasHeight}>
                            {layout.edges.map((edge) => {
                                const active = isEdgeActive(edge.from, edge.to);
                                return (
                                    <g key={edge.id}>
                                        <path d={edge.path} fill="none" stroke={active ? "#0ea5e9" : "#a8a29e"} strokeWidth={active ? 2 : 1.4} opacity={active ? 0.95 : 0.5} />
                                        <circle cx={edge.fromPoint.x} cy={edge.fromPoint.y} r={active ? 3 : 2.2} fill={active ? "#0ea5e9" : "#a8a29e"} opacity={active ? 1 : 0.6} />
                                        <circle cx={edge.toPoint.x} cy={edge.toPoint.y} r={active ? 3 : 2.2} fill={active ? "#0ea5e9" : "#a8a29e"} opacity={active ? 1 : 0.6} />
                                    </g>
                                );
                            })}
                        </svg>

                        {layout.nodes.map((placed) => {
                            const node = placed.node;
                            const active = activeNodeId === node.id;
                            const related = relatedNodes.has(node.id);
                            const height = graphNodeHeight(node);
                            return (
                                <div
                                    key={node.id}
                                    className={`absolute overflow-hidden rounded-lg border shadow-sm transition ${active ? "border-sky-500 ring-2 ring-sky-500/25" : related ? "border-stone-400 dark:border-stone-500" : "border-stone-300 dark:border-stone-600"} bg-white dark:bg-stone-900`}
                                    style={{ left: placed.x + 12, top: placed.y + 12, width: placed.width, height }}
                                    onClick={() => setActiveNodeId(active ? "" : node.id)}
                                >
                                    {/* 标题栏：颜色区分输出节点，一眼看出链路终点 */}
                                    <div
                                        className={`flex items-center gap-1 px-2 ${node.output ? "bg-emerald-500/12" : "bg-stone-100 dark:bg-stone-800"}`}
                                        style={{ height: GRAPH_HEADER_HEIGHT }}
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-[11px] font-semibold leading-4">{node.title}</div>
                                            <div className="truncate text-[9px] leading-3 opacity-45">
                                                #{node.id} · {node.classType}
                                            </div>
                                        </div>
                                        {node.output ? <span className="shrink-0 text-[9px] text-emerald-600 dark:text-emerald-400">{t("canvas.freeCard.graphOutput")}</span> : null}
                                    </div>

                                    {/* 可固定输入：每行一个，可拖到右侧 */}
                                    <div className="px-1 py-1">
                                        {node.inputs.length ? (
                                            node.inputs.map((input) => {
                                                const pinnedAlready = pinnedKeys.has(`${node.id}\u0000${input.name}`);
                                                return (
                                                    <div
                                                        key={input.name}
                                                        draggable={!pinnedAlready}
                                                        onDragStart={(event) => {
                                                            event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ node: node.id, input: input.name }));
                                                            event.dataTransfer.effectAllowed = "copy";
                                                        }}
                                                        onClick={(event) => event.stopPropagation()}
                                                        title={pinnedAlready ? t("canvas.freeCard.graphAlreadyPinned") : t("canvas.freeCard.graphDragHint")}
                                                        className={`flex items-center gap-1 rounded px-1 text-[10px] ${pinnedAlready ? "cursor-default opacity-35" : "cursor-grab hover:bg-sky-500/10"}`}
                                                        style={{ height: GRAPH_ROW_HEIGHT }}
                                                    >
                                                        <span className={`size-1.5 shrink-0 rounded-full ${pinnedAlready ? "bg-stone-300 dark:bg-stone-600" : "bg-sky-500"}`} />
                                                        <span className={`min-w-0 flex-1 truncate ${pinnedAlready ? "line-through" : ""}`}>{input.name}</span>
                                                        <span className="shrink-0 opacity-35">{inputKindLabel(input.kind, t)}</span>
                                                        {pinnedAlready ? <Check className="size-2.5 shrink-0 text-emerald-500" /> : <GripVertical className="size-2.5 shrink-0 opacity-30" />}
                                                    </div>
                                                );
                                            })
                                        ) : (
                                            <div className="px-1 text-[9px] opacity-30">{t("canvas.freeCard.graphNoInputs")}</div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    </div>
                ) : (
                    <div className="grid h-40 place-items-center">
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="text-xs opacity-55">{t("canvas.freeCard.graphEmpty")}</span>} />
                    </div>
                )}
            </div>

            {/* 右：固定槽 */}
            <div
                className={`flex min-h-0 flex-col rounded-xl border border-dashed p-2 transition ${dragOver ? "border-sky-500 bg-sky-500/5" : "border-stone-300 dark:border-stone-600"}`}
                onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
                    event.preventDefault();
                    setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
            >
                <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium opacity-60">
                    <Pin className="size-3" />
                    {t("canvas.freeCard.pinnedTitle")}
                    {pinned.length ? <span className="opacity-60">{pinned.length}</span> : null}
                </div>
                <div className="thin-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto">
                    {pinned.length ? (
                        pinned.map((item, index) => (
                            <div key={`${item.node}\u0000${item.input}`} className="group rounded-md border border-stone-200 bg-white px-1.5 py-1 dark:border-stone-700 dark:bg-stone-900">
                                <div className="flex items-center gap-1">
                                    <span className="shrink-0 font-mono text-[10px] opacity-40">#{item.node}</span>
                                    <input
                                        value={item.label}
                                        maxLength={40}
                                        className="min-w-0 flex-1 bg-transparent text-[11px] font-medium outline-none"
                                        onChange={(event) => renamePinned(index, event.target.value)}
                                    />
                                    <button type="button" className="grid size-5 shrink-0 place-items-center rounded opacity-35 hover:opacity-100" title={t("canvas.freeCard.pinnedMoveUp")} disabled={index === 0} onClick={() => move(index, -1)}>
                                        <Pin className="size-2.5 rotate-180" />
                                    </button>
                                    <button type="button" className="grid size-5 shrink-0 place-items-center rounded opacity-35 hover:opacity-100" title={t("canvas.freeCard.pinnedMoveDown")} disabled={index === pinned.length - 1} onClick={() => move(index, 1)}>
                                        <Pin className="size-2.5" />
                                    </button>
                                    <button type="button" className="grid size-5 shrink-0 place-items-center rounded opacity-35 hover:opacity-100" title={t("canvas.freeCard.pinnedRemove")} onClick={() => unpin(index)}>
                                        <Trash2 className="size-2.5" />
                                    </button>
                                </div>
                                <div className="mt-0.5 flex items-center gap-1 pl-1 text-[10px] opacity-45">
                                    <span>{item.input}</span>
                                    <span>·</span>
                                    <span>{inputKindLabel(item.kind, t)}</span>
                                </div>
                            </div>
                        ))
                    ) : (
                        <div className="grid h-24 place-items-center px-2 text-center text-[11px] leading-4 opacity-40">{t("canvas.freeCard.pinnedEmpty")}</div>
                    )}
                </div>
                {pinned.length ? (
                    <div className="mt-1 flex items-center gap-1 px-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                        <Check className="size-2.5" />
                        {t("canvas.freeCard.pinnedAutoSave")}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function inputKindLabel(kind: string, t: (key: string) => string) {
    return t(`canvas.freeCard.inputKind.${kind}`);
}
