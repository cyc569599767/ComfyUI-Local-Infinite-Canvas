import { expect, test } from "bun:test";
import { DEFAULT_CHAPTER_PATTERN, buildEpisodesFromChapters, episodeSynopsis, splitNovelChapters } from "../src/lib/short-drama/import";

const NOVEL = `第一章 初入萧家
萧炎站在广场中央，晨光刺眼。

第二章 退婚
纳兰嫣然当众退婚，人群哗然。

第三章 三年之约
他握紧拳头，许下三年之约。`;

test("按章节正则拆分小说，标题与正文不串行", () => {
    const chapters = splitNovelChapters(NOVEL, DEFAULT_CHAPTER_PATTERN);
    expect(chapters).toHaveLength(3);
    expect(chapters.map((chapter) => chapter.title)).toEqual(["第一章 初入萧家", "第二章 退婚", "第三章 三年之约"]);
    // 正文必须从标题之后开始，不能把标题重复吃进 content。
    expect(chapters[0].content).toBe("萧炎站在广场中央，晨光刺眼。");
    expect(chapters[1].content).toBe("纳兰嫣然当众退婚，人群哗然。");
    expect(chapters[2].content).toBe("他握紧拳头，许下三年之约。");
});

test("章节正则在空、非法、无匹配时给出明确错误而不是静默返回空", () => {
    expect(() => splitNovelChapters(NOVEL, "")).toThrow("请输入章节正则");
    expect(() => splitNovelChapters(NOVEL, "([未闭合")).toThrow("章节正则格式不正确");
    expect(() => splitNovelChapters(NOVEL, "^\\s*(正文[^\\n]*)")).toThrow("未匹配到任何章节");
    // 空文本是合法的"没有内容"，返回空数组而不是抛错。
    expect(splitNovelChapters("", DEFAULT_CHAPTER_PATTERN)).toEqual([]);
});

test("CRLF 与章节判定的中文数字都按同一规则处理", () => {
    const crlf = NOVEL.replace(/\n/g, "\r\n");
    expect(splitNovelChapters(crlf, DEFAULT_CHAPTER_PATTERN)).toEqual(splitNovelChapters(NOVEL, DEFAULT_CHAPTER_PATTERN));
    const numbered = "第一节 开局\n内容。\n第十二回 收尾\n结局。";
    // 中文数字 + 回 也要命中，说明正则不是只认阿拉伯数字。
    const chapters = splitNovelChapters(numbered, DEFAULT_CHAPTER_PATTERN);
    expect(chapters.map((chapter) => chapter.title)).toEqual(["第一节 开局", "第十二回 收尾"]);
});

test("按每集章节数分组，单章集标题不拼接区间", () => {
    const chapters = splitNovelChapters(NOVEL, DEFAULT_CHAPTER_PATTERN);
    const onePerEpisode = buildEpisodesFromChapters(chapters, 1);
    expect(onePerEpisode).toHaveLength(3);
    // 单章集直接用章节标题，不加 " - " 区间。
    expect(onePerEpisode[0].title).toBe("第一章 初入萧家");
    expect(onePerEpisode[0].chapterTitles).toEqual(["第一章 初入萧家"]);

    const twoPerEpisode = buildEpisodesFromChapters(chapters, 2);
    expect(twoPerEpisode).toHaveLength(2);
    expect(twoPerEpisode[0].title).toBe("第一章 初入萧家 - 第二章 退婚");
    expect(twoPerEpisode[0].chapterTitles).toEqual(["第一章 初入萧家", "第二章 退婚"]);
    // 尾部不足一章数时单独成集，不能丢。
    expect(twoPerEpisode[1].chapterTitles).toEqual(["第三章 三年之约"]);
});

test("分集脚本保留章节标题且章间空行分隔，集号可指定起始", () => {
    const chapters = splitNovelChapters(NOVEL, DEFAULT_CHAPTER_PATTERN);
    const episodes = buildEpisodesFromChapters(chapters, 2, 7);
    expect(episodes[0].episodeNumber).toBe(7);
    expect(episodes[1].episodeNumber).toBe(8);
    expect(episodes[0].script).toBe("第一章 初入萧家\n萧炎站在广场中央，晨光刺眼。\n\n第二章 退婚\n纳兰嫣然当众退婚，人群哗然。");
});

test("每集章节数非法时收敛为 1，不会产生 0 或 NaN 分组", () => {
    const chapters = splitNovelChapters(NOVEL, DEFAULT_CHAPTER_PATTERN);
    for (const bad of [0, -3, Number.NaN, "abc" as unknown as number]) {
        const episodes = buildEpisodesFromChapters(chapters, bad as number);
        expect(episodes).toHaveLength(3);
        expect(episodes.every((episode) => episode.chapterTitles.length === 1)).toBe(true);
    }
});

test("简介取首个非标题行并压掉空白、超长截断", () => {
    expect(episodeSynopsis("第一章 初入萧家\n萧炎站在广场中央")).toBe("萧炎站在广场中央");
    // 纯空行/标题行时退化为整段压缩，不留空串。
    expect(episodeSynopsis("第一章 初入萧家")).toBe("第一章初入萧家");
    const long = `第一章\n${"字".repeat(80)}`;
    const synopsis = episodeSynopsis(long, 60);
    expect(synopsis.endsWith("…")).toBe(true);
    expect(synopsis.length).toBe(61);
});
