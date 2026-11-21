import { expect, test } from "bun:test";
import {
    characterAssetPrompt,
    deriveSceneVariant,
    detectGenderFromDescription,
    frameReferencePrompt,
    isMajorSceneChange,
    isSameSceneKey,
    mapWithConcurrency,
    normalizeCharacters,
    normalizeLocationKey,
    normalizeProps,
    normalizeScenes,
    propAssetPrompt,
    sceneAssetPrompt,
    sceneReferencePrompt,
    sharesSceneBase,
} from "../src/lib/short-drama/assets";
import { DRAMA_STYLE_GROUPS, findDramaStyle } from "../src/lib/short-drama/styles";

test("角色库归一化：同类重名不去重，保留描述，kind 固定为 character", () => {
    const characters = normalizeCharacters({ characters: [{ name: "萧炎", description: "少年" }, { name: "萧炎", description: "重复" }] });
    expect(characters).toHaveLength(2);
    expect(characters.every((item) => item.kind === "character")).toBe(true);
    expect(characters.map((item) => item.description)).toEqual(["少年", "重复"]);
    // 缺少描述的兜底为空串而不是 undefined，避免下游拼接出现 "undefined"。
    expect(normalizeCharacters({ characters: [{ name: "药老" }] })[0].description).toBe("");
});

test("场景库同名按时间追加后缀，第二个同名不再覆盖", () => {
    const scenes = normalizeScenes({ scenes: [{ name: "萧家广场", time: "黄昏" }, { name: "萧家广场", time: "深夜" }] });
    expect(scenes).toHaveLength(2);
    expect(scenes[0].name).toBe("萧家广场");
    // 同名必须改名，否则资源库会互相覆盖。
    expect(scenes[1].name).toBe("萧家广场 · 深夜");
    expect(scenes[1].name).not.toBe(scenes[0].name);
    expect(scenes.every((item) => item.kind === "scene")).toBe(true);
});

test("场景库第三次同名继续加序号，不产生重复名", () => {
    const scenes = normalizeScenes({
        scenes: [
            { name: "广场", time: "黄昏" },
            { name: "广场", time: "深夜" },
            { name: "广场", time: "深夜" },
        ],
    });
    expect(new Set(scenes.map((item) => item.name)).size).toBe(3);
    expect(scenes[2].name).toBe("广场 · 深夜 2");
});

test("道具库归一化 kind 固定为 prop", () => {
    const props = normalizeProps({ props: [{ name: "重剑" }] });
    expect(props).toEqual([{ kind: "prop", name: "重剑", description: "" }]);
});

test("地点基址去掉时间词与视角词，只留建筑名", () => {
    // 「-」后的时间被切掉，「夜晚」这类时间词也被清掉。
    expect(normalizeLocationKey("萧家家族广场-夜晚")).toBe("萧家家族广场");
    expect(normalizeLocationKey("广场边缘角落")).toBe("广场");
    // 全空输入不应崩，退化返回原文去标点结果。
    expect(normalizeLocationKey("")).toBe("");
});

test("同基址判定：包含关系与共享前缀都能归组，空值不误判", () => {
    expect(isSameSceneKey("萧家广场", "萧家广场外石径")).toBe(true);
    expect(isSameSceneKey("萧家广场", "纳兰府")).toBe(false);
    expect(isSameSceneKey("", "萧家广场")).toBe(false);
    // 单字过短不参与包含归组，避免「门」「房子」互相吸并。
    expect(isSameSceneKey("门", "门外的石阶")).toBe(false);

    expect(sharesSceneBase("萧家广场中央", "萧家广场外石径")).toBe(true);
    expect(sharesSceneBase("萧家广场", "纳兰府")).toBe(false);
    // 共享不足 4 字不算同基址。
    expect(sharesSceneBase("萧家", "萧家广场")).toBe(false);
});

test("场景变体推导：分隔符优先，其次去基址残差，最后退时间", () => {
    // 有分隔符时取后半段作为变体。
    expect(deriveSceneVariant("萧家广场-夜晚", "深夜")).toBe("夜晚");
    // 无分隔符时用 locationKey 剥掉公共部分，残差做变体。
    expect(deriveSceneVariant("萧家广场外石径", "清晨", "萧家广场")).toBe("外石径");
    // 都没有时退到时间描述。
    expect(deriveSceneVariant("萧家广场", "黄昏")).toBe("黄昏");
});

test("重大场景变化识别（焚毁/废墟/改建等）", () => {
    expect(isMajorSceneChange("广场被焚毁")).toBe(true);
    expect(isMajorSceneChange("战后废墟")).toBe(true);
    expect(isMajorSceneChange("广场依旧")).toBe(false);
});

test("场景参考提示词要求保持结构与光向，只改时间机位", () => {
    const prompt = sceneReferencePrompt("黄昏下的广场");
    expect(prompt).toContain("保持图一的场景不变");
    expect(prompt).toContain("建筑结构、材质、配色、光线");
    expect(prompt).toContain("黄昏下的广场");
});

