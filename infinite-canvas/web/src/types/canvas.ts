import type { DramaRun } from "@/lib/short-drama/run-manifest";
import type { DramaScreenplay } from "@/lib/short-drama/storyboard";
export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    /** 音色设计：与空音频节点完全同构，仅默认 audioMode 为 voice-design。 */
    VoiceDesign = "voice-design",
    FreeCard = "free-card",
    /** 短剧：分镜导演台，承载角色/场景/道具与逐集出图出片。 */
    Drama = "short-drama",
    /** 自动化：长文改编与批量出图出片流水线。 */
    Automation = "automation",
    /** 工作台：承载独立的专业编辑面板（故事分镜导演台等），本身不产出媒体。 */
    Workbench = "workbench",
    Group = "group",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

/** 所有「音频类」节点：共用渲染、参考音频、生成与面板逻辑。 */
export const AUDIO_NODE_TYPES: readonly string[] = [CanvasNodeType.Audio, CanvasNodeType.VoiceDesign];

/** 判断是否音频类节点（音频 / 音色设计）。各处判断都应走这里，避免漏掉新增的音色设计节点。 */
export function isAudioNodeType(type: CanvasNodeTypeId | string | undefined | null): boolean {
    return Boolean(type) && AUDIO_NODE_TYPES.includes(type as string);
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasFreeCardOutputType = "image" | "video" | "audio" | "other";

export type CanvasFreeCardInfo = {
    id: string;
    name: string;
    sourceRel: string;
    sourceFormat: "ui" | "api";
    outputType: CanvasFreeCardOutputType;
    prompt: boolean;
    textInputs?: Array<{ node: string; input: string; label: string; default: string; role: string }>;
    imageInputs: number;
    /** 参考音频输入数量（音色克隆类工作流需要连入音频节点）。 */
    audioInputs?: number;
    size?: { width: number; height: number } | null;
    aspectRatio?: string | null;
    aspectRatios?: string[];
    count?: number | null;
    hasSeed?: boolean;
    seed?: string | null;
    warnings?: string[];
    archived?: boolean;
    // ── 上游 v0.25.x 追加（可选）──
    healthWarnings?: string[];
    snapshot?: boolean;
    snapshotPageLabel?: string;
    pageCount?: number;
};

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey?: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
};

export type CanvasNodeText = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
};

export type CanvasMossLayoutRegion = {
    id: string;
    label: "object" | "character" | "text";
    caption: string;
    text?: string;
    x: number;
    y: number;
    width: number;
    height: number;
};

