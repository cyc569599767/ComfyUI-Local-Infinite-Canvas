import { afterAll, expect, test } from 'bun:test';

// video-timeline 经 node-registry / i18n 链会读到 localStorage，测试环境需要桩。
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

const { appendMissingSources, buildMergePayload, buildTimelineFromSources, collectTimelineSources, isTimelineNode, isVideoContent, timelineSeconds, timelinePlaybackSegments, timelinePlaybackSeconds, timelineSignature, moveTimelineClip, orderedTimelineClips } = await import('../src/lib/canvas/video-timeline');
const { CanvasNodeType } = await import('../src/types/canvas');

function node(over: Record<string, unknown>) {
    return {
        id: 'n1',
        type: CanvasNodeType.Video,
        title: '片段',
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: { content: 'blob:a' },
        ...over,
    } as never;
}

test('拖拽插入首尾和中间，不丢裁剪音量或素材身份', () => {
    const clips = buildTimelineFromSources(['A', 'B', 'C'].map(nodeId => ({ nodeId, label: nodeId, url: `blob:${nodeId}`, storageKey: `video:${nodeId}`, duration: 2 })));
    clips[2].inPoint = 0.5; clips[2].volume = 0.4;
    const original = JSON.stringify(clips);
    const first = moveTimelineClip(clips, clips[2].id, 0, 0, 'insert');
    expect(orderedTimelineClips(first).map(c => c.label)).toEqual(['C', 'A', 'B']);
    expect(orderedTimelineClips(first).map(c => c.start)).toEqual([0, 1.5, 3.5]);
    expect(first.find(c => c.label === 'C')).toMatchObject({ storageKey: 'video:C', inPoint: 0.5, outPoint: 2, volume: 0.4 });
    const middle = moveTimelineClip(clips, clips[2].id, 2, 0, 'insert');
    expect(orderedTimelineClips(middle).map(c => c.label)).toEqual(['A', 'C', 'B']);
    expect(orderedTimelineClips(moveTimelineClip(first, clips[2].id, 100, 0, 'insert')).map(c => c.label)).toEqual(['A', 'B', 'C']);
    expect(JSON.stringify(clips)).toBe(original);
});

test('跨轨拖动保留原轨其他镜头位置且轨道范围受限', () => {
    const clips = buildTimelineFromSources(['A', 'B'].map(nodeId => ({ nodeId, label: nodeId, url: nodeId, duration: 2 })));
    const moved = moveTimelineClip(clips, clips[0].id, 0, 99);
    expect(moved[0].track).toBe(2); expect(moved[0].start).toBe(0); expect(moved[1].start).toBe(2);
    expect(moveTimelineClip(moved, clips[0].id, -9, -2)[0]).toMatchObject({ start: 0, track: 0 });
    expect(moveTimelineClip(clips, 'missing', 1, 0)).toBe(clips);
});

test('自由定位允许重叠且不挤开原素材，落位镜头同轨置顶', () => {
    const clips = buildTimelineFromSources(['A', 'B', 'C'].map(nodeId => ({ nodeId, label: nodeId, url: nodeId, duration: 2 })));
    const gap = moveTimelineClip(clips, clips[2].id, 8.24, 0, 'position');
    expect(gap[2].start).toBe(8.2); expect(gap[0].start).toBe(0);
    expect(moveTimelineClip(clips, clips[2].id, 2.1, 0, 'position').find(c => c.label === 'C')?.start).toBe(2);
    const collide = moveTimelineClip(clips, clips[2].id, 0, 0, 'position');
    expect(collide[0]).toBe(clips[0]); expect(collide[1]).toBe(clips[1]);
    expect(collide[2].start).toBe(0); expect(collide[2].layer).toBeGreaterThan(3);
    expect(timelinePlaybackSegments(collide)[0].clip?.label).toBe('C');
});

test('多轨重叠由上轨覆盖，时间按绝对起始位置推进', () => {
    const clips = buildTimelineFromSources(['A', 'B'].map(nodeId => ({ nodeId, label: nodeId, url: nodeId, duration: 2 })));
    clips[0].start = 1; clips[1].start = 0; clips[1].track = 1;
    const segments = timelinePlaybackSegments(clips);
    expect(segments.map(s => [s.start,s.duration,s.clip?.label])).toEqual([[0,1,'B'],[1,2,'A']]);
    expect(timelinePlaybackSeconds(clips)).toBe(3);
    clips[0].start = 0; clips[1].track = 0; clips[1].start = 1;
    expect(timelinePlaybackSegments(clips).map(s => [s.start,s.duration,s.clip?.label])).toEqual([[0,1,'A'],[1,2,'B']]);
    expect(timelinePlaybackSeconds(clips)).toBe(3);
    expect(timelineSeconds(clips)).toBe(3);
    expect(timelinePlaybackSeconds([])).toBe(0);
});

