'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    AGENT_PANEL_POSITION_KEY,
    agentPanelSize,
    anchorAgentPanelPosition,
    clampAgentPanelPosition,
    parseAgentPanelPosition,
} = require('../../infinite-canvas/web/src/lib/agent-panel-position.ts');

function assertContained(position, viewport) {
    const size = agentPanelSize(viewport);
    assert.ok(position.x >= 0 && position.y >= 0);
    assert.ok(position.x + size.width <= viewport.width);
    assert.ok(position.y + size.height <= viewport.height);
    assert.ok(size.width <= Math.max(0, viewport.width - 16));
    assert.ok(size.height <= Math.max(0, viewport.height - 16));
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
}

test('panel uses a separate persistence key from the pet', () => {
    assert.equal(AGENT_PANEL_POSITION_KEY, 'canvas-agent-panel-position');
});

test('desktop dimensions are capped without imposing a minimum', () => {
    assert.deepEqual(agentPanelSize({ width: 1920, height: 1080 }), { width: 460, height: 680 });
    assert.deepEqual(agentPanelSize({ width: 320, height: 480 }), { width: 304, height: 464 });
    assert.deepEqual(agentPanelSize({ width: 180, height: 120 }), { width: 164, height: 104 });
});

test('clamps every edge of the entire panel with an eight-pixel margin', () => {
    const viewport = { width: 1280, height: 960 };
    assert.deepEqual(clampAgentPanelPosition({ x: -100, y: -200 }, viewport), { x: 8, y: 8 });
    assert.deepEqual(clampAgentPanelPosition({ x: 2000, y: 2000 }, viewport), { x: 812, y: 272 });
    assert.deepEqual(clampAgentPanelPosition({ x: 120, y: 130 }, viewport), { x: 120, y: 130 });
});

test('tiny and zero-size viewports never produce negative dimensions or offscreen geometry', () => {
    for (const width of [0, 1, 8, 15, 16, 17, 60, 200, 320]) {
        for (const height of [0, 1, 8, 15, 16, 17, 60, 200, 320]) {
            const viewport = { width, height };
            for (const position of [{ x: -100, y: -100 }, { x: 1000, y: 1000 }, { x: NaN, y: Infinity }]) {
                assertContained(clampAgentPanelPosition(position, viewport), viewport);
            }
        }
    }
});

test('malformed saved positions are ignored rather than coerced', () => {
    for (const value of [null, '', 'broken', 'null', '[]', '[1,2]', '5', 'true', '{}', '{"x":2}', '{"y":3}', '{"x":"2","y":3}', '{"x":null,"y":3}', '{"x":2,"y":false}', '{"x":1e400,"y":3}']) {
        assert.equal(parseAgentPanelPosition(value), null, String(value));
    }
});

test('valid saved coordinates preserve precision, ignore extra fields and can be reclamped', () => {
    assert.deepEqual(parseAgentPanelPosition('{"x":15.5,"y":23.75,"extra":"ignored"}'), { x: 15.5, y: 23.75 });
    const position = parseAgentPanelPosition('{"x":-500,"y":999999}');
    assert.deepEqual(clampAgentPanelPosition(position, { width: 800, height: 900 }), { x: 8, y: 212 });
});

test('viewport shrink reclamps saved position and round-trips the new persisted coordinates', () => {
    const original = { x: 1300, y: 650 };
    const smaller = { width: 900, height: 750 };
    const next = clampAgentPanelPosition(original, smaller);
    assert.deepEqual(next, { x: 432, y: 62 });
    assertContained(next, smaller);
    const saved = parseAgentPanelPosition(JSON.stringify(next));
    assert.deepEqual(clampAgentPanelPosition(saved, { width: 1920, height: 1080 }), next);
    assert.deepEqual(clampAgentPanelPosition(next, { width: 200, height: 120 }), { x: 8, y: 8 });
});

test('default panel anchor chooses the available side of the pet and stays in viewport', () => {
    const viewport = { width: 1280, height: 1200 };
    assert.deepEqual(anchorAgentPanelPosition({ x: 900, y: 1000 }, viewport), { x: 552, y: 308 });
    assert.deepEqual(anchorAgentPanelPosition({ x: 900, y: 30 }, viewport), { x: 552, y: 154 });
    for (const small of [{ width: 180, height: 100 }, { width: 0, height: 0 }, { width: 1280, height: 720 }]) {
        assertContained(anchorAgentPanelPosition({ x: 1000, y: 900 }, small), small);
    }
});

test('independently positioned panel geometry does not depend on subsequent pet moves', () => {
    const viewport = { width: 1280, height: 1200 };
    const dragged = { x: 100, y: 200 };
    assert.notDeepEqual(anchorAgentPanelPosition({ x: 100, y: 100 }, viewport), anchorAgentPanelPosition({ x: 900, y: 1000 }, viewport));
    assert.deepEqual(clampAgentPanelPosition(dragged, viewport), dragged);
});

test('invalid runtime coordinates and viewport dimensions cannot propagate NaN', () => {
    assert.deepEqual(clampAgentPanelPosition({ x: NaN, y: -Infinity }, { width: 1280, height: 720 }), { x: 8, y: 8 });
    for (const viewport of [{ width: NaN, height: Infinity }, { width: -20, height: -30 }]) {
        assert.deepEqual(agentPanelSize(viewport), { width: 0, height: 0 });
        assert.deepEqual(clampAgentPanelPosition({ x: 500, y: 500 }, viewport), { x: 0, y: 0 });
    }
});
