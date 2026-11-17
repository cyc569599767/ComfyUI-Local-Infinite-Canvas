/**
 * 画布内浮层的容器解析。
 *
 * 默认 antd 把下拉/弹层挂到 document.body，用 JS 算出的屏幕坐标定位。画布平移或缩放时
 * 这些坐标不会跟着变，弹层就留在原地——用户拖动卡片，设置窗口却飘在别处。
 *
 * 挂到画布的变换层里就能跟随：那一层本来就在做 translate + scale，浮层作为它的子节点
 * 自动继承同样的变换。缩放时浮层的字会跟着变小，和节点里已有的文字一致，这符合预期。
 *
 * 挂到哪一层很关键。直接挂在 `[data-canvas-transform-layer]`（节点内容所在的那层）看似
 * 自然，但那一层因为有 transform 而形成了层叠上下文：弹窗自己的 z-index 只在层内有效，
 * 对外等价于 0，于是节点工具栏（z-70，在更外层）会把弹窗盖住——「信息 / 删除」那条正好
 * 压在设置弹窗上。所以优先挂到 `[data-canvas-popup-layer]`：变换完全相同，但它是一层独立
 * 的 z-100，z-index 才真正能与工具栏比较。
 */

/** 画布变换层的标记属性，和 infinite-canvas 里的渲染保持一致。 */
export const CANVAS_TRANSFORM_LAYER = "data-canvas-transform-layer";

/** 整块画布的标记属性：浮层层是它的兄弟，得从这里往下找。 */
export const CANVAS_ROOT = "data-canvas-root";

/** 浮层专用层：变换同上，但层级独立，浮在这种层里的弹窗不会被节点工具栏盖住。 */
export const CANVAS_POPUP_LAYER = "data-canvas-popup-layer";

/**
 * 给 antd 的 getPopupContainer 用：把浮层挂到画布的浮层层。
 *
 * 浮层层是空容器，不在触发按钮的祖先链上，所以不能从 trigger 往上 closest，
 * 要先找到同一块画布，再取它里面的浮层层。
 * 退而求其次才是 `[data-canvas-transform-layer]`；都找不到时返回 body——
 * 节点被抽到侧边面板等画布之外的场景仍要能弹出。宁可回到「不跟随」的旧行为，
 * 也不要因为拿不到容器而整个浮层消失。
 */
export function canvasPopupContainer(trigger: HTMLElement | null): HTMLElement {
    const canvas = trigger?.closest?.(`[${CANVAS_ROOT}]`);
    const popupLayer = canvas?.querySelector?.(`[${CANVAS_POPUP_LAYER}]`);
    if (popupLayer instanceof HTMLElement) return popupLayer;
    const layer = trigger?.closest?.(`[${CANVAS_TRANSFORM_LAYER}]`);
    if (layer instanceof HTMLElement) return layer;
    return document.body;
}