test('上层结束后下层按原时间恢复，隐藏边界不切分连续画面', () => {
    const clips = buildTimelineFromSources(['底层', '上层', '隐藏'].map(nodeId => ({nodeId,label:nodeId,url:nodeId,duration:5})));
    clips[0].start=0; clips[0].track=2;
    clips[1].start=1; clips[1].track=0; clips[1].inPoint=1; clips[1].outPoint=3;
    clips[2].start=1.5; clips[2].track=1; clips[2].outPoint=0.5;
    expect(timelinePlaybackSegments(clips).map(s=>[s.start,s.duration,s.clip?.label])).toEqual([[0,1,'底层'],[1,2,'上层'],[3,2,'底层']]);
    expect(timelinePlaybackSeconds(clips)).toBe(5);
});

test('同轨层级与导出layer一致，重复区间和空隙正确', () => {
    const clips = buildTimelineFromSources(['A','B'].map(nodeId=>({nodeId,label:nodeId,url:nodeId,duration:2})));
    clips[0].start=1; clips[1].start=1; clips[0].layer=8;
    expect(timelinePlaybackSegments(clips).map(s=>[s.start,s.duration,s.clip?.label])).toEqual([[0,1,undefined],[1,2,'A']]);
    expect(buildMergePayload(clips).clips.map(c=>c.layer)).toEqual([8,2]);
    expect(timelineSignature(clips)).toStartWith('overlay-v2:');
});

test('预览计划与网关在多轨同层决胜及遮挡恢复上完全一致', async () => {
    const { normalizeMergeClips, resolveTimelineSegments } = await import('../../../comfyui-gateway/src/video-merge.js');
    for (let scenario = 0; scenario < 36; scenario++) {
        const clips = buildTimelineFromSources(Array.from({length:6},(_,i)=>({nodeId:String(i),label:String(i),url:`video-${i}`,duration:4})));
        clips.forEach((clip,i)=>{clip.start=((i*3+scenario)%11)/2;clip.track=(i+scenario)%3;clip.layer=i%2;clip.inPoint=(i%3)/2;clip.outPoint=clip.inPoint+0.5+((scenario+i)%4)/2;});
        const payload = buildMergePayload(clips);
        const plan = resolveTimelineSegments(normalizeMergeClips(payload.clips));
        const front = timelinePlaybackSegments(clips).map(s=>({start:s.start,duration:s.duration,index:s.clip?clips.indexOf(s.clip):undefined,inPoint:s.clip?s.clip.inPoint+s.start-s.clip.start:undefined}));
        const back = plan.map((s: {start:number;duration:number;clip?:{index:number};inPoint?:number})=>({start:s.start,duration:s.duration,index:s.clip?.index,inPoint:s.inPoint}));
        expect(front).toEqual(back);
    }
});

test('成片签名跟随编辑变化而不受blob地址刷新影响', () => {
    const clips = buildTimelineFromSources([{nodeId:'A',label:'A',url:'blob:old',storageKey:'video:A',duration:2}]);
    const original = timelineSignature(clips);
    expect(timelineSignature([{...clips[0],url:'blob:new'}])).toBe(original);
    for (const patch of [{start:1},{track:1},{inPoint:0.2},{outPoint:1.8},{volume:0.3},{storageKey:'video:B'}]) expect(timelineSignature([{...clips[0],...patch}])).not.toBe(original);
});

test('只收集真正有视频内容的卡片', () => {
    // 踩过：把「视频节点但还没出片」也算进时间线，导出时得到一堆空片段。
    const nodes = [
        node({ id: 'v1', position: { x: 0, y: 0 }, metadata: { content: 'blob:a', mimeType: 'video/mp4', durationMs: 4000 } }),
        node({ id: 'v2', position: { x: 0, y: 300 }, metadata: { content: '', status: 'loading' } }),
        node({ id: 'v3', type: CanvasNodeType.Image, metadata: { content: 'blob:img', mimeType: 'image/png' } }),
        node({ id: 'v4', metadata: { content: 'https://cdn/x.mp4' } }),
    ];
    const sources = collectTimelineSources(nodes);
    expect(sources.map((item) => item.nodeId)).toEqual(['v1', 'v4']);
    expect(sources[0].duration).toBe(4);
    // 时长探测不到时给兜底值，否则 0 秒片段会被网关当成空片段。
    expect(sources[1].duration).toBe(5);
});
test('按画布位置排序，而不是创建顺序', () => {
    // 分镜卡是竖着一列建的，按 (y, x) 排才是用户看到的顺序。
    const nodes = [
        node({ id: 'c', position: { x: 0, y: 600 }, metadata: { content: 'blob:c' } }),
        node({ id: 'a', position: { x: 0, y: 0 }, metadata: { content: 'blob:a' } }),
        node({ id: 'b', position: { x: 0, y: 300 }, metadata: { content: 'blob:b' } }),
    ];
    expect(collectTimelineSources(nodes).map((item) => item.nodeId)).toEqual(['a', 'b', 'c']);
});

