/** 与 infinite-creation/lib/shared/index.js 的 STYLE_GROUPS 同源，保留分组及顺序。 */
export const CREATION_RESOLUTIONS = ["360p", "480p", "540p", "720p", "768p", "1080p"] as const;
export type CreationResolution = typeof CREATION_RESOLUTIONS[number];
export function normalizeCreationResolution(value?: string): CreationResolution {
    const normalized = value?.toLowerCase();
    return CREATION_RESOLUTIONS.includes(normalized as CreationResolution) ? normalized as CreationResolution : "768p";
}
export const CREATION_STYLE_GROUPS = [
    { label: "通用风格", styles: ["真人电影风格", "3D国漫CG级别", "韩漫霸总都市风", "日漫二次元少女风", "国漫仙侠古风", "水墨国风禅意风", "敦煌新国潮风", "美漫双城之战风", "吉卜力治愈风", "新海诚文艺清新风", "赛博朋克未来风", "废土末世风", "暗黑哥特悬疑风", "Q版萌系沙雕", "复古港漫武侠风", "厚涂写实插画风", "赛璐璐", "厚涂", "水墨", "像素", "3D渲染"] },
    { label: "基础风格", styles: ["真人写实", "动漫", "国漫", "日系动漫风", "卡通", "Q版卡通风", "国风玄幻", "上美影天书奇谭", "国漫3D次世代CG", "古风唯美CG", "东方玄幻武侠", "日系胶片写真", "2.5D半写实", "甜美Q版卡通"] },
    { label: "古装", styles: ["古装偶像", "宫廷权谋", "武侠江湖"] },
    { label: "都市", styles: ["国产都市", "都市情感", "现实悬疑", "韩国冷淡"] },
    { label: "中式新派", styles: ["新兴中式", "高调荒诞"] },
    { label: "动画", styles: ["上美动漫", "大友克洋", "定格动画", "黏土动画"] },
    { label: "传统艺术", styles: ["中式水墨", "浮世绘风", "传统皮影", "埃及壁画", "简约插画", "荒诞达利"] },
    { label: "概念神话", styles: ["游戏概念", "传统神话", "希腊神话", "西式魔幻"] },
    { label: "年代复古", styles: ["90年代", "黄金时代", "美式90", "昭和黑白", "老式工业", "60海报", "复古港片", "复古胶片", "复古叙事"] },
    { label: "现实治愈", styles: ["纪实写实", "生活治愈", "青春胶片"] },
    { label: "科幻类型", styles: ["原子朋克", "霓虹朋克", "硬核科幻", "蒸汽朋克", "血肉朋克", "心理恐怖", "邪典cult", "现代战争", "荒野公路", "西部牛仔"] },
] as const;
