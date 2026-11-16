/**
 * 固定配置项的纯数据逻辑。
 *
 * 从组件里抽出来是为了能测：这里的关键判断（哪些绑定还有效、值怎么传回网关）
 * 出错时表现是「卡片上少一个控件」或「改了没生效」，靠肉眼看界面很难发现。
 */
import type { FreeWorkflowBindingSurface, FreeWorkflowCustomBinding, FreeWorkflowGraph, FreeWorkflowGraphInput, FreeWorkflowGraphNode } from "@/services/api/free-workflow";

export type PinnedItem = FreeWorkflowCustomBinding & {
    /** 输入类型，决定卡片上渲染什么控件。 */
    kind: FreeWorkflowGraphInput["kind"];
    options: string[];
    integer: boolean;
    /** 工作流里的原始值，作为卡片控件的默认值。 */
    value: FreeWorkflowGraphInput["value"];
    /** 固定项显示在哪里，缺省按卡片处理。 */
    surface: FreeWorkflowBindingSurface;
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
        const key = customKey(item);
        const value = key in values ? values[key] : item.value;
        if (value === undefined) continue;
        if (value === "" && item.kind !== "text") continue;
        out.push({ node: item.node, input: item.input, value });
    }
    return out;
}