export type CanvasMossLayout = {
    summary: string;
    regions: CanvasMossLayoutRegion[];
    width?: number;
    height?: number;
    /** 上游 v0.25.x：分镜提示词版本，用于判断是否需要用新版提示词重绘。 */
    storyboardVersion?: number;
};

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    // Prompt before connected text expansion, used to replay a generation once.
    generationInputPrompt?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    textCount?: number;
    texts?: CanvasNodeText[];
    primaryTextId?: string;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    videoMode?: string;
    videoInterpolation?: string;
    videoSelfLiftMode?: string;
    // ── 上游 v0.25.x 追加：自定义文本与 Viggle ──
    customTexts?: Record<string, string>;
    // 上游 v0.25.x：短剧卡片数据
    dramaCard?: CanvasDramaCardData;
    // 上游 v0.25.x：短剧/自动化编排用到的节点字段
    referenceAcceleration?: boolean;
    // 上游 v0.25.x：自动化（automation）节点状态
    automation?: CanvasAutomationState;
    customTextActive?: string;
    videoPins?: string;
    videoSegmentSeconds?: string;
    videoSage?: string;
    videoViggleMode?: string;
    videoSwapTarget?: string;
    frameMode?: "first" | "last" | "both";
    imageMode?: "t2i" | "edit" | "inpaint" | "outpaint" | "layout" | "remove";
    captionEngine?: "qwen35" | "florence" | "cloud";
    captionStatus?: "running" | "done" | "error";
    captionPrompt?: string;
    captionError?: string;
    captionEngineUsed?: "qwen35" | "florence" | "cloud";
    promptOptimizeStatus?: "running" | "done" | "error";
    promptOptimizeKind?: "h3" | "image";
    promptOptimizePrompt?: string;
    promptOptimizeSource?: string;
    promptOptimizeError?: string;
    outpaint?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    layout?: CanvasMossLayout;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    // 本地网关音频三种子功能：音色设计 / 音色克隆 / 音乐生成。
    audioMode?: "voice-design" | "voice-clone" | "music";
    audioVoiceDescription?: string;
    audioLyrics?: string;
    audioLanguage?: string;
    audioMaxDuration?: string;
    audioSeed?: string;
    audioSeedFixed?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    refsWarningDismissed?: boolean;
    // 角色替换工作流的玩法说明是否被用户手动关闭。
    swapHintDismissed?: boolean;
    videoTaskId?: string;
    videoTaskProvider?: "openai" | "gemini";
    previewUrl?: string;
    previewMime?: string;
    previewStep?: number;
    previewTotal?: number;
    stepProgress?: { step: number; total: number; complete?: boolean };
    generationStartedAt?: number;
    generationDurationMs?: number;
    seed?: string;
    seedFixed?: string;
    aspectRatio?: string;
    freeCard?: CanvasFreeCardInfo;
    /** 角色替换（swap-chain）产物信息，便于回溯任务与源片。 */
    swapChain?: { jobId: string; videoUrl: string; mode: "single_swap" | "double_swap" | "edit_clothes" | "edit_light" | "edit_time"; intent: string; sourceNodeId: string };
    /** 生成中显示的阶段短语（如「逐帧换人」），仅 loading 期间有意义。 */
    generationStageLabel?: string;
    /** 「3D 场景」全景背景的产物来源，便于回溯是哪张图、什么描述生成的。 */
    panoramaSource?: { nodeId: string; prompt: string; offset?: { x: number; y: number } };
    /** 工作台节点承载哪种工具：storyboard = 故事分镜导演台，digital-human = 数字人工作台 V2，video-editor = 视频编辑工作台，novel = 网文卷轴，agent-creation = Agent 无限创作。 */
    workbenchKind?: "storyboard" | "digital-human" | "video-editor" | "novel" | "agent-creation";
    /** 该工作台绑定的故事分镜项目 id（存在网关）。 */
    storyboardProjectId?: string;
    /** 该工作台绑定的小说项目 id（存在网关）。 */
    novelProjectId?: string;
    /** Agent 无限创作项目配置与进度，随此画布节点一起保存。 */
    agentCreation?: {
        idea: string;
        style: string;
        aspectRatio: "16:9" | "9:16" | "1:1";
        targetSeconds: number;
        /** 老项目缺省768p；只影响后续媒体生成，不重制已有产物。 */
        resolution?: import("@/lib/agent/creation-settings").CreationResolution;
        backgroundMusic?: boolean;
        createImages: boolean;
        createVideos: boolean;
        status: "draft" | "running" | "ready" | "error";
        progress: string;
        conversationId: string;
        lastError?: string;
    };
    creationOutput?: import("@/lib/agent/creation-pipeline").CreationOutput;
    creationPipeline?: import("@/lib/agent/creation-pipeline").CreationPipelineState;
    agentCreationProgress?: string;
    /** 数字人镜头的音频区间与运镜，导出时要用，必须跟着卡片一起存。 */
    digitalHumanSegment?: { start: number; end: number; camera: string; reference?: string };
    /** 剪辑草稿及最近成片：随工作台保存，不使用临时播放器 URL 作为唯一身份。 */
    videoEditor?: import("@/lib/canvas/video-timeline").VideoEditorDraft;
    /** 剪辑台自身的输出不再自动回灌进该工作台。 */
    videoEditorOriginId?: string;
    /** 视频编辑工作台导出的片段在时间线上的位置与裁剪信息。 */
    editTimeline?: { start: number; inPoint: number; outPoint: number; track: number; volume: number; totalSeconds: number };
    freeCardTextValues?: Record<string, string>;
    /** 固定配置项在当前节点上的取值，键为 `节点id\u0000输入名`。 */
    freeCardValues?: Record<string, string | number | boolean>;
    freeWorkflowId?: string;
    groupId?: string;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
    params?: Record<string, unknown>; // Per-node model params (e.g. LoRA stack).
    model3d?: { url: string; bytes?: number; filename?: string; mode?: "synthetic" | "real"; steps?: number; format?: "ply" | "glb" };
    model3dEngine?: "idol" | "moge";
    stage3d?: {
        scene: { url: string; filename?: string; bytes?: number };
        character?: { url: string; filename?: string; bytes?: number };
        characters?: Array<{ id?: string; url: string; filename?: string; bytes?: number; transform?: { x: number; y?: number; z: number; rotation: number; scale: number } }>;
        transform?: { x: number; y?: number; z: number; rotation: number; scale: number };
    };
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    role?: "lineage";
    /** 自动生成的流水线展示边归属；不会作为生成参考输入。 */
    creationProjectId?: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };

