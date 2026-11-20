import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { creationPreviewText } from "../src/lib/agent/creation-preview";
import type { CreationStageId } from "../src/lib/agent/creation-pipeline";
import type { CanvasNodeData, CanvasNodeMetadata } from "../src/types/canvas";

function node(id: string, type: string, stage: CreationStageId, metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { creationOutput: { projectNodeId: "host", stage }, ...metadata } };
}

function videoFixture() {
    const host: CanvasNodeData = {
        id: "host", type: "workbench", title: "项目", position: { x: 0, y: 0 }, width: 300, height: 200,
        metadata: { creationPipeline: { version: 1, completed: [], plan: {
            assets: [], shots: [{ id: "shot", label: "镜头", referenceIds: [], promptNodeId: "prompt", videoNodeId: "video" }], voiceIds: [], musicIds: [], omitted: {},
        } } },
    };
    const video = node("video", "video", "pipeline");
    const prompt = node("prompt", "text", "video_prompt", { content: "  正式视频提示词\n完整正文  " });
    return { host, video, prompt, nodes: [host, video, prompt] };
}

test("生成时保存的提示词优先，全文和空白不裁剪", () => {
    const prompt = `  首行\n${"长提示词与连续内容".repeat(2000)}\n末行  `;
    const image = node("image", "image", "character", { prompt, generationInputPrompt: "展开前输入", content: "blob:图片结果" });
    expect(creationPreviewText(image)).toMatchObject({ prompt, source: "prompt", label: "原提示词" });
});

test("仅提示词缺失或全空白时回退到原始生成输入", () => {
    for (const prompt of [undefined, "", " \n\t "]) {
        const image = node("image", "image", "character", { prompt, generationInputPrompt: "  原始输入\n第二行  " });
        expect(creationPreviewText(image)).toMatchObject({ prompt: "  原始输入\n第二行  ", source: "generationInputPrompt" });
    }
});

test("视频已保存的记录不被当前关联提示词覆盖", () => {
    const { video, nodes } = videoFixture();
    video.metadata!.prompt = "生成时提示词";
    video.metadata!.generationInputPrompt = "生成时输入";
    expect(creationPreviewText(video, nodes)).toMatchObject({ prompt: "生成时提示词", source: "prompt" });
    delete video.metadata!.prompt;
    expect(creationPreviewText(video, nodes)).toMatchObject({ prompt: "生成时输入", source: "generationInputPrompt" });
});

test("无保存记录的视频只读取本项目正式绑定来源并明确标注", () => {
    const { video, prompt, nodes } = videoFixture();
    expect(creationPreviewText(video, nodes)).toMatchObject({ prompt: prompt.metadata!.content, source: "video_prompt", label: "关联提示词（尚无生成记录）" });
});

test("历史、未采用和候选视频不套用当前正式来源", () => {
    for (const revisionKind of ["history", "discarded", "candidate"] as const) {
        const { video, nodes } = videoFixture();
        video.metadata!.creationOutput!.revisionKind = revisionKind;
        video.metadata!.creationOutput!.revisionOf = "video";
        expect(creationPreviewText(video, nodes)).toMatchObject({ prompt: "", source: "missing" });
        video.metadata!.prompt = "该版本自己的原提示词";
        expect(creationPreviewText(video, nodes).prompt).toBe("该版本自己的原提示词");
    }
});

test("跨项目、非正式、失效或错误类型的视频来源不展示", () => {
    const cases: Array<(source: CanvasNodeData) => void> = [
        source => { source.metadata!.creationOutput!.projectNodeId = "other-project"; },
        source => { source.metadata!.creationOutput!.stage = "storyboard"; },
        source => { source.metadata!.creationOutput!.revisionKind = "history"; },
        source => { source.metadata!.creationOutput!.revisionKind = "discarded"; },
        source => { source.metadata!.creationOutput!.revisionKind = "candidate"; },
        source => { source.metadata!.creationOutput!.needsRevision = true; },
        source => { source.type = "video"; },
        source => { source.metadata!.content = " \n "; },
    ];
    for (const change of cases) {
        const { video, prompt, nodes } = videoFixture();
        change(prompt);
        expect(creationPreviewText(video, nodes)).toMatchObject({ prompt: "", source: "missing" });
    }
});

test("缺少项目、计划绑定或来源不猜测其它视频的提示词", () => {
    const { video, nodes, host } = videoFixture();
    expect(creationPreviewText(video, nodes.filter(n => n.id !== "host")).source).toBe("missing");
    expect(creationPreviewText(video, nodes.filter(n => n.id !== "prompt")).source).toBe("missing");
    host.metadata!.creationPipeline!.plan!.shots[0].videoNodeId = "another-video";
    expect(creationPreviewText(video, nodes).source).toBe("missing");
    delete host.metadata!.creationPipeline!.plan;
    expect(creationPreviewText(video, nodes).source).toBe("missing");
});