test("首帧参考提示词按序号绑定角色/场景，并锁定脸型与服装", () => {
    const prompt = frameReferencePrompt("站在广场", [
        { name: "萧炎", kind: "character" },
        { name: "萧家广场", kind: "scene" },
    ]);
    expect(prompt).toContain("图片1＝角色「萧炎」");
    expect(prompt).toContain("图片2＝场景「萧家广场」");
    expect(prompt).toContain("画面中只出现一个该角色");
    expect(prompt).toContain("脸型、发型、服装");
    // 必须显式禁止多格分栏，否则参考图排版会被照搬。
    expect(prompt).toContain("no split panels");
});

test("首帧参考提示词在无角色时不含主角句，只有场景也成立", () => {
    const prompt = frameReferencePrompt("空镜", [{ name: "广场", kind: "scene" }]);
    expect(prompt).toContain("图片1＝场景「广场」");
    expect(prompt).not.toContain("画面主角是角色");
});

test("性别识别覆盖中文称谓、男主女主与英文，无法判断返回 null", () => {
    expect(detectGenderFromDescription("一个少女")).toBeNull();
    expect(detectGenderFromDescription("少年")).toBeNull();
    expect(detectGenderFromDescription("男性角色")).toBe("MALE");
    expect(detectGenderFromDescription("女主角")).toBe("FEMALE");
    expect(detectGenderFromDescription("他哥哥")).toBe("MALE");
    expect(detectGenderFromDescription("她的母亲")).toBe("FEMALE");
    expect(detectGenderFromDescription("a young man")).toBe("MALE");
    expect(detectGenderFromDescription("a brave woman")).toBe("FEMALE");
    expect(detectGenderFromDescription("")).toBeNull();
});

test("角色资产提示词把画风放在最高优先级并带上精修描述", () => {
    const prompt = characterAssetPrompt("国风写实", { id: "1", kind: "character", name: "萧炎", description: "少年剑客" } as never, "红衣黑发，手持玄重尺");
    expect(prompt).toContain("【画风·最高优先级】");
    expect(prompt).toContain("国风写实");
    expect(prompt).toContain("红衣黑发");
    // 单张参考表要明确禁止四宫格排版，否则会被画成网格图。
    expect(prompt).toContain("NOT a 2×2 or 4×4 grid");
    // 描述里没有性别线索时不注入 GENDER 约束。
    expect(prompt).not.toContain("GENDER:");
});

test("角色描述带性别线索时才注入 GENDER 约束", () => {
    const male = characterAssetPrompt("国风", { id: "1", kind: "character", name: "萧炎", description: "男性剑客" } as never, "黑发");
    expect(male).toContain("GENDER: male only");
    const female = characterAssetPrompt("国风", { id: "1", kind: "character", name: "纳兰嫣然", description: "女主角" } as never, "白衣");
    expect(female).toContain("GENDER: female only");
});

test("场景与道具资产提示词包含各自主体描述", () => {
    expect(sceneAssetPrompt("国风", { id: "1", kind: "scene", name: "萧家广场", description: "开阔石砖广场" } as never, "黄昏时分，光影斜长")).toContain("黄昏时分");
    expect(propAssetPrompt("国风", { id: "1", kind: "prop", name: "玄重尺", description: "黑色重尺" } as never, "磨损的金属质感")).toContain("磨损的金属质感");
});

test("并发映射保持结果顺序，且同时运行数不超过上限", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return item * 2;
    });
    // 结果顺序必须与输入一致，不能按完成顺序排列。
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    // 并发受限，否则会同时打爆模型接口。
    expect(peak).toBeLessThanOrEqual(2);
});

test("并发映射在空数组与超大并发限额下都不崩", async () => {
    expect(await mapWithConcurrency([], 3, async (item: number) => item)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 99, async (item) => item + 1)).toEqual([2, 3]);
});

test("画风库分组完整且每个选项都能按 value 反查", () => {
    expect(DRAMA_STYLE_GROUPS.length).toBe(7);
    const all = DRAMA_STYLE_GROUPS.flatMap((group) => group.options);
    expect(all.length).toBe(39);
    for (const option of all) {
        expect(findDramaStyle(option.value)?.label).toBe(option.label);
    }
    expect(findDramaStyle("不存在的画风")).toBeNull();
    expect(findDramaStyle(undefined)).toBeNull();
});

test("画风选项 value 唯一，避免选择后互相覆盖", () => {
    const values = DRAMA_STYLE_GROUPS.flatMap((group) => group.options.map((option) => option.value));
    expect(new Set(values).size).toBe(values.length);
    // 每组都要有可读标题，否则弹窗里出现空分组。
    expect(DRAMA_STYLE_GROUPS.every((group) => group.label.trim().length > 0)).toBe(true);
});
