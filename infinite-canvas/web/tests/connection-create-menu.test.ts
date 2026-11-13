import { expect, test } from 'bun:test';

// 连接点弹出菜单分左右两套：左侧接上游节点，右侧往下游生成。
// 文案与类型清单都收在 lib/canvas/connection-create-menu.ts，这里直接断言这套规则。
const { CanvasNodeType } = await import('../src/types/canvas');
const { connectionCreateTypes, connectionMenuDescriptionKey, connectionMenuShowsPlugins, connectionMenuSide, connectionMenuTitleKey, connectionMenuTitleTextKey } = await import(
    '../src/lib/canvas/connection-create-menu'
);

const zh = (await import('../src/i18n/locales/zh-CN')).default as Record<string, any>;
const en = (await import('../src/i18n/locales/en-US')).default as Record<string, any>;

function pick(source: Record<string, any>, path: string): unknown {
    return path.split('.').reduce<any>((acc, key) => (acc == null ? acc : acc[key]), source);
}

test('左侧连接点（target）接上游：标题「引用节点」，列四种节点类型', () => {
    expect(connectionMenuSide('target')).toBe('left');
    expect(connectionMenuTitleKey('left')).toBe('canvas.createMenu.referenceNode');
    expect(pick(zh, 'canvas.createMenu.referenceNode')).toBe('引用节点');

    expect(connectionCreateTypes('left')).toEqual([CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio]);

    // 文案是裸类型名，不带「生成」
    expect(pick(zh, connectionMenuTitleTextKey('left', CanvasNodeType.Text))).toBe('文本');
    expect(pick(zh, connectionMenuTitleTextKey('left', CanvasNodeType.Image))).toBe('图片');
    expect(pick(zh, connectionMenuTitleTextKey('left', CanvasNodeType.Video))).toBe('视频');
    expect(pick(zh, connectionMenuTitleTextKey('left', CanvasNodeType.Audio))).toBe('音频');
});

test('左侧菜单不再出现「音色设计/音频生成」，也不带副标题', () => {
    expect(connectionCreateTypes('left')).not.toContain(CanvasNodeType.VoiceDesign);
    for (const type of connectionCreateTypes('left')) {
        expect(connectionMenuDescriptionKey('left', type)).toBeNull();
    }
});

test('右侧连接点（source）往下游生成：标题保留「引用该节点生成」，无音频参考', () => {
    expect(connectionMenuSide('source')).toBe('right');
    expect(connectionMenuTitleKey('right')).toBe('canvas.createMenu.fromNode');
    expect(pick(zh, 'canvas.createMenu.fromNode')).toBe('引用该节点生成');

    expect(connectionCreateTypes('right')).toEqual([CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.VoiceDesign]);

    expect(pick(zh, connectionMenuTitleTextKey('right', CanvasNodeType.Text))).toBe('文本生成');
    expect(pick(zh, connectionMenuTitleTextKey('right', CanvasNodeType.Image))).toBe('图片生成');
    expect(pick(zh, connectionMenuTitleTextKey('right', CanvasNodeType.Video))).toBe('视频生成');
    expect(pick(zh, connectionMenuTitleTextKey('right', CanvasNodeType.VoiceDesign))).toBe('音频生成');

    // 旧的「音频参考」入口已移除，普通音频节点只在左侧 / 工具栏出现
    expect(connectionCreateTypes('right')).not.toContain(CanvasNodeType.Audio);
});

test('插件只在左侧出现，右侧菜单没有插件分组', () => {
    expect(connectionMenuShowsPlugins('left')).toBe(true);
    expect(connectionMenuShowsPlugins('right')).toBe(false);
});

test('两侧副标题都只在右侧的「文本生成 / 音频生成」上出现', () => {
    expect(connectionMenuDescriptionKey('right', CanvasNodeType.Text)).toBe('canvas.createMenu.textDescription');
    expect(connectionMenuDescriptionKey('right', CanvasNodeType.VoiceDesign)).toBe('canvas.createMenu.audioGenerateDescription');
    expect(connectionMenuDescriptionKey('right', CanvasNodeType.Image)).toBeNull();
    expect(connectionMenuDescriptionKey('right', CanvasNodeType.Video)).toBeNull();
});

test('zh-CN 与 en-US 的菜单 key 齐备', () => {
    const keys = ['canvas.createMenu.fromNode', 'canvas.createMenu.referenceNode', 'canvas.createMenu.text', 'canvas.createMenu.textDescription', 'canvas.createMenu.image', 'canvas.createMenu.video', 'canvas.createMenu.audioGenerate', 'canvas.createMenu.audioGenerateDescription', 'canvas.createMenu.config', 'canvas.createMenu.plugins'];
    for (const key of keys) {
        expect(typeof pick(zh, key)).toBe('string');
        expect(typeof pick(en, key)).toBe('string');
    }
    // 已删除的「音频参考」key 不应残留
    expect(pick(zh, 'canvas.createMenu.audio')).toBeUndefined();
    expect(pick(en, 'canvas.createMenu.audio')).toBeUndefined();
});