test("只有总流水线视频可以使用正式视频提示词回退", () => {
    const { video, nodes } = videoFixture();
    video.type = "image";
    expect(creationPreviewText(video, nodes).source).toBe("missing");
    video.type = "video";
    video.metadata!.creationOutput!.stage = "character";
    expect(creationPreviewText(video, nodes).source).toBe("missing");
    video.metadata!.creationOutput = undefined;
    expect(creationPreviewText(video, nodes).source).toBe("missing");
});

test("音色原文与音色描述独立展示，不用描述冒充原提示词", () => {
    const voice = node("voice", "audio", "voice", { prompt: "朗读这句台词", audioVoiceDescription: "  低沉\n舒缓  " });
    expect(creationPreviewText(voice)).toMatchObject({ prompt: "朗读这句台词", details: [{ label: "音色描述", text: "  低沉\n舒缓  " }] });
    delete voice.metadata!.prompt;
    expect(creationPreviewText(voice)).toMatchObject({ prompt: "", source: "missing", details: [{ label: "音色描述", text: "  低沉\n舒缓  " }] });
    delete voice.metadata!.audioVoiceDescription;
    expect(creationPreviewText(voice).details).toEqual([{ label: "音色描述", text: "未保存音色描述。" }]);
});

test("音乐保留完整歌词，明确空值为纯器乐，缺失记录不捏造", () => {
    const music = node("music", "audio", "music", { prompt: "舒缓配乐", audioLyrics: "  第一段\n\n第二段  " });
    expect(creationPreviewText(music).details).toEqual([{ label: "歌词", text: "  第一段\n\n第二段  " }]);
    for (const audioLyrics of ["", " \n "]) {
        music.metadata!.audioLyrics = audioLyrics;
        expect(creationPreviewText(music).details).toEqual([{ label: "歌词", text: "纯器乐（无歌词）" }]);
    }
    delete music.metadata!.audioLyrics;
    expect(creationPreviewText(music).details).toEqual([{ label: "歌词", text: "未保存歌词记录。" }]);
});

test("缺失记录返回占位状态，不拿媒体URL、标题或修改要求填充", () => {
    const image = node("image", "image", "character", { content: "blob:结果", composerContent: "当前草稿", generationInputPrompt: "  " });
    image.metadata!.creationOutput!.feedback = "重做要求";
    expect(creationPreviewText(image)).toEqual({ prompt: "", source: "missing", label: "原提示词", details: [] });
    expect(creationPreviewText()).toEqual({ prompt: "", source: "missing", label: "原提示词", details: [] });
});

test("预览解析不修改节点或项目状态", () => {
    const { video, nodes } = videoFixture();
    const before = structuredClone(nodes);
    creationPreviewText(video, nodes);
    expect(nodes).toEqual(before);
});

test("选中预览左右顺序、窄屏单列、只读可选择和滚动全文保持", () => {
    const source = readFileSync(new URL("../src/components/canvas/creation-output-review-panel.tsx", import.meta.url), "utf8");
    const preview = source.slice(source.indexOf("<div data-creation-selected-preview"), source.indexOf("</details>", source.indexOf("<div data-creation-selected-preview")));
    expect(preview).toContain("grid-cols-1");
    expect(preview).toContain("sm:grid-cols-2");
    expect(preview.indexOf("data-creation-preview-media")).toBeLessThan(preview.indexOf("data-creation-preview-prompt"));
    expect(preview).toContain("data-prompt-source={previewText.source}");
    expect(preview).toContain("{previewText.prompt}");
    expect(preview).toContain("{detail.text}");
    for (const feature of ["select-text", "max-h-64", "overflow-y-auto", "whitespace-pre-wrap", "[overflow-wrap:anywhere]", "tabIndex={0}", "theme.node.stroke", "theme.node.fill", "theme.node.text", "theme.node.muted", "未保存原提示词记录。"] ) expect(preview).toContain(feature);
    for (const forbidden of ["truncate", "line-clamp", ".slice(", "TextArea", "contentEditable", "dangerouslySetInnerHTML", "onChange"]) expect(preview).not.toContain(forbidden);
    expect(source).toContain('<div className="grid gap-2 sm:grid-cols-2"><Preview node={source} label="原版（尚未替换）" /><Preview node={candidate} label="重生成候选" /></div>');
    expect(source).toContain('history.slice(-5).map(n=><Preview key={n.id} node={n} label={n.title} />)');
});
