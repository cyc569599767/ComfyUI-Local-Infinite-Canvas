import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Empty, Spin } from "antd";
import { Check, GripVertical, Maximize2, Pin, RotateCcw, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { FreeWorkflowBindingSurface, FreeWorkflowGraph, FreeWorkflowGraphNode } from "@/services/api/free-workflow";
import type { PinnedItem } from "@/lib/canvas/free-card-pinned";
import {
    GRAPH_HEADER_HEIGHT,
    GRAPH_ROW_HEIGHT,
    MAX_VIEW_SCALE,
    MIN_VIEW_SCALE,
    centerGraphView,
    fitGraphColumns,
    fitGraphScale,
    graphNodeHeight,
    layoutWorkflowGraph,
    zoomViewAt,
    type GraphView,
} from "@/lib/canvas/free-card-graph-layout";

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
/** 固定槽内部重排用的类型，和「从节点图拖进来」区分开。 */
const REORDER_TYPE = "application/x-free-card-reorder";
/** 每次滚轮的缩放倍率。和画布主视图的手感接近，不会一下跨太远。 */
const ZOOM_STEP = 1.12;

export function FreeCardGraphPanel({ graph, loading, error, pinned, onPinnedChange, onContentHeight }: Props) {
    const { t } = useTranslation();
    const [dragOver, setDragOver] = useState(false);
    const [activeNodeId, setActiveNodeId] = useState("");
    /** 正在被拖动的固定项下标，用于把原位画淡。 */
    const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
    /** 拖动经过时高亮的目标位置。 */
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const [viewport, setViewport] = useState({ width: 0, height: 0 });
    /** 用户手动缩放/平移后的视图。null 表示「还没动过」，跟着自适应尺寸走。 */
    const [view, setView] = useState<GraphView | null>(null);
    const [panning, setPanning] = useState(false);
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const panRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

    // 先用默认间距排一遍拿到列数，再据此挑一组能塞进可视宽度的间距。
    // 优先收窄列间距而不是缩整张图：缩图会让节点里的字一起变小，而这里要读的正是字。
    const columns = useMemo(() => {
        const probe = layoutWorkflowGraph(graph);
        return probe.nodes.reduce((max, item) => Math.max(max, item.depth + 1), 0);
    }, [graph]);
    const geometry = useMemo(() => fitGraphColumns(columns, viewport.width), [columns, viewport.width]);
    const layout = useMemo(() => layoutWorkflowGraph(graph, geometry), [graph, geometry]);
    // 收窄间距后仍放不下才整体缩放；这是「不手动缩放时」的默认比例。
    const fitScale = fitGraphScale(layout, viewport);
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
                surface: "card",
            },
        ]);
    };

    const unpin = (index: number) => onPinnedChange(pinned.filter((_, i) => i !== index));

    /** 把第 from 项移到第 to 项的位置（拖拽重排）。 */
    const reorder = (from: number, to: number) => {
        if (from === to || from < 0 || to < 0 || from >= pinned.length || to >= pinned.length) return;
        const next = [...pinned];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        onPinnedChange(next);
    };

    const renamePinned = (index: number, label: string) => {
        onPinnedChange(pinned.map((item, i) => (i === index ? { ...item, label } : item)));
    };

    const setSurface = (index: number, surface: FreeWorkflowBindingSurface) => {
        onPinnedChange(pinned.map((item, i) => (i === index ? { ...item, surface } : item)));
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

    const canvasWidth = Math.max(layout.width, 320) + 24;
    const canvasHeight = Math.max(layout.height, 160) + 24;

    // 没手动缩放时用自适应比例，动过之后以用户的为准。
    const scale = view ? view.scale : fitScale;
    const offsetX = view ? view.x : 0;
    const offsetY = view ? view.y : 0;

    const resetView = useCallback(() => setView(null), []);

    const zoomBy = useCallback(
        (factor: number) => {
            const element = viewportRef.current;
            const rect = element?.getBoundingClientRect();
            const center = { x: (rect?.width ?? canvasWidth) / 2, y: (rect?.height ?? canvasHeight) / 2 };
            setView((current) => {
                const base = current ?? { scale: fitScale, x: 0, y: 0 };
                return zoomViewAt(base, center, base.scale * factor);
            });
        },
        [canvasHeight, canvasWidth, fitScale],
    );

    // 滚轮缩放：以光标为锚点，指哪儿放大哪儿。必须 passive: false，否则无法阻止页面滚动。
    useEffect(() => {
        const element = viewportRef.current;
        if (!element) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            const rect = element.getBoundingClientRect();
            const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            // 触控板给的是像素增量、鼠标给的是行数，统一成「向上为放大」。
            const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
            setView((current) => zoomViewAt(current ?? { scale: fitScale, x: 0, y: 0 }, cursor, (current?.scale ?? fitScale) * factor));
        };
        element.addEventListener("wheel", onWheel, { passive: false });
        return () => element.removeEventListener("wheel", onWheel);
    }, [fitScale]);

    // 中键拖动平移。用 pointer capture 保证鼠标移出元素时也能继续拖。
    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 1) return;
        // 中键默认会触发浏览器的自动滚动，必须挡掉。
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const base = view ?? { scale: fitScale, x: 0, y: 0 };
        panRef.current = { startX: event.clientX, startY: event.clientY, originX: base.x, originY: base.y };
        setView(base);
        setPanning(true);
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const state = panRef.current;
        if (!state) return;
        setView((current) => {
            const base = current ?? { scale: fitScale, x: 0, y: 0 };
            return { ...base, x: state.originX + (event.clientX - state.startX), y: state.originY + (event.clientY - state.startY) };
        });
    };

    const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!panRef.current) return;
        panRef.current = null;
        setPanning(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    useEffect(() => {
        if (!onContentHeight || !layout.nodes.length) return;
        // 图渲染后的实际高度 + 弹窗标题与提示文字占的固定高度。
        // 这里用自适应比例而不是当前比例：用户缩放时若弹窗跟着长高，视口变大又影响自适应比例，
        // 会形成「越滚越大」的回馈。缩放是临时的浏览动作，不该改变弹窗尺寸。
        onContentHeight(Math.min(560, Math.round(canvasHeight * fitScale) + 92));
    }, [canvasHeight, fitScale, layout.nodes.length, onContentHeight]);

    return (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_250px] gap-3 overflow-hidden">
            <div
                ref={viewportRef}
                className={`relative min-h-0 overflow-hidden rounded-xl border border-stone-200 bg-stone-50/60 dark:border-stone-700 dark:bg-stone-900/40 ${panning ? "cursor-grabbing" : "cursor-default"}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endPan}
                onPointerCancel={endPan}
                // 中键按下时浏览器会尝试粘贴/自动滚动，挡掉上下文菜单和默认行为。
                onAuxClick={(event) => event.preventDefault()}
            >
                {loading ? (
                    <div className="grid h-40 place-items-center">
                        <Spin size="small" />
                    </div>
                ) : error ? (
                    <div className="grid h-40 place-items-center px-4 text-center text-xs opacity-60">{error}</div>
                ) : layout.nodes.length ? (
                    <>
                        <div
                            className="absolute origin-top-left"
                            style={{
                                width: canvasWidth,
                                height: canvasHeight,
                                transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
                                transformOrigin: "top left",
                                // 拖动时不加过渡，否则跟手会有延迟感；缩放时加一点更顺滑。
                                transition: panning ? "none" : "transform 80ms ease-out",
                            }}
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

                        {/* 缩放控件：滚轮和中键能做的事也要有按钮，否则触屏/没滚轮的设备没法用 */}
                        <div className="absolute bottom-2 left-2 flex items-center gap-0.5 rounded-lg border border-stone-200 bg-white/90 px-1 py-0.5 shadow-sm backdrop-blur dark:border-stone-700 dark:bg-stone-900/90">
                            <button
                                type="button"
                                className="grid size-5 place-items-center rounded opacity-60 hover:bg-stone-500/10 hover:opacity-100 disabled:opacity-25"
                                title={t("canvas.freeCard.graphZoomOut")}
                                disabled={scale <= MIN_VIEW_SCALE + 0.001}
                                onClick={() => zoomBy(1 / ZOOM_STEP)}
                            >
                                <ZoomOut className="size-3" />
                            </button>
                            <span className="w-8 text-center text-[10px] tabular-nums opacity-55">{Math.round(scale * 100)}%</span>
                            <button
                                type="button"
                                className="grid size-5 place-items-center rounded opacity-60 hover:bg-stone-500/10 hover:opacity-100 disabled:opacity-25"
                                title={t("canvas.freeCard.graphZoomIn")}
                                disabled={scale >= MAX_VIEW_SCALE - 0.001}
                                onClick={() => zoomBy(ZOOM_STEP)}
                            >
                                <ZoomIn className="size-3" />
                            </button>
                            <span className="mx-0.5 h-3 w-px bg-stone-300 dark:bg-stone-600" />
                            <button type="button" className="grid size-5 place-items-center rounded opacity-60 hover:bg-stone-500/10 hover:opacity-100" title={t("canvas.freeCard.graphFit")} onClick={resetView}>
                                <Maximize2 className="size-3" />
                            </button>
                            <button
                                type="button"
                                className="grid size-5 place-items-center rounded opacity-60 hover:bg-stone-500/10 hover:opacity-100"
                                title={t("canvas.freeCard.graphResetView")}
                                onClick={() => setView(centerGraphView({ width: canvasWidth, height: canvasHeight }, viewport, 1))}
                            >
                                <RotateCcw className="size-3" />
                            </button>
                        </div>
                    </>
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
                    // 内部重排由卡片自己处理，这里只管从左边节点图拖进来的。
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
                    {/* 拖拽排序没有可见入口，不提示的话用户不会去试。 */}
                    {pinned.length > 1 ? <span className="ml-auto text-[10px] font-normal opacity-70">{t("canvas.freeCard.pinnedReorderHint")}</span> : null}
                </div>
                <div data-graph-pin-list className="thin-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto">
                    {pinned.length ? (
                        pinned.map((item, index) => (
                            <div
                                key={`${item.node}\u0000${item.input}`}
                                // 整块可拖：把手只是视觉提示，抓着卡片任意空白处都能拖。
                                draggable
                                onDragStart={(event) => {
                                    event.dataTransfer.setData(REORDER_TYPE, String(index));
                                    event.dataTransfer.effectAllowed = "move";
                                    setDraggingIndex(index);
                                }}
                                onDragEnd={() => {
                                    setDraggingIndex(null);
                                    setDropIndex(null);
                                }}
                                onDragOver={(event) => {
                                    // 只有内部重排才接管，从节点图拖进来的交给外层槽位处理。
                                    if (!event.dataTransfer.types.includes(REORDER_TYPE)) return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setDropIndex(index);
                                }}
                                onDragLeave={() => setDropIndex((current) => (current === index ? null : current))}
                                onDrop={(event) => {
                                    const raw = event.dataTransfer.getData(REORDER_TYPE);
                                    if (!raw) return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    reorder(Number(raw), index);
                                    setDraggingIndex(null);
                                    setDropIndex(null);
                                }}
                                className={`group rounded-md border bg-white px-1.5 py-1 transition dark:bg-stone-900 ${dropIndex === index && draggingIndex !== index ? "border-sky-500 ring-1 ring-sky-500/40" : "border-stone-200 dark:border-stone-700"} ${draggingIndex === index ? "opacity-40" : ""}`}
                            >
                                <div className="flex items-center gap-1">
                                    <GripVertical className="size-3 shrink-0 cursor-grab opacity-35" />
                                    <span className="shrink-0 font-mono text-[10px] opacity-40">#{item.node}</span>
                                    <input
                                        value={item.label}
                                        maxLength={40}
                                        className="min-w-0 flex-1 bg-transparent text-[11px] font-medium outline-none"
                                        onChange={(event) => renamePinned(index, event.target.value)}
                                        // 输入框里拖动会选中文字，不要触发整块重排。
                                        onDragStart={(event) => event.stopPropagation()}
                                    />
                                    <button type="button" className="grid size-5 shrink-0 place-items-center rounded opacity-35 hover:opacity-100" title={t("canvas.freeCard.pinnedRemove")} onClick={() => unpin(index)}>
                                        <Trash2 className="size-2.5" />
                                    </button>
                                </div>
                                <div className="mt-0.5 flex items-center gap-1 pl-1 text-[10px] opacity-45">
                                    <span>{item.input}</span>
                                    <span>·</span>
                                    <span>{inputKindLabel(item.kind, t)}</span>
                                </div>
                                {/* 显示位置：决定这个参数出现在卡片上，还是收进「生成设置」 */}
                                <div className="mt-1 grid grid-cols-2 gap-1 pl-1">
                                    {(["card", "settings"] as FreeWorkflowBindingSurface[]).map((surface) => {
                                        const selected = item.surface === surface;
                                        return (
                                            <button
                                                key={surface}
                                                type="button"
                                                onClick={() => setSurface(index, surface)}
                                                className={`rounded px-1 py-0.5 text-[10px] transition ${selected ? "bg-sky-500/15 font-medium text-sky-600 dark:text-sky-400" : "opacity-45 hover:bg-stone-500/10 hover:opacity-80"}`}
                                            >
                                                {t(`canvas.freeCard.surface.${surface}`)}
                                            </button>
                                        );
                                    })}
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
