/**
 * 固定配置项的纯数据逻辑。
 *
 * 从组件里抽出来是为了能测：这里的关键判断（哪些绑定还有效、值怎么传回网关）
 * 出错时表现是「卡片上少一个控件」或「改了没生效」，靠肉眼看界面很难发现。
 */
import type { FreeWorkflowBindingSurface, FreeWorkflowCustomBinding, FreeWorkflowGraph, FreeWorkflowGraphInput, FreeWorkflowGraphNode, FreeWorkflowTextInput } from "@/services/api/free-workflow";

export type PinnedItem = FreeWorkflowCustomBinding & {
    /** 输入类型，决定卡片上渲染什么控件。 */
    kind: FreeWorkflowGraphInput["kind"];
    options: string[];
    integer: boolean;
    /** 工作流里的原始值，作为卡片控件的默认值。 */
    value: FreeWorkflowGraphInput["value"];
    /** 固定项显示在哪里，缺省按卡片处理。 */
    surface: FreeWorkflowBindingSurface;
    /**
     * 来自工作流自动检测的文本输入（不是用户手动固定的配置项）。
     *
     * 两类项共用一个列表，是为了让文本输入也能拖拽排序、换显示位置——它们本来就是
     * 「这张卡片的配置」的一部分。但执行时走的通道不同：文本走 texts，配置项走 values，
     * 所以必须能区分开，不能混着发。
     */
    text?: boolean;
    /** 文本输入的极性，用于显示「主提示词」这类提示。 */
    role?: string;
};

export function customKey(item: { node: string; input: string }) {
    return `${item.node}\u0000${item.input}`;
}

/** 归一化显示位置：不认识的取值一律落到卡片上，避免整条绑定凭空消失。 */
export function bindingSurface(item: { surface?: string }): FreeWorkflowBindingSurface {
    return item.surface === "settings" ? "settings" : "card";
}

/** 按显示位置分组，顺序保持不变（用户在弹窗里排的次序就是卡片上的次序）。 */
export function splitBySurface(pinned: PinnedItem[]) {
    const card: PinnedItem[] = [];
    const settings: PinnedItem[] = [];
    for (const item of pinned) (item.surface === "settings" ? settings : card).push(item);
    return { card, settings };
}

/** 数字、开关和短选项可同行，长文本和模型文件名使用整行。 */
export const PINNED_GRID_COLUMNS = 2;

export function pinnedColumnSpan(item: Pick<PinnedItem, "kind"> & Partial<Pick<PinnedItem, "value" | "options">>): number {
    if (item.kind === "text") return PINNED_GRID_COLUMNS;
    const longChoice = item.kind === "combo" && [String(item.value ?? ""), ...(item.options || [])].some((value) => value.length > 26);
    return longChoice ? PINNED_GRID_COLUMNS : 1;
}

/** 只重排同一显示区域；卡片上的其它项保留原来的槽位和值。 */
export function reorderPinned(
    pinned: PinnedItem[],
    fromKey: string,
    toKey: string,
    placement: "before" | "after" = "before",
): PinnedItem[] {
    const source = pinned.find((item) => customKey(item) === fromKey);
    const target = pinned.find((item) => customKey(item) === toKey);
    if (!source || !target || source === target || source.surface !== target.surface) return pinned;
    const reordered = pinned.filter((item) => item.surface === source.surface && customKey(item) !== fromKey);
    const targetIndex = reordered.findIndex((item) => customKey(item) === toKey);
    reordered.splice(targetIndex + (placement === "after" ? 1 : 0), 0, source);
    let index = 0;
    const next = pinned.map((item) => item.surface === source.surface ? reordered[index++] : item);
    return next.every((item, position) => item === pinned[position]) ? pinned : next;
}

/**
 * 把自动检测的文本输入并入固定列表。
 *
 * 文本输入本来只按探测顺序渲染成一串 textarea，用户既不能调顺序也不能把它挪进
 * 「生成设置」。它们其实是这张卡片最重要的配置，所以按固定项同等对待。
 *
 * 主提示词也作为固定项参与布局；优化按钮由渲染器保留。skipKey 只用于兼容旧调用。
 * 已保存的完整顺序优先，图未加载时也能从文本摘要恢复显示位置。
 */