test('排除工作台自身所在的卡片', () => {
    const nodes = [node({ id: 'self', metadata: { content: 'blob:self' } }), node({ id: 'other', metadata: { content: 'blob:o' } })];
    expect(collectTimelineSources(nodes, 'self').map((item) => item.nodeId)).toEqual(['other']);
});

test('素材首尾相接铺满轨道 0', () => {
    const clips = buildTimelineFromSources([
        { nodeId: 'a', label: 'A', url: 'blob:a', duration: 2 },
        { nodeId: 'b', label: 'B', url: 'blob:b', duration: 3 },
    ]);
    expect(clips.map((clip) => clip.start)).toEqual([0, 2]);
    expect(clips.every((clip) => clip.track === 0 && clip.inPoint === 0)).toBe(true);
    expect(timelineSeconds(clips)).toBe(5);
});

test('追加导入只补新素材，不动用户改过的裁剪', () => {
    const initial = buildTimelineFromSources([{ nodeId: 'a', label: 'A', url: 'blob:a', duration: 2 }]);
    // 用户把 A 裁短了一半。
    initial[0].outPoint = 1;
    const result = appendMissingSources(initial, [
        { nodeId: 'a', label: 'A', url: 'blob:a', duration: 2 },
        { nodeId: 'b', label: 'B', url: 'blob:b', duration: 3 },
    ]);
    expect(result.added).toBe(1);
    expect(result.clips[0].outPoint).toBe(1);
    // 新片段接在裁剪后的末尾（1s），而不是原始时长之后。
    expect(result.clips[1].start).toBe(1);
});

test('同一素材的 URL 变了但 storageKey 相同，仍算同一段', () => {
    const clips = buildTimelineFromSources([{ nodeId: 'a', label: 'A', url: 'blob:a', storageKey: 'video:1', duration: 2 }]);
    const result = appendMissingSources(clips, [{ nodeId: 'a', label: 'A', url: 'http://gw/a.mp4', storageKey: 'video:1', duration: 2 }]);
    expect(result.added).toBe(0);
});

test('合并描述保留叠放决胜顺序，同一素材只上传一次', () => {
    const clips = [
        { id: 'c1', url: 'blob:a', label: 'A', start: 5, duration: 5, inPoint: 0, outPoint: 5, track: 1, volume: 1 },
        { id: 'c2', url: 'blob:b', label: 'B', start: 0, duration: 3, inPoint: 0, outPoint: 3, track: 0, volume: 1 },
        // 同一素材的第二段（裁掉了尾部）。
        { id: 'c3', url: 'blob:b', label: 'B2', start: 3, duration: 3, inPoint: 0, outPoint: 2, track: 0, volume: 0.5 },
    ];
    const payload = buildMergePayload(clips);
    expect(payload.sources.length).toBe(2);
    expect(payload.clips.map((clip) => clip.source)).toEqual([0, 1, 1]);
    expect(payload.clips.map((clip) => clip.outPoint)).toEqual([5, 3, 2]);
    // Global timeline runs from 0 to 10; tracks no longer append extra time.
    expect(payload.totalSeconds).toBe(10);
});

test('出点小于入点时会兜住，避免网关 trim 出空片段', () => {
    const payload = buildMergePayload([
        { id: 'c1', url: 'blob:a', label: 'A', start: 0, duration: 1, inPoint: 2, outPoint: 1, track: 0, volume: 1 },
    ]);
    expect(payload.clips[0].outPoint).toBeGreaterThan(payload.clips[0].inPoint);
});

test('isVideoContent 只在明确是视频时返回 true', () => {
    expect(isVideoContent({ content: 'x.mp4' } as never)).toBe(true);
    expect(isVideoContent({ content: 'x.png' } as never)).toBe(false);
    expect(isVideoContent({ content: 'blob:abc', mimeType: 'video/webm' } as never)).toBe(true);
    expect(isVideoContent({ content: 'blob:abc', mimeType: 'image/png' } as never)).toBe(false);
    expect(isVideoContent({} as never)).toBe(false);
});

test('视频节点即使没有扩展名也能进时间线', () => {
    // 生成结果常常是 blob: 或网关直链，靠 .mp4 后缀判断会漏掉全部真实产出。
    expect(isTimelineNode(node({ id: 'v', metadata: { content: 'blob:xyz' } }))).toBe(true);
    // 图片节点不能因为 content 存在就混进来。
    expect(isTimelineNode(node({ id: 'i', type: CanvasNodeType.Image, metadata: { content: 'blob:i' } }))).toBe(false);
    expect(isTimelineNode(node({ id: 'e', metadata: {} }))).toBe(false);
});
