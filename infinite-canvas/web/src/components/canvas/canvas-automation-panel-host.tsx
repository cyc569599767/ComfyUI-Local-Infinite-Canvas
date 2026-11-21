import type { CanvasNodeContext } from "@/types/canvas-plugin";

import { CanvasAutomationPanel } from "./canvas-automation-panel";

/**
 * 自动化（automation）节点的面板适配器。
 *
 * 节点定义的 `Panel` 统一接收 `{ ctx, onClose }`，而 `CanvasAutomationPanel` 是卡片式组件。
 * 这里做一层薄适配：
 *
 * - `node` / `onChange` 由 ctx 提供，剧本导入、风格/比例/模型配置、分页等编辑能力可用；
 * - 运行编排回调（onStart / onStop / onRetry）注入为「提示未接入」的空实现 ——
 *   它依赖上游 project.tsx 的自动化流水线，本 fork 尚未接入，避免误触发生成。
 */
export function CanvasAutomationPanelHost({ ctx }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const notWired = () => {
        // 自动化流水线未接入时不做任何事；用户的编辑（剧本/风格/比例）照常保存。
    };
    return (
        <CanvasAutomationPanel
            node={ctx.node}
            isRunning={false}
            onChange={(patch) => ctx.updateMetadata(patch as Parameters<typeof ctx.updateMetadata>[0])}
            onStart={notWired}
            onStop={notWired}
            onRetry={notWired}
        />
    );
}
