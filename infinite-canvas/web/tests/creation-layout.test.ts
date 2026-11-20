import { afterAll, expect, test } from "bun:test";
import { CREATION_STAGES } from "../src/lib/agent/creation-pipeline";
import { layoutCreationProject, creationLayoutSections } from "../src/lib/agent/creation-layout";
import { buildConnectionRoute, buildCreationConnectionRoute, connectionIntersectsView } from "../src/lib/canvas/connection-route";
const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
afterAll(() => { if (storage) Object.defineProperty(globalThis, "localStorage", storage); else Reflect.deleteProperty(globalThis, "localStorage"); });
const { applyCanvasAgentOps } = await import("../src/lib/canvas/canvas-agent-ops");
const { getGenerationResourceNodes, resolveCanvasBaseImage } = await import("../src/lib/canvas/canvas-resource-references");
import type { CanvasNodeData, CanvasConnection } from "../src/types/canvas";
const host: CanvasNodeData = { id: "wb", type: "workbench", title: "项目", position: { x: -100, y: -200 }, width: 360, height: 220, metadata: { workbenchKind: "agent-creation" } };
const product = (id: string, stage = "character", width = 340, height = 240): CanvasNodeData => ({ id, type: "image", title: id, position: { x: 0, y: 0 }, width, height, metadata: { status: "success", content: "data:image/png;base64,AA==", creationOutput: { projectNodeId: "wb", stage: stage as any } } });
function overlap(a: CanvasNodeData, b: CanvasNodeData) { return a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x && a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y; }
function crosses(a: {x:number;y:number}, b: {x:number;y:number}, n: CanvasNodeData) {
    if (a.x === b.x) return a.x > n.position.x && a.x < n.position.x + n.width && Math.min(a.y,b.y) < n.position.y+n.height && Math.max(a.y,b.y)>n.position.y;
    if (a.y === b.y) return a.y > n.position.y && a.y < n.position.y + n.height && Math.min(a.x,b.x)<n.position.x+n.width && Math.max(a.x,b.x)>n.position.x;
    return false;
}
test("12阶段纵向排序，阶段内4列横排换行，尺寸各异仍不重叠", () => {
    const nodes = [host, ...CREATION_STAGES.flatMap((s, i) => Array.from({ length: 5 }, (_, j) => product(`${s.id}-${j}`, s.id, 240 + j * 80, 130 + i * 20 + j * 70)))];
    const result = layoutCreationProject(nodes, [], "wb");
    const sections = creationLayoutSections(result.nodes);
    expect(sections).toHaveLength(12);
    for (let i = 1; i < sections.length; i++) expect(sections[i].y).toBeGreaterThan(sections[i - 1].y + sections[i - 1].height);
    for (const section of sections) {
        expect(section.nodes[0].position.y).toBe(section.nodes[3].position.y);
        expect(section.nodes[4].position.y).toBeGreaterThan(section.nodes[0].position.y);
        expect(section.nodes[4].position.x).toBe(section.nodes[0].position.x);
    }
    for (let i = 0; i < result.nodes.length; i++) for (let j = i + 1; j < result.nodes.length; j++) expect(overlap(result.nodes[i], result.nodes[j])).toBe(false);
    expect(result.nodes[0]).toBe(host);
});
test("按计划ID顺序而非生成到达顺序；跨批稳定且重复整理幂等", () => {
    const root = { ...host, metadata: { ...host.metadata, creationPipeline: { version: 1 as const, completed: [], plan: { assets: ["b", "a", "c"].map((id) => ({ id, kind: "character" as const, label: id })), shots: [], voiceIds: [], musicIds: [], omitted: {} } } } };
    const first = layoutCreationProject([root, product("a"), product("b")], [], "wb");
    const second = layoutCreationProject([...first.nodes, product("c")], first.connections, "wb");
    expect(second.nodes.find((n) => n.id === "b")!.position.x).toBeLessThan(second.nodes.find((n) => n.id === "a")!.position.x);
    expect(second.nodes.find((n) => n.id === "a")!.position).toEqual(first.nodes.find((n) => n.id === "a")!.position);
    const again = layoutCreationProject(second.nodes, second.connections, "wb");
    expect(again.nodes).toBe(second.nodes); expect(again.connections).toBe(second.connections);
});
test("无关项目位置、尺寸、生成内容和原始参考边顺序不变", () => {
    const outsider = { ...product("other"), position: { x: -100, y: 250 }, metadata: { ...product("other").metadata, creationOutput: { projectNodeId: "another", stage: "character" as const } } };
    const refs: CanvasConnection[] = [{ id: "r1", fromNodeId: "c", toNodeId: "v" }, { id: "r2", fromNodeId: "b", toNodeId: "v" }];
    const products = [product("b"), product("c"), { ...product("v", "pipeline"), type: "video" }];
    const result = layoutCreationProject([host, outsider, ...products], refs, "wb");
    expect(result.nodes[1]).toBe(outsider);
    expect(result.connections.slice(0, 2)).toEqual(refs);
    for (const original of products) {
        const n = result.nodes.find((n) => n.id === original.id)!;
        expect(n.metadata).toBe(original.metadata); expect(n.width).toBe(original.width); expect(n.height).toBe(original.height);
        expect(overlap(n, outsider)).toBe(false);
    }
    expect(getGenerationResourceNodes("v", result.nodes, result.connections).map((n) => n.id)).toEqual(["c", "b"]);
});
test("展示边不作为生成输入或局部编辑底图", () => {
    const a = product("a"); const b = { ...product("b"), metadata: { creationOutput: { projectNodeId: "wb", stage: "character" as const } } };
    const result = layoutCreationProject([host, a, b], [], "wb");
    expect(result.connections.every((c) => c.role === "lineage")).toBe(true);
    expect(getGenerationResourceNodes("b", result.nodes, result.connections)).toHaveLength(0);
    expect(resolveCanvasBaseImage(result.nodes[2], result.nodes, result.connections)).toBeNull();
});
test("创作连线沿行间和外侧通道，不穿过产物；普通连线保持原贝塞尔", () => {
    const nodes = [host, ...CREATION_STAGES.flatMap((s) => Array.from({ length: 5 }, (_, i) => product(`${s.id}-${i}`, s.id, 340, 180 + i * 40)))];
    const refs: CanvasConnection[] = [{ id: "ref", fromNodeId: "character-1", toNodeId: "pipeline-2" }];
    const result = layoutCreationProject(nodes, refs, "wb");
    for (const c of result.connections) {
        const from = result.nodes.find((n) => n.id === c.fromNodeId)!; const to = result.nodes.find((n) => n.id === c.toNodeId)!;
        const route = buildCreationConnectionRoute(from, to, c, result.nodes);
        expect(route.creation).toBe(true);
        for (let i = 1; i < route.points!.length; i++) for (const n of result.nodes) expect(crosses(route.points![i - 1], route.points![i], n)).toBe(false);
        expect(connectionIntersectsView(route.bounds, route.bounds)).toBe(true);
    }
    const plain = { ...product("plain"), metadata: undefined };
    expect(buildCreationConnectionRoute(plain, host, { id: "plain-edge", fromNodeId: plain.id, toNodeId: host.id }, [plain, host])).toEqual(buildConnectionRoute(plain, host));
});
test("一次内部布局操作可整理超过48产物且保留选择视口，真实参考升级保序", () => {
    const nodes = [host, ...Array.from({ length: 80 }, (_, i) => product(`a${i}`))];
    const snapshot = { projectId: "canvas", title: "画布", nodes, connections: [{ id: "old-flow", fromNodeId: "a1", toNodeId: "a2", role: "lineage" as const, creationProjectId: "wb" }], selectedNodeIds: ["a1"], viewport: { x: 3, y: 4, k: 0.7 } };
    const result = applyCanvasAgentOps(snapshot, [{ type: "layout_creation", projectNodeId: "wb" }]);
    expect(result.nodes).toHaveLength(81); expect(result.selectedNodeIds).toEqual(["a1"]); expect(result.viewport).toEqual(snapshot.viewport);
    const upgraded = applyCanvasAgentOps(result, [{ type: "connect_nodes", fromNodeId: "a0", toNodeId: "a2" }, { type: "connect_nodes", fromNodeId: "a1", toNodeId: "a2" }]);
    expect(upgraded.connections.filter((c) => c.toNodeId === "a2" && c.role !== "lineage").map((c) => c.fromNodeId)).toEqual(["a0", "a1"]);
});