// ── 上游 v0.25.x 自动化（automation）类型 ──
export type CanvasAutomationStage = "idle" | "script" | "planning" | "characters" | "scenes" | "images" | "videoPrompts" | "videos" | "done" | "error" | "stopped";

export type CanvasAutomationScene = {
    id: string;
    name: string;
    description?: string;
};

export type CanvasAutomationSceneSheet = {
    sceneId: string;
    name: string;
    nodeId: string;
    state: "pending" | "loading" | "done" | "error";
    error?: string;
};

export type CanvasAutomationGrid = {
    rows: number;
    cols: number;
    panelCount: number;
};

export type CanvasAutomationCharacter = {
    id: string;
    name: string;
    species?: "human" | "animal";
    speciesLabel?: string;
    description?: string;
    appearanceLock?: string;
    outfitLock?: string;
    negativeLock?: string;
};

export type CanvasAutomationPanelSpec = {
    index: number;
    time?: string;
    description: string;
    storyboardDescription?: string;
    background?: string;
    beat?: "key" | "support";
    camera?: string;
    dialogue?: string[];
    characters?: string[];
};

export type CanvasAutomationShotGroup = {
    panels: number[];
    mode: "long_take" | "cut" | "insert";
    template?: string;
    reason?: string;
};

export type CanvasAutomationScriptLine = {
    speaker: string;
    text: string;
    performance?: string;
    channel?: "spoken" | "inner" | "system";
};

export type CanvasAutomationScriptBeat = {
    id: string;
    sceneId: string;
    action: string;
    dialogue?: CanvasAutomationScriptLine[];
};

export type CanvasAutomationScriptScene = {
    id: string;
    heading: string;
    description?: string;
};

export type CanvasAutomationScript = {
    level: "locked" | "performance" | "structural";
    logline?: string;
    scenes: CanvasAutomationScriptScene[];
    beats: CanvasAutomationScriptBeat[];
};

export type CanvasAutomationVideoSegment = {
    index: number;
    prompt?: string;
    promptVersion?: number;
    seconds: string;
    panelRange?: [number, number];
    nodeId?: string;
    state: "pending" | "loading" | "done" | "error";
    error?: string;
};

export type CanvasAutomationPage = {
    index: number;
    title: string;
    narration?: string;
    sceneId?: string;
    scene?: string;
    sceneDescription?: string;
    dialogue?: string[];
    focus?: string;
    eventIds?: string[];
    shotGroups?: CanvasAutomationShotGroup[];
    videoHint?: string;
    videoPrompt?: string;
    videoPromptVersion?: number;
    videoTitle?: string;
    videoSegments?: CanvasAutomationVideoSegment[];
    segmentIndex?: number;
    segmentCount?: number;
    panelRange?: [number, number];
    grid?: CanvasAutomationGrid;
    panels?: CanvasAutomationPanelSpec[];
    style?: string;
    styleLock?: string;
    styleNegative?: string;
    videoSeconds?: string;
    characters?: CanvasAutomationCharacter[];
    layout: CanvasMossLayout;
    textNodeId?: string;
    imageNodeId?: string;
    videoNodeId?: string;
    imageState: "pending" | "loading" | "done" | "error";
    videoState: "pending" | "loading" | "done" | "error";
    error?: string;
};

