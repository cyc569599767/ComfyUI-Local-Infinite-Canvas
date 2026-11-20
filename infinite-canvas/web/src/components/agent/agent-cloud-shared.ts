/**
 * 云端 Agent 的共享画布能力层。
 *
 * 画布助手（agent-cloud-chat）和 Agent 无限创作工作台（creation-agent）是两条
 * 独立的 Agent 通道：各自的会话、运行态、并发控制互不影响。但它们面对的是
 * 同一张画布、同一批生成能力，所以工具定义、画布状态快照、能力目录必须共用
 * 一份 —— 否则两边的模型会对同一张画布给出不一致的操作方式，也会出现一边
 * 支持 workbench、另一边不知道有它的割裂。
 *
 * 这里只放纯函数：不持有 React 状态，不碰任何 store 的发送标志。
 */
import { modelOptionLabel, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";

export function canvasFeatureCatalog() {
    const config = useConfigStore.getState().config;
    const imageModels = selectableModelsByCapability(config, "image").map((value) => ({ value, label: modelOptionLabel(config, value) }));
    const videoModels = selectableModelsByCapability(config, "video").map((value) => ({ value, label: modelOptionLabel(config, value) }));
    return {
        note: "这是你自己查用的能力目录。回答时只摘与问题相关的 1-2 句，不要把整段贴给用户。",
        modelUsage: "创建生成卡时 metadata.model 必须使用 models.image[].value；label 只用于匹配用户说法。用户指定了模型就不要替换，Z Image 不能用 Krea2。",
        directExecution: "Agent 可直接执行的只有 canvas_apply_ops：读取、添加/更新/删除节点、连接/删除连线、选中、视口、run_generation。区域布局编辑器、局部编辑、四视图、提示词优化/反推、视频超分/插帧等是独立 UI，说明入口即可，不要声称已经执行。",
        features: [
            {
                id: "moss-layout",
                name: "MOSS 区域布局",
                entry: "MOSS 模型（8步/50步）的配置卡或图片卡 → 图像设置 → 区域布局 → 打开区域布局编辑器",
                when: "一张图里需要多个区域，每个区域单独填写提示词或文字",
                how: "在编辑器里画框，为每个区域填写提示词/文字；背景框先画，人物、物体、文字框后画；确认后生成。区域类型：背景/人物/物体/文字",
                limits: "仅 MOSS 模型可用；普通文生图不会使用旧布局；这不是局部编辑",
            },
            {
                id: "local-edit",
                name: "局部编辑（蒙版）",
                entry: "图片卡悬浮工具 → 局部编辑",
                when: "只修改图片中的一块区域，其他区域保持原样",
                how: "在图上涂蓝色蒙版并填写修改要求，确认后生成编辑结果；默认走 Qwen Image 2.1 编辑",
                limits: "入口在图片卡悬浮工具；不是 MOSS 区域布局；不是整图重绘",
            },
            {
                id: "four-view",
                name: "四视图",
                entry: "图片卡悬浮工具 → 四视图",
                when: "从一张角色图生成角色设定四视图",
                how: "以原图为参考，调用固定 image-krea2-four-view 工作流，输出一张四视图角色设定图",
                limits: "需要角色图片；画布会自动使用固定四视图提示词，不需要写拼图/分栏排版词；输出是一张四视图设定图，不是四张普通图，也不是多角度",
            },
            {
                id: "prompt",
                name: "提示词优化 / 反推 / 提示词库",
                entry: "配置卡或提示词面板 → 优化提示词；图片卡 → 反推提示词；左侧提示词库",
                when: "把简短描述扩写成提示词，或从图片反推提示词",
                how: "反推引擎可选 Qwen3.5-9B、Florence-2 PromptGen、云端 API；优化提示词使用当前提示词优化 API；提示词库可搜索",
                limits: "反推需要图片参考，输出文本；不会自动生成图片",
            },
            {
                id: "image-tools",
                name: "图片工具",
                entry: "图片卡悬浮工具",
                tools: ["复制提示词", "反推提示词", "替换图片", "锁/自由比例", "局部编辑", "裁剪", "切图", "放大", "AI 超分", "多角度", "四视图", "查看大图", "存资产", "存为风格"],
                multiAngle: "多角度是换机位生成新图，和四视图不同",
            },
            {
                id: "video",
                name: "视频工具",
                entry: "视频卡悬浮工具 / 视频工作台",
                tools: ["首尾帧 / 全能参考模式", "视频超分（SeedVR2）", "RIFE 插帧 2×/3×", "H3 角色替换", "极速草稿", "对比", "同步播放"],
                draft: "极速草稿用首尾帧快速预览，最终成片仍用 VDN 或多参工作流",
            },
            {
                id: "style-recipe",
                name: "风格配方",
                entry: "左侧「风格配方」页签；图片菜单 → 存为风格",
                how: "保存底模、LoRA 与案例图；套用时新建生成卡并还原独立 LoRA 卡和连线",
                limits: "不保存提示词、尺寸、张数；这些由生成卡自己设置",
            },
            {
                id: "lora",
                name: "LoRA 叠层",
                entry: "画布上的 LoRA 卡，连接到图片或视频卡",
                how: "单卡最多 10 条 LoRA，每条独立强度；生成时一起注入",
            },
            {
                id: "assets",
                name: "资产与自由卡片",
                entry: "左侧「资产」「自由卡片」；画布顶部可插入",
                how: "资产可复用为参考图；自由卡片可导入 ComfyUI 工作流",
            },
            {
                id: "node-types",
                name: "画布卡片类型",
                how: "图片、文本、配置、视频、音频、分组、自由卡片；配置卡负责模型/尺寸/数量/输入顺序，图片和视频卡负责生成与展示",
            },
        ],
        models: {
            image: imageModels,
            video: videoModels,
            audio: selectableModelsByCapability(config, "audio").map((value) => ({ value, label: modelOptionLabel(config, value) })),
            defaults: {
                image: modelOptionLabel(config, config.imageModel || config.model),
                video: modelOptionLabel(config, config.videoModel || config.model),
            },
        },
    };
}

export function compactCanvasState() {
    const snapshot = useAgentStore.getState().canvasContext?.snapshot;
    if (!snapshot) return { error: "当前不在画布页面，请先打开一个画布。" };
    return {
        projectId: snapshot.projectId,
        title: snapshot.title,
        selectedNodeIds: snapshot.selectedNodeIds,
        nodes: snapshot.nodes.slice(0, 120).map((node) => ({
            id: node.id,
            type: node.type,
            title: node.title,
            position: node.position,
            width: node.width,
            height: node.height,
            content: typeof node.metadata?.content === "string" ? node.metadata.content.slice(0, 2000) : "",
            prompt: typeof node.metadata?.prompt === "string" ? node.metadata.prompt.slice(0, 500) : "",
            model: node.metadata?.model || "",
            status: node.metadata?.status || "",
            generationMode: node.metadata?.generationMode || "",
            generationType: node.metadata?.generationType || "",
            imageMode: node.metadata?.imageMode || "",
            size: node.metadata?.size || "",
            count: node.metadata?.count || "",
            seed: node.metadata?.seed || "",
            seconds: node.metadata?.seconds || "",
            vquality: node.metadata?.vquality || "",
            videoMode: node.metadata?.videoMode || "",
            frameMode: node.metadata?.frameMode || "",
            aspectRatio: node.metadata?.aspectRatio || "",
            creationOutput: node.metadata?.creationOutput || null,
            creationPipeline: node.metadata?.creationPipeline || null,
            workbenchKind: node.metadata?.workbenchKind || "",
            agentCreation: node.metadata?.agentCreation ? {
                status: node.metadata.agentCreation.status, progress: node.metadata.agentCreation.progress,
                idea: node.metadata.agentCreation.idea?.slice(0, 2000), style: node.metadata.agentCreation.style,
            } : null,
            params: node.metadata?.params || null,
            freeCard: node.metadata?.freeCard ? { name: node.metadata.freeCard.name, workflowId: node.metadata.freeWorkflowId || "" } : null,
        })),
        connections: snapshot.connections.map((connection) => ({ id: connection.id, fromNodeId: connection.fromNodeId, toNodeId: connection.toNodeId })),
    };
}

export function cloudTools() {
    return [
        {
            type: "function",
            function: {
                name: "canvas_get_features",
                description: "返回画布功能目录：MOSS 区域布局、局部编辑、四视图、提示词优化/反推、图片工具、视频工具、风格配方、LoRA、资产与自由卡片，以及当前可用的生图/视频模型。只用于自己查，回答时摘 1-2 句，不要整段复述。",
                parameters: { type: "object", properties: {}, additionalProperties: false },
            },
        },
        {
            type: "function",
            function: {
                name: "canvas_get_state",
                description: "读取当前画布的节点、样线、选中项和视口。修改画布前先调用，获取真实节点 ID。",
                parameters: { type: "object", properties: {}, additionalProperties: false },
            },
        },
        {
            type: "function",
            function: {
                name: "canvas_apply_ops",
                description: "对当前画布批量执行操作。ops 支持 add_node、update_node、delete_node、delete_connections、connect_nodes、select_nodes、set_viewport、run_generation。单批最多 48 个操作、最多 4 个 run_generation；超过会被拒绝，请拆成小批次。新建生成卡时给 add_node 指定 id，再用 run_generation 指向该 id。文本卡用 nodeType=text、metadata.content 填写正文。建工作台用 nodeType=workbench，并在 metadata.workbenchKind 指明种类（storyboard 故事分镜导演台 / digital-human 数字人 / video-editor 视频剪辑台 / novel 小说 / agent-creation 一站式创作），漏写会退化成故事分镜导演台。工作台本身不产媒体，只是进入编辑面板的入口；要出片请用 video-editor 工作台卡或 run_generation。",
                parameters: {
                    type: "object",
                    properties: {
                        ops: {
                            type: "array",
                            description: "按顺序执行的操作列表",
                            items: {
                                type: "object",
                                properties: {
                                    type: { type: "string", enum: ["add_node", "update_node", "delete_node", "delete_connections", "connect_nodes", "select_nodes", "set_viewport", "run_generation"] },
                                    id: { type: "string" },
                                    ids: { type: "array", items: { type: "string" } },
                                    nodeId: { type: "string" },
                                    nodeType: { type: "string", description: "卡片类型：text、image、config、video、audio、workbench（工作台卡，必须同时在 metadata.workbenchKind 指明 storyboard / digital-human / video-editor / novel / agent-creation），以及 group、free-card、comfyui-lora:lora" },
                                    title: { type: "string" },
                                    position: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false },
                                    x: { type: "number" },
                                    y: { type: "number" },
                                    width: { type: "number" },
                                    height: { type: "number" },
                                    metadata: {
                                        type: "object",
                                        properties: {
                                            content: { type: "string", description: "文本卡的正文；新建或更新文本卡时填写此字段，不是 text" },
                                            prompt: { type: "string", description: "生成提示词" },
                                            model: { type: "string", description: "canvas_get_features 返回的模型 value" },
                                        },
                                        additionalProperties: true,
                                    },
                                    patch: { type: "object", additionalProperties: true },
                                    fromNodeId: { type: "string" },
                                    toNodeId: { type: "string" },
                                    viewport: { type: "object", additionalProperties: true },
                                    prompt: { type: "string" },
                                    mode: { type: "string" },
                                },
                                required: ["type"],
                                additionalProperties: true,
                            },
                        },
                    },
                    required: ["ops"],
                    additionalProperties: false,
                },
            },
        },
        {
            type: "function",
            function: {
                name: "site_navigate",
                description: "打开站内页面：/、/canvas、/canvas/:id、/image、/video、/assets、/config。",
                parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
            },
        },
    ];
}
