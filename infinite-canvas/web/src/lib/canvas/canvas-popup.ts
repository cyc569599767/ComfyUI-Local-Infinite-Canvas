/**
 * 画布内浮层的容器解析。
 *
 * 默认 antd 把下拉/弹层挂到 document.body，用 JS 算出的屏幕坐标定位。画布平移或缩放时
 * 这些坐标不会跟着变，弹层就留在原地——用户拖动卡片，设置窗口却飘在别处。
 *
 * 挂到画布的变换层里就能跟随：那一层本来就在做 translate + scale，浮层作为它的子节点
 * 自动继承同样的变换。缩放时浮层的字会跟着变小，和节点里已有的文字一致，这符合预期。
 */

/** 画布变换层的标记属性，和 infinite-canvas 里的渲染保持一致。 */
export const CANVAS_TRANSFORM_LAYER = "data-canvas-transform-layer";

/**
 * 给 antd 的 getPopupContainer 用：把浮层挂到最近的画布变换层。
 *
 * 找不到变换层时返回 body——节点被抽到侧边面板等画布之外的场景仍要能弹出。
 * 宁可回到「不跟随」的旧行为，也不要因为拿不到容器而整个浮层消失。
 */
export function canvasPopupContainer(trigger: HTMLElement | null): HTMLElement {
    const layer = trigger?.closest?.(`[${CANVAS_TRANSFORM_LAYER}]`);
    if (layer instanceof HTMLElement) return layer;
    return document.body;
}