export type CanvasAutomationCharacterSheet = {
    characterId: string;
    nodeId: string;
    state: "pending" | "loading" | "done" | "error";
    error?: string;
};

export type CanvasAutomationSettings = {
    pageCount: number;
    pageCountAuto?: boolean;
    segmentation?: "short" | "long";
    grid: "2x2" | "2x3" | "3x3";
    style: string;
    aspect: string;
    mossSteps: "8" | "50";
    videoSeconds: string;
    videoVariant?: "auto" | "vdn" | "novdn";
    vquality: string;
    generateAudio: boolean;
    generateCharacterSheets?: boolean;
    generateSceneSheets?: boolean;
    storyboardWhiteModel?: boolean;
    textModel?: string;
};

export type CanvasAutomationState = {
    template: "novel-comic-video";
    stage: CanvasAutomationStage;
    sourceText: string;
    sourceUrl?: string;
    settings: CanvasAutomationSettings;
    script?: CanvasAutomationScript;
    scriptText?: string;
    style?: string;
    styleLock?: string;
    styleNegative?: string;
    characters?: CanvasAutomationCharacter[];
    characterSheets?: CanvasAutomationCharacterSheet[];
    scenes?: CanvasAutomationScene[];
    sceneSheets?: CanvasAutomationSceneSheet[];
    pages?: CanvasAutomationPage[];
    videoPromptVersion?: number;
    progress?: string;
    warnings?: string[];
    errors?: string[];
    fallbackNotice?: string;
    startedAt?: number;
    finishedAt?: number;
    updatedAt?: number;
};


// ── 上游 v0.25.x 短剧（short-drama）类型 ──
export type CanvasDramaCardEpisode = {
    id: string;
    title: string;
    synopsis: string;
    shots: number;
    draft: boolean;
    script?: string;
    screenplay?: DramaScreenplay;
};

export type CanvasDramaAssetStage = {
    id: string;
    name: string;
    description: string;
    polishedPrompt?: string;
    prompt?: string;
    nodeId?: string;
    imageUrl?: string;
    state: "pending" | "loading" | "done" | "error";
    error?: string;
};

export type CanvasDramaAssetRecord = {
    id: string;
    kind: "character" | "scene" | "prop";
    name: string;
    nameEn?: string;
    role?: string;
    description: string;
    polishedPrompt?: string;
    prompt?: string;
    nodeId?: string;
    imageUrl?: string;
    state: "pending" | "loading" | "done" | "error";
    error?: string;
    stages?: CanvasDramaAssetStage[];
    location?: string;
    time?: string;
    variant?: string;
    locationKey?: string;
    refMode?: "auto" | "off";
    baseNodeId?: string;
    usedReference?: boolean;
};

export type CanvasDramaAssetLibrary = {
    characters: CanvasDramaAssetRecord[];
    scenes: CanvasDramaAssetRecord[];
    props: CanvasDramaAssetRecord[];
};

export type CanvasDramaStoryboardShot = {
    id?: string;
    shotNumber: number;
    title: string;
    segmentIndex: number;
    segmentTitle: string;
    location: string;
    time: string;
    shotType: string;
    cameraAngle: string;
    cameraMovement: string;
    lightingStyle: string;
    depthOfField: string;
    action: string;
    result: string;
    dialogue: string;
    emotion: string;
    emotionIntensity: number;
    duration?: number;
    beatIds?: string[];
    cutPoints?: string[];
    splitReason?: string;
    entryState?: string;
    exitState?: string;
    cameraPurpose?: string;
};

export type CanvasDramaCardData = {
    title: string;
    style: string;
    aspect: string;
    imageWorkflow?: string;
    videoWorkflow?: string;
    videoMode?: "frames" | "reference";
    vquality?: string;
    segmentSeconds?: number;
    paused?: boolean;
    activeTab: "characters" | "scenes" | "props";
    episodes: CanvasDramaCardEpisode[];
    assets?: CanvasDramaAssetLibrary;
    storyboards?: Record<string, CanvasDramaStoryboardShot[]>;
    runs?: Record<string, DramaRun>;
    progress?: { stage: string; current: number; total: number };
};
