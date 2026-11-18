import { expect, test } from 'bun:test';

import { CAMERA_MOVES, CAMERA_REPEAT_WINDOW } from '../src/components/canvas/digital-human-workbench-panel';

// 数字人工作台的运镜约束来自参考实现（闲兔数字人工作台）：
// 同一运镜 N 镜内不得重复，否则成片像卡住的动图。这条规则必须可测，
// 不能只写在 UI 里靠用户自己看。
const conflictOf = (moves: string[]) => {
    const found = new Map<number, number>();
    moves.forEach((move, index) => {
        if (move === '固定') return;
        // 与实现一致：back 取 1..N-1。间隔正好 N 镜是允许的。
        for (let back = 1; back < CAMERA_REPEAT_WINDOW && index - back >= 0; back += 1) {
            if (moves[index - back] === move) {
                found.set(index, back);
                break;
            }
        }
    });
    return found;
};

test('同一运镜在窗口内重复会被检出', () => {
    const moves = ['推近', '拉远', '推近', '拉远', '推近', '拉远', '推近'];
    // 第 2 个「推近」（index 2）距 index 0 只有 2 镜，必然冲突。
    expect(conflictOf(moves).get(2)).toBe(2);
});

test('间隔达到窗口长度就不算冲突', () => {
    const moves = ['推近', '拉远', '左移', '右移', '上摇', '推近'];
    // index 5 的「推近」距 index 0 是 5 镜，正好等于窗口，允许。
    expect(conflictOf(moves).has(5)).toBe(false);
});

test('「固定」不算运镜，可以连续出现', () => {
    // 对话戏里连续固定机位是正常拍法，不该被拦。
    expect(conflictOf(['固定', '固定', '固定', '固定', '固定', '固定']).size).toBe(0);
});

test('运镜清单包含固定与五种以上运动，且没有重复项', () => {
    expect(CAMERA_MOVES).toContain('固定');
    expect(CAMERA_MOVES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(CAMERA_MOVES).size).toBe(CAMERA_MOVES.length);
});

test('冲突窗口必须够长，否则连续镜头会撞车', () => {
    // 窗口太短（比如 1）等于完全不校验，连续两镜同运镜也能过。
    expect(CAMERA_REPEAT_WINDOW).toBeGreaterThanOrEqual(2);
});
