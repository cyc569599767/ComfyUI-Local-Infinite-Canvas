import { afterAll, expect, test } from 'bun:test';

// 「选择节点」菜单 = 空白处双击弹出的 NodeCreateMenu，它列出所有 showInCreateMenu !== false 的节点定义。
// 这里直接跑注册表，断言菜单里到底会出现哪些类型。
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
});

const { CanvasNodeType } = await import('../src/types/canvas');
const { registerBuiltinNodes } = await import('../src/components/canvas/nodes/builtin-nodes');
const { listNodeDefinitions } = await import('../src/lib/canvas/node-registry');

registerBuiltinNodes();
const selectable = listNodeDefinitions().filter((def) => def.showInCreateMenu !== false).map((def) => def.type);

test('选择节点菜单不含「音频生成」节点', () => {
    expect(selectable).not.toContain(CanvasNodeType.VoiceDesign);
});

test('选择节点菜单仍保留普通节点与普通音频节点', () => {
    for (const type of [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Config, CanvasNodeType.FreeCard, CanvasNodeType.Group]) {
        expect(selectable).toContain(type);
    }
});

test('音频生成节点仍注册在节点表里，只是不进选择菜单', () => {
    // 隐藏的是入口，不是节点本身：连接点右侧菜单、工具栏、已有画布里的 voice-design 节点都还要能用。
    const all = listNodeDefinitions().map((def) => def.type);
    expect(all).toContain(CanvasNodeType.VoiceDesign);
});

// 布局回归：主菜单是 overflow-y-auto，子菜单如果留在里面会被裁掉，
// 用户只看到一条横向滚动条、菜单不出现。这个 bug 靠逻辑单测抓不到，
// 所以直接对源码结构做约束。
const menuSource = await import('node:fs/promises').then((fs) => fs.readFile('src/components/canvas/canvas-create-menus.tsx', 'utf8'));

test('工作台子菜单必须 Portal 到 body，不能被主菜单的 overflow 裁掉', () => {
    expect(menuSource).toContain('createPortal');
    // 必须是 fixed：主菜单有 transform: scale()，absolute 会跟着缩放且受祖先裁剪。
    expect(menuSource).toMatch(/className="fixed[^"]*z-\[140\]/);
});

test('子菜单不得使用 left-full 这类依赖父容器的绝对定位', () => {
    expect(menuSource).not.toContain('left-full');
});

test('点击外部的关闭判定要排除 Portal 出来的子菜单', () => {
    // 子菜单不在 menuRef 的 DOM 子树里，不排除就会「点一下就整个关掉」。
    expect(menuSource).toContain('data-workbench-menu');
    expect(menuSource).toContain('closest');
});

test('贴边时子菜单要能翻转并限制高度，而不是跑出视口', () => {
    expect(menuSource).toContain('window.innerWidth');
    expect(menuSource).toContain('maxHeight');
});

test('工作台子菜单项使用具体名称，主项不带副标题', () => {
    // 子项如果复用通用的「工作台」标题，菜单内外两层都叫工作台，
    // 用户点进去之前看不出里面是什么。
    expect(menuSource).toContain('WORKBENCH_ITEMS');
    for (const key of ['canvas.workbench.storyboard', 'canvas.workbench.digitalHuman', 'canvas.workbench.videoEditor']) {
        expect(menuSource).toContain(key);
    }
    // 主项不该再有描述行（截图反馈过副标题多余）。
    expect(menuSource).not.toContain('canvas.createMenu.workbenchDescription');
});

test('三种工作台共用节点类型，靠 workbenchKind 区分', () => {
    // 全用 CanvasNodeType.Workbench 建卡，否则节点体系要跟着裂开。
    expect(menuSource).toContain('CanvasNodeType.Workbench, { workbenchKind: kind }');
    // kind 必须是三种之一，写错会让面板分发退化成故事分镜。
    for (const kind of ['"storyboard"', '"digital-human"', '"video-editor"']) {
        expect(menuSource).toContain(kind);
    }
});
