import { useCallback, useMemo, useState } from "react";
import { Empty, Spin } from "antd";
import { Check, GripVertical, Pin, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { FreeWorkflowGraph, FreeWorkflowGraphNode } from "@/services/api/free-workflow";
import type { PinnedItem } from "@/lib/canvas/free-card-pinned";

/**
 * 工作流配置项的「固定」界面。
 *
 * 左半边是简化节点图：每个节点列出它身上还没被连线占用的输入，可以拖出来。
 * 右半边是已固定的槽位，接收拖入的配置项，可排序、可删除。
 *
 * 为什么不做成完整的 ComfyUI 节点图：用户在这里只做一件事——指出「我要那个参数」。
 * 显示节点标题和输入名就够了；画布位置、尺寸、颜色对判断毫无帮助，反而占地方。
 * 所以节点按输入连线的依赖顺序竖排，连线用左侧一条竖线示意，点到节点能高亮它的上下游。
 */

type Props = {
    graph: FreeWorkflowGraph | null;
    loading: boolean;
    error: string;
    /** 已固定的项（从卡片条目读回，已和 graph 合并出 kind/options）。 */
    pinned: PinnedItem[];
    onPinnedChange: (next: PinnedItem[]) => void;
};

const DRAG_TYPE = "application/x-free-card-binding";

export function FreeCardGraphPanel({ graph, loading, error, pinned, onPinnedChange }: Props) {
    const { t } = useTranslation();
    const [dragOver, setDragOver] = useState(false);
    const [activeNodeId, setActiveNodeId] = useState("");

    const pinnedKeys = useMemo(() => new Set(pinned.map((item) => `${item.node}\u0000${item.input}`)), [pinned]);

    // 连线关系：用于高亮当前节点直接相连的上下游，帮用户确认「这个参数在被谁用」。
    const neighbours = useMemo(() => {
        const map = new Map<string, Set<string>>();
        const add = (a: string, b: string) => {
            if (!map.has(a)) map.set(a, new Set());
            map.get(a)!.add(b);
        };
        for (const link of graph?.links || []) {
            add(link.from, link.to);
            add(link.to, link.from);
        }
        return map;
    }, [graph]);

    const pin = useCallback(
        (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphNode["inputs"][number]) => {
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
        },
        [onPinnedChange, pinned, pinnedKeys],
    );

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

    const nodes = graph?.nodes || [];

    return (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_260px] gap-3 overflow-hidden">
            {/* 左：简化节点图 */}
            <div className="thin-scrollbar min-h-0 overflow-y-auto rounded-xl border border-stone-200 p-2 dark:border-stone-700">
                {loading ? (
                    <div className="grid h-32 place-items-center">
                        <Spin size="small" />
                    </div>
                ) : error ? (
                    <div className="grid h-32 place-items-center px-4 text-center text-xs opacity-60">{error}</div>
                ) : nodes.length ? (
                    <div className="space-y-1.5">
                        {nodes.map((node) => {
                            const active = activeNodeId === node.id;
                            const related = activeNodeId ? neighbours.get(activeNodeId)?.has(node.id) : false;
                            return (
                                <div
                                    key={node.id}
                                    className={`rounded-lg border px-2 py-1.5 transition ${active ? "border-stone-400 bg-stone-100 dark:border-stone-500 dark:bg-stone-800" : related ? "border-stone-300 dark:border-stone-600" : "border-stone-200 dark:border-stone-700"}`}
                                    onClick={() => setActiveNodeId(active ? "" : node.id)}
                                >
                                    <div className="flex items-center gap-1.5">
                                        <span className="shrink-0 rounded bg-stone-200 px-1 py-0.5 font-mono text-[10px] opacity-70 dark:bg-stone-700">#{node.id}</span>
                                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{node.title}</span>
                                        {node.output ? <span className="shrink-0 rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-600 dark:text-emerald-400">{t("canvas.freeCard.graphOutput")}</span> : null}
                                    </div>
                                    <div className="mt-1 text-[10px] opacity-40">{node.classType}</div>
                                    {node.inputs.length ? (
                                        <div className="mt-1.5 flex flex-wrap gap-1">
                                            {node.inputs.map((input) => {
                                                const pinnedAlready = pinnedKeys.has(`${node.id}\u0000${input.name}`);
                                                return (
                                                    <span
                                                        key={input.name}
                                                        draggable={!pinnedAlready}
                                                        onDragStart={(event) => {
                                                            event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ node: node.id, input: input.name }));
                                                            event.dataTransfer.effectAllowed = "copy";
                                                        }}
                                                        onClick={(event) => event.stopPropagation()}
                                                        title={pinnedAlready ? t("canvas.freeCard.graphAlreadyPinned") : t("canvas.freeCard.graphDragHint")}
                                                        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${pinnedAlready ? "cursor-default opacity-35 line-through" : "cursor-grab bg-stone-100 hover:bg-stone-200 dark:bg-stone-800 dark:hover:bg-stone-700"}`}
                                                    >
                                                        <GripVertical className="size-2.5 opacity-50" />
                                                        {input.name}
                                                        <span className="opacity-40">{inputKindLabel(input.kind, t)}</span>
                                                    </span>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="mt-1 text-[10px] opacity-30">{t("canvas.freeCard.graphNoInputs")}</div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="text-xs opacity-55">{t("canvas.freeCard.graphEmpty")}</span>} />
                )}
            </div>

            {/* 右：固定槽 */}
            <div
                className={`flex min-h-0 flex-col rounded-xl border border-dashed p-2 transition ${dragOver ? "border-stone-500 bg-stone-100 dark:border-stone-400 dark:bg-stone-800" : "border-stone-300 dark:border-stone-600"}`}
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
