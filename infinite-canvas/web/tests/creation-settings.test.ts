import { expect, test } from "bun:test";
import { CREATION_RESOLUTIONS, CREATION_STYLE_GROUPS, normalizeCreationResolution } from "../src/lib/agent/creation-settings";
import { creationMediaMetadata, creationWorkflowFor, creationImageSize } from "../src/lib/agent/creation-media";
import { guardCreationOps, inspectCreationStage } from "../src/lib/agent/creation-pipeline";

test("六档分辨率归一化且1080独立选超分模板", () => {
    expect(CREATION_RESOLUTIONS).toEqual(["360p","480p","540p","720p","768p","1080p"]);
    for (const resolution of CREATION_RESOLUTIONS) {
        expect(normalizeCreationResolution(resolution.toUpperCase())).toBe(resolution);
        const metadata = creationMediaMetadata("pipeline", { resolution, aspectRatio: "9:16", backgroundMusic: false }, { model: "wrong", params: { resolution: "wrong", baseModel: "wrong", seed: 123 } });
        expect(metadata.model).toBe(`local-gateway::creation-video-h3-${resolution === "1080p" ? "1080" : "768"}`);
        expect(metadata.params).toEqual({ seed: 123, resolution: resolution.toUpperCase(), aspect_ratio: "9:16" });
        expect(metadata.generateAudio).toBe("true");
    }
});
test("各阶段媒体严格映射参考模板；图像1K与视频档位分离", () => {
    for (const s of ["character","prop","scene"] as const) expect(creationWorkflowFor(s)).toBe("creation-image-krea2");
    for (const s of ["costume","age"] as const) expect(creationWorkflowFor(s)).toBe("creation-image-qwen21-edit");
    expect(creationWorkflowFor("voice")).toBe("creation-audio-voice-design");
    expect(creationWorkflowFor("music")).toBe("creation-audio-music");
    expect(creationImageSize("16:9")).toBe("1344x768");
    expect(creationImageSize("9:16")).toBe("768x1344");
    expect(creationMediaMetadata("character", { resolution:"1080p", aspectRatio:"1:1" }).size).toBe("1024x1024");
    expect(creationMediaMetadata("music", {aspectRatio:"16:9"}).audioLyrics).toBe(" ");
});
test("关闭BGM硬拒绝音乐写入，跳过音乐阶段但不关闭视频音轨", () => {
    expect(() => creationMediaMetadata("music", {aspectRatio:"16:9",backgroundMusic:false})).toThrow("关闭");
    const state = {version:1 as const,completed:["novel","script","character","prop","scene","costume","age","voice","storyboard","video_prompt"] as any,backgroundMusic:false};
    expect(inspectCreationStage("music",state,[],"wb").ready).toBe(true);
    expect(() => guardCreationOps([{type:"add_node",id:"music",nodeType:"audio"}],[],"wb",state)).toThrow("关闭背景音乐");
});
test("风格完整保留参考分组且不强制默认风格", () => {
    expect(CREATION_STYLE_GROUPS).toHaveLength(11);
    expect(CREATION_STYLE_GROUPS.flatMap((g)=>[...g.styles])).toContain("真人电影风格");
    expect(CREATION_STYLE_GROUPS.flatMap((g)=>[...g.styles])).toContain("国漫仙侠古风");
    expect(CREATION_STYLE_GROUPS.flatMap((g)=>[...g.styles])).toContain("西部牛仔");
});