export function mergeTextInputs(
    pinned: PinnedItem[],
    textInputs: FreeWorkflowTextInput[] = [],
    graph: FreeWorkflowGraph | null = null,
    skipKey = "",
    saved: Array<{ node: string; input: string; label?: string; surface?: string; unpinned?: boolean }> = [],
): PinnedItem[] {
    const nodes = new Map((graph?.nodes || []).map((node) => [node.id, node]));
    const savedByKey = new Map(saved.map((item) => [customKey(item), item]));
    const out = new Map(pinned.filter((item) => customKey(item) !== skipKey && !item.unpinned && !savedByKey.get(customKey(item))?.unpinned).map((item) => [customKey(item), item]));
    for (const text of textInputs) {
        const key = customKey(text);
        if (key === skipKey) continue;
        const current = out.get(key);
        const restored = savedByKey.get(key);
        if (restored?.unpinned) continue;
        const input = nodes.get(text.node)?.inputs.find((item) => item.name === text.input);
        out.set(key, {
            node: text.node, input: text.input,
            label: restored?.label || current?.label || text.label || text.input,
            surface: bindingSurface(restored || current || {}),
            kind: "text", options: [], integer: false,
            value: input?.value ?? current?.value ?? text.default,
            text: true, role: text.role,
        });
    }
    const rank = new Map(saved.map((item, index) => [customKey(item), index]));
    return [...out.values()].sort((a, b) =>
        (rank.get(customKey(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(customKey(b)) ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * 把条目上登记的绑定和图里的输入信息合并成可渲染列表。
 *
 * label 用条目上存的（用户可能改过名），类型/选项必须从图里查——后者随工作流同步
 * 而变化，存进 localStorage 就会过期。图里找不到的绑定直接丢弃：那个输入已经不存在，
 * 或者被连线占用了，渲染出来只会是一个改不动的控件。
 */
export function mergePinned(bindings: FreeWorkflowCustomBinding[], graph: FreeWorkflowGraph | null): PinnedItem[] {
    const nodes = new Map<string, FreeWorkflowGraphNode>((graph?.nodes || []).map((node) => [node.id, node]));
    const out: PinnedItem[] = [];
    for (const binding of bindings || []) {
        if (binding.unpinned) continue;
        const input = nodes.get(binding.node)?.inputs.find((item) => item.name === binding.input);
        if (!input) continue;
        out.push({
            node: binding.node,
            input: binding.input,
            label: binding.label || binding.input,
            surface: bindingSurface(binding),
            kind: input.kind,
            options: input.options,
            integer: input.integer,
            value: input.value,
        });
    }
    return out;
}

/**
 * 生成时要提交的固定项取值。
 *
 * 节点上没改过的沿用工作流原值：固定了但没动等于没写，网关拿到原值不会改坏工作流。
 *
 * 空值按类型分开处理。文本清空是用户的明确意图，要提交空串——否则用户删掉内容、
 * 结果生成时又用回原文，会以为控件坏了。数字/选项没有「空」这个合法状态，
 * 提交空串会让 ComfyUI 校验失败，所以跳过、保留工作流原值。
 */
export function buildCustomValues(
    pinned: PinnedItem[],
    values: Record<string, string | number | boolean>,
): Array<{ node: string; input: string; value: string | number | boolean }> {
    const out: Array<{ node: string; input: string; value: string | number | boolean }> = [];
    for (const item of pinned) {
        // 文本输入走 texts 通道，不能同时出现在 values 里：两条通道都写同一个输入时，
        // 后写的会覆盖先写的，而 values 还会按原类型做类型转换，文本很容易被转坏。
        if (item.text || item.unpinned) continue;
        const key = customKey(item);
        const value = key in values ? values[key] : item.value;
        if (value === undefined) continue;
        if (value === "" && item.kind !== "text") continue;
        out.push({ node: item.node, input: item.input, value });
    }
    return out;
}

/** 只从本面板当前拖拽会话解析固定项，用稳定身份而不是可变化的数组下标。 */
export function resolvePinnedDrag(pinned: PinnedItem[], raw: string, activeKey: string | null): PinnedItem | null {
    if (!activeKey || !raw) return null;
    try {
        const payload = JSON.parse(raw);
        if (!payload || typeof payload.node !== "string" || typeof payload.input !== "string") return null;
        const key = customKey(payload);
        if (key !== activeKey) return null;
        return pinned.find((item) => !item.unpinned && customKey(item) === key) || null;
    } catch {
        return null;
    }
}

/** 被移除的自动文本保留取消标记；重新固定时清除标记。普通配置直接移出白名单。 */
export function savePinnedLayout(
    next: FreeWorkflowCustomBinding[],
    current: PinnedItem[],
    saved: FreeWorkflowCustomBinding[],
): FreeWorkflowCustomBinding[] {
    const visible = next.map(({ node, input, label, surface }) => ({ node, input, label, surface: bindingSurface({ surface }) }));
    const keys = new Set(visible.map(customKey));
    const removed = new Map(saved.filter((item) => item.unpinned && !keys.has(customKey(item))).map((item) => [customKey(item), item]));
    for (const item of current) {
        const key = customKey(item);
        if (item.text && !keys.has(key)) removed.set(key, {
            node: item.node, input: item.input, label: item.label, surface: item.surface, unpinned: true,
        });
    }
    return [...visible, ...removed.values()];
}

/** 归档、另存、生成共用一份快照；不能依赖 mergePinned 上不存在的 text 标记。 */
export function buildFreeCardSnapshot({ pinned, textInputs, prompt, textValues, customValues }: {
    pinned: PinnedItem[];
    textInputs: FreeWorkflowTextInput[];
    prompt: string;
    textValues: Record<string, string>;
    customValues: Record<string, string | number | boolean>;
}) {
    const textKeys = new Set(textInputs.map(customKey));
    return {
        texts: textInputs.map((item, index) => ({
            node: item.node,
            input: item.input,
            // 老卡片可能将自动文本存进 freeCardValues；保留兼容，但显式文本（含空串）优先。
            value: index === 0 ? prompt : textValues[`${item.node}:${item.input}`] ?? String(customValues[customKey(item)] ?? item.default),
        })),
        values: buildCustomValues(pinned.filter((item) => !textKeys.has(customKey(item))), customValues),
    };
}
