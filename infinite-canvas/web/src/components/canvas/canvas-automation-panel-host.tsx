import { App } from "antd";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

import { CanvasAutomationPanel } from "./canvas-automation-panel";

/**
 * 自动化（automation）节点的面板适配器。
 *
 * 节点定义的 `Panel` 统一接收 `{ ctx, onClose }`，而 `CanvasAutomationPanel` 是卡片式组件，
 * 这里做一层薄适配。
 *
 * **运行入口在哪**：正常打开画布时，`pages/canvas/project.tsx` 的 `renderNodePanel` 会先命中
 * `panelNode.type === CanvasNodeType.Automation` 分支，注入真实的 startAutomation /
 * stopAutomation / retryAutomation，**不会走到这里**。本组件是节点定义里注册的兜底 Panel，
 * 只在插件注册表路径下被调用。
 *
 * 早先这里把三个回调都写成静默空实现，结果是：一旦走兜底路径，用户点「开始生成」毫无反应，
 * 也看不到任何解释。现在改成明确提示，避免「点了没反应」这种最难排查的体验。
 */
export function CanvasAutomationPanelHost({ ctx }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const { message } = App.useApp();
    const notAvailable = () =>
        message.warning("当前入口没有接入自动化流水线；请在画布中双击自动化卡片使用完整面板。");
    return (
        <CanvasAutomationPanel
            node={ctx.node}
            isRunning={false}
            onChange={(patch) => ctx.updateMetadata(patch as Parameters<typeof ctx.updateMetadata>[0])}
            onStart={notAvailable}
            onStop={notAvailable}
            onRetry={notAvailable}
        />
    );
}
