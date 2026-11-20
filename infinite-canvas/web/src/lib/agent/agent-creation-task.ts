/** 工作台传给独立创作引擎的任务输入。 */
export type AgentCreationSeed = {
    seedId: string;
    projectNodeId: string;
    projectTitle: string;
    idea: string;
    style: string;
    aspectRatio: "16:9" | "9:16" | "1:1";
    targetSeconds: number;
    resolution?: import("./creation-settings").CreationResolution;
    backgroundMusic?: boolean;
    /** 独立聊天输入，绝不能用它替换项目原文。 */
    userMessage?: string;
    createImages: boolean;
    createVideos: boolean;
    continueExisting: boolean;
    progress: string;
};

export function buildAgentCreationTask(seed: AgentCreationSeed, idea: string): string {
    if (seed.userMessage?.trim()) return seed.userMessage.trim();
    return [
        `这是画布「${seed.projectTitle}」的 Agent 无限创作项目，工作台ID=${seed.projectNodeId}。故事原文作为项目资料随系统上下文提供，不将全文重复当作聊天输入。`,
        `目标视频时长约 ${seed.targetSeconds} 秒，画幅 ${seed.aspectRatio}，视频分辨率 ${seed.resolution || "768p"}，视觉风格：${seed.style || "跟随故事"}。背景音乐：${seed.backgroundMusic === false ? "不需要，仅保留环境音与台词" : "需要独立配乐素材"}。`,
        seed.continueExisting ? `这是续跑：先读取creation_get_pipeline和canvas_get_state，不要重做已有产物。上次进度：${seed.progress || "从画布读取"}。` : "先读取creation_get_pipeline与canvas_get_state，建立故事蓝图/小说正文，然后写剧本。",
        "严格执行：小说→剧本→人物素材→道具素材→场景素材→换装→年龄分级→配音音色→分镜脚本→视频提示词→背景音乐→总流水线。每步skill()读取配置的完整技能正文，必要时skill_reference读取参考资料。完成当前阶段调用creation_complete_stage，核验通过后自动进入下一阶段，不要求用户逐阶段发送继续；媒体任务由程序等待结果后自动续跑。未通过不得进入后续。",
        "剧本阶段creation_set_plan提交素材清单及镜头ID/引用关系，不能提前写分镜正文。assets条目含id/kind/label，costume/age另有parentId；shots含id/label/referenceIds/promptNodeId/videoNodeId；voiceIds/musicIds；omitted记录未使用类别的原因。不要为不需要的换装/年龄/音乐强行创建资产。",
        seed.createImages ? "人物、道具、场景、换装、年龄等所需设定图全部生成成功后，才能编写分镜。用计划ID建image卡，metadata.prompt填写提示词，run_generation（mode=image）真正生成；禁止手写status/content。等待结果用creation_wait，不能把排队当完成。" : "本轮是纯文本预演：不建图片卡、不调用run_generation，素材各阶段写对应设定文本，不能声称设定图已经完成。",
        "分镜脚本逐镜写text卡，ID用shots.id；视频提示词单独写text卡，ID用promptNodeId。参考图Picture编号按每镜referenceIds顺序，人物/服装/场景一致，音色与节奏遵循绑定技能。",
        seed.createVideos ? "最后总流水线才按videoNodeId建video卡，用run_generation（mode=video）出片；程序从promptNodeId取已完成提示词并自动绑定参考图，video卡自身prompt可以为空，不要逐镜复制重写提示词。只有真实出片后才完成总流水线。之后可进入video-editor 工作台卡，自动铺成时间线、一键合成成片；不要声称已经合成成片，实际合成仍需剪辑台执行。" : "本次不做视频；保留提示词和素材，之后可以开启视频继续项目。",
        "进度由引擎写入metadata.agentCreation，只写你要改的字段到当前阶段产物，不改工作台idea/style/conversationId，不删除用户节点。技能包内提到其他系统工具时须适配为当前工具，不编造工具执行成功。",
    ].join("\n\n");
}
