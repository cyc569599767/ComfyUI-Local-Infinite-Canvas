import { ShortDramaPanel } from "@/components/canvas/short-drama-panel";
import { CanvasAutomationPanelHost } from "@/components/canvas/canvas-automation-panel-host";
import { Box, Clapperboard, Download, FileText, Group, Image as ImageIcon, Layers3, Mic, Music2, Settings2, Sparkles, Video } from "lucide-react";
import { message } from "antd";
import { saveAs } from "file-saver";

import i18n from "@/i18n";

import { NODE_SPECS } from "@/constant/canvas";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { MODEL3D_DEFAULT_SIZE, MODEL3D_NODE_TYPE, STAGE3D_DEFAULT_SIZE, STAGE3D_NODE_TYPE } from "@/lib/canvas/model3d";
import { Model3DNodeContent } from "@/components/canvas/model3d-node-content";
import { Stage3DNodeContent } from "@/components/canvas/stage-3d-node-content";
import { WorkbenchNodeContent, WorkbenchPanelHost } from "@/components/canvas/workbench-node-content";
import { CanvasNodeType, isAudioNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeContext, CanvasNodeDefinition, CanvasNodeResource } from "@/types/canvas-plugin";

// Extensible metadata for built-in nodes, reusing NODE_SPECS for size and initial metadata.
// Rendering remains in canvas-node's internal renderer, so no Content component is provided.
function builtinResource(node: CanvasNodeData): CanvasNodeResource | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return { kind: "image", url: node.metadata.content };
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return { kind: "video", url: node.metadata.content };
    if (isAudioNodeType(node.type) && node.metadata?.content) return { kind: "audio", url: node.metadata.content };
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return { kind: "text", text: node.metadata.content || node.metadata.prompt };
    return null;
}

const iconClass = "size-4";

const MODEL3D_DEFINITION: CanvasNodeDefinition = {
    type: MODEL3D_NODE_TYPE,
    title: i18n.t("canvas.model3d.typeTitle"),
    icon: <Box className={iconClass} />,
    defaultSize: MODEL3D_DEFAULT_SIZE,
    defaultMetadata: { status: "idle", interactive: true },
    minimapColor: "#38bdf8",
    showInCreateMenu: false,
    hasSourceHandle: false,
    dragHeader: true,
    interactionToggle: true,
    keepAspectRatio: () => true,
    Content: Model3DNodeContent,
    toolbar: (ctx) => {
        const model = ctx.node.metadata?.model3d;
        if (!model?.url) return [];
        return [
            {
                id: "model3d-download",
                title: i18n.t("canvas.model3d.downloadTitle"),
                label: i18n.t("canvas.model3d.download"),
                icon: <Download className="size-4" />,
                onClick: () => {
                    void fetch(model.url)
                        .then((response) => {
                            if (!response.ok) throw new Error(`HTTP ${response.status}`);
                            return response.blob();
                        })
                        .then((blob) => saveAs(blob, model.filename || "model.ply"))
                        .catch((error) => {
                            console.error("[model3d] download failed", error);
                            message.error(i18n.t("canvas.model3d.loadFailed"));
                        });
                },
            },
        ];
    },
};

const STAGE3D_DEFINITION: CanvasNodeDefinition = {
    type: STAGE3D_NODE_TYPE,
    title: i18n.t("canvas.model3d.stageTitle"),
    icon: <Layers3 className={iconClass} />,
    defaultSize: STAGE3D_DEFAULT_SIZE,
    defaultMetadata: { status: "idle", interactive: true },
    minimapColor: "#22d3ee",
    showInCreateMenu: false,
    hasSourceHandle: false,
    dragHeader: true,
    interactionToggle: true,
    keepAspectRatio: () => true,
    Content: Stage3DNodeContent,
};

