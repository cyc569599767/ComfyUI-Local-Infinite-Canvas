import type { CanvasNodeContext } from "@/types/canvas-plugin";

import { ShortDramaCard } from "./short-drama-card";

/**
 * 短剧卡的面板适配器。
 *
 * 节点定义里的 `Panel` 统一接收 `{ ctx, onClose }`，而 `ShortDramaCard` 是「卡片式」
 * 组件（接收 node / onChange / 各类编排回调）。这里只做一层薄适配：
 *
 * - `node` / `onChange` 直接由 ctx 提供，编辑能力（剧集、角色库、场景库、道具库、
 *   风格、比例、工作流选择）开箱可用；
 * - 编排回调（开始创作、生成分镜、暂停、加入本剧库、场景参考模式）暂不注入，
 *   `ShortDramaCard` 内部对这些回调做了「缺失即禁用」处理，不会报错也不会误触发生成。
 *
 * 后续接入运行时编排时，只需在这里补上对应回调，无需改动节点注册或卡片实现。
 */
export function ShortDramaPanel({ ctx }: { ctx: CanvasNodeContext; onClose: () => void }) {
    return (
        <ShortDramaCard
            node={ctx.node}
            onChange={(patch) => ctx.updateMetadata(patch)}
        />
    );
}
