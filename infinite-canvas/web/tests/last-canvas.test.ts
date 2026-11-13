import { beforeEach, expect, test } from 'bun:test';

// 「关掉软件再打开，默认回到上次的画布」。
// 两个容易做错的点，这里都锁住：
// 1. 画布已被删除时必须回落到首页，不能跳到一个不存在的路由
// 2. 自动恢复每个会话只能做一次，否则首页入口会被永久弹走

const localStore = new Map<string, string>();
const sessionStore = new Map<string, string>();
Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
        localStorage: {
            getItem: (k: string) => localStore.get(k) ?? null,
            setItem: (k: string, v: string) => localStore.set(k, v),
            removeItem: (k: string) => localStore.delete(k),
        },
        sessionStorage: {
            getItem: (k: string) => sessionStore.get(k) ?? null,
            setItem: (k: string, v: string) => sessionStore.set(k, v),
            removeItem: (k: string) => sessionStore.delete(k),
        },
    },
});

const {
    LAST_CANVAS_KEY,
    forgetLastCanvas,
    hasResumedThisSession,
    markResumedThisSession,
    readLastCanvas,
    rememberLastCanvas,
    resolveResumeCanvasId,
} = await import('../src/lib/canvas/last-canvas');

beforeEach(() => {
    localStore.clear();
    sessionStore.clear();
});

test('记住并读回最后打开的画布', () => {
    expect(readLastCanvas()).toBe('');
    rememberLastCanvas('canvas-a');
    expect(readLastCanvas()).toBe('canvas-a');
    expect(localStore.get(LAST_CANVAS_KEY)).toBe('canvas-a');
});

test('空白 id 不覆盖已有记录', () => {
    rememberLastCanvas('canvas-a');
    rememberLastCanvas('');
    rememberLastCanvas('   ');
    expect(readLastCanvas()).toBe('canvas-a');
});

test('切换画布会覆盖记录，只保留最后一次', () => {
    rememberLastCanvas('canvas-a');
    rememberLastCanvas('canvas-b');
    expect(readLastCanvas()).toBe('canvas-b');
});

test('画布还在时恢复它', () => {
    expect(resolveResumeCanvasId('canvas-a', ['canvas-a', 'canvas-b'])).toBe('canvas-a');
});

test('画布已被删除时回落到首页', () => {
    // 记录还指向已删除的画布：不能跳过去，否则会先到空路由再被重定向，闪一下更难看
    expect(resolveResumeCanvasId('gone', ['canvas-a'])).toBe('');
});

test('没有记录或没有画布时不恢复', () => {
    expect(resolveResumeCanvasId('', ['canvas-a'])).toBe('');
    expect(resolveResumeCanvasId('canvas-a', [])).toBe('');
});

test('每个会话只自动恢复一次，避免首页入口被弹走', () => {
    // 首次进入会话：允许恢复
    expect(hasResumedThisSession()).toBe(false);
    markResumedThisSession();
    // 之后用户主动点顶部 logo / 画布里的「主页」，不该再被弹回画布
    expect(hasResumedThisSession()).toBe(true);
});

test('恢复标记走 sessionStorage，关掉软件重开会重新恢复', () => {
    markResumedThisSession();
    expect(hasResumedThisSession()).toBe(true);
    // 新会话 = sessionStorage 清空（浏览器/桌面端关闭后行为），此时应重新允许恢复
    sessionStore.clear();
    expect(hasResumedThisSession()).toBe(false);
});

test('恢复标记不影响最后画布的持久化', () => {
    rememberLastCanvas('canvas-a');
    markResumedThisSession();
    // 关掉重开：session 标记没了，但 localStorage 里的画布记录还在
    sessionStore.clear();
    expect(hasResumedThisSession()).toBe(false);
    expect(readLastCanvas()).toBe('canvas-a');
    expect(resolveResumeCanvasId(readLastCanvas(), ['canvas-a'])).toBe('canvas-a');
});

test('forgetLastCanvas 清掉记录后不再恢复', () => {
    rememberLastCanvas('canvas-a');
    forgetLastCanvas();
    expect(readLastCanvas()).toBe('');
    expect(resolveResumeCanvasId(readLastCanvas(), ['canvas-a'])).toBe('');
});

test('storage 抛错时不崩溃（隐私模式）', () => {
    const original = (globalThis as any).window;
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            get localStorage() { throw new Error('denied'); },
            get sessionStorage() { throw new Error('denied'); },
        },
    });
    try {
        expect(() => rememberLastCanvas('x')).not.toThrow();
        expect(readLastCanvas()).toBe('');
        // 存不了就当作已恢复，宁可这次不跳转，也不要把首页锁死
        expect(hasResumedThisSession()).toBe(true);
        expect(() => markResumedThisSession()).not.toThrow();
    } finally {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: original });
    }
});