const BUILTIN_DEFINITIONS: CanvasNodeDefinition[] = [
    { type: CanvasNodeType.Text, title: i18n.t("assets.kinds.text"), icon: <FileText className={iconClass} />, minimapColor: undefined, resource: builtinResource },
    { type: CanvasNodeType.Image, title: i18n.t("assets.kinds.image"), icon: <ImageIcon className={iconClass} />, minimapColor: "#10b981", keepAspectRatio: (node: CanvasNodeData) => !node.metadata?.freeResize, resource: builtinResource },
    { type: CanvasNodeType.Video, title: i18n.t("assets.kinds.video"), icon: <Video className={iconClass} />, minimapColor: "#f97316", keepAspectRatio: () => true, resource: builtinResource },
    { type: CanvasNodeType.Audio, title: i18n.t("assets.kinds.audio"), icon: <Music2 className={iconClass} />, minimapColor: "#a855f7", resource: builtinResource },
    // 「音频生成」只从连接点右侧菜单和工具栏进入，空白处双击的「选择节点」菜单里不再列出它，
    // 避免与普通「音频」节点并列时让人分不清该建哪个。
    { type: CanvasNodeType.VoiceDesign, title: i18n.t("canvas.nodeTypes.voiceDesign"), icon: <Mic className={iconClass} />, minimapColor: "#c084fc", showInCreateMenu: false, resource: builtinResource },
    { type: CanvasNodeType.Config, title: i18n.t("canvas.configNode.title"), icon: <Settings2 className={iconClass} />, minimapColor: "#60a5fa", hasSourceHandle: false },
    { type: CanvasNodeType.FreeCard, title: i18n.t("canvas.freeCard.title"), icon: <Sparkles className={iconClass} />, minimapColor: "#eab308", hasSourceHandle: false },
    // 工作台从双击菜单的「工作台」子菜单进入，不出现在普通节点列表里；
    // 它承载完整编辑面板，本身不产出媒体，所以没有输出连接点。
    {
        type: CanvasNodeType.Workbench,
        title: i18n.t("canvas.workbench.title"),
        icon: <Clapperboard className={iconClass} />,
        minimapColor: "#f472b6",
        // 保留在菜单数据里，由 NodeCreateMenu 单独挑出来放进「工作台」子菜单；
        // 它不会和普通节点混排，因为主列表显式排除了这个类型。
        hasSourceHandle: false,
        hasTargetHandle: false,
        description: i18n.t("canvas.workbench.storyboardDescription"),
        defaultMetadata: { status: "idle", workbenchKind: "storyboard" },
        Content: WorkbenchNodeContent,
        // 面板按 workbenchKind 分发，三种工作台共用这一个入口。
        Panel: WorkbenchPanelHost,
        // 单击只选中，双击才打开：编辑器面板占满屏幕，误触就弹出来很烦，
        // 而且单击开面板会让双击立刻把自己关掉。
        clickOpensPanel: false,
        autoOpenPanel: false,
        // 双击是进入工作台的唯一入口；单击标题会进重命名，两者不能抢同一个手势。
        // 参数类型必须写明：这个数组经过 .map() 后失去上下文推断。
        onDoubleClick: (ctx: CanvasNodeContext) => {
            ctx.openPanel();
            return true;
        },
    },
    // 自动化：长文改编 → 分镜 → 批量出图出片的流水线面板，本身不产出媒体。
    {
        type: CanvasNodeType.Automation,
        title: "自动化",
        icon: <Clapperboard className={iconClass} />,
        minimapColor: "#38bdf8",
        hasSourceHandle: false,
        hasTargetHandle: false,
        description: "长文改编：剧本 → 分镜 → 批量出图出片",
        defaultMetadata: { status: "idle" },
        Panel: CanvasAutomationPanelHost,
        clickOpensPanel: false,
        autoOpenPanel: false,
        onDoubleClick: (ctx: CanvasNodeContext) => {
            ctx.openPanel();
            return true;
        },
    },
    // 短剧：分镜导演台。面板承载角色/场景/道具库与逐集分镜，本身不产出媒体。
    {
        type: CanvasNodeType.Drama,
        title: "短剧",
        icon: <Clapperboard className={iconClass} />,
        minimapColor: "#fb7185",
        hasSourceHandle: false,
        hasTargetHandle: false,
        description: "分镜导演台：角色/场景/道具库、逐集分镜与出图出片",
        defaultMetadata: { status: "idle" },
        Panel: ShortDramaPanel,
        clickOpensPanel: false,
        autoOpenPanel: false,
        onDoubleClick: (ctx: CanvasNodeContext) => {
            ctx.openPanel();
            return true;
        },
    },
    { type: CanvasNodeType.Group, title: i18n.t("canvas.node.group"), icon: <Group className={iconClass} />, minimapColor: "#94a3b8" },
    MODEL3D_DEFINITION,
    STAGE3D_DEFINITION,
].map((def) => {
    if (def.type === MODEL3D_NODE_TYPE || def.type === STAGE3D_NODE_TYPE) return def;
    const spec = NODE_SPECS[def.type as CanvasNodeType];
    return { ...def, title: spec.title, defaultSize: { width: spec.width, height: spec.height }, defaultMetadata: spec.metadata };
});

let registered = false;
export function registerBuiltinNodes() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions(BUILTIN_DEFINITIONS, "builtin");
}
