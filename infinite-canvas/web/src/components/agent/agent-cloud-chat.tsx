import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { App, Button, Popconfirm, Popover, Select, Tooltip } from "antd";
import { Bot, Gauge, LoaderCircle, MessagesSquare, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentChatComposer } from "./agent-chat-composer";
import { AgentChatMessage, AgentPendingToolCard, type AgentChatAttachment, type AgentChatMessageItem } from "./agent-chat-message";
import { summarizeCanvasAgentOps, type CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { canvasThemes } from "@/lib/canvas-theme";
import { useEffectiveCardSkin } from "@/lib/canvas/use-canvas-theme";
import { readImageMeta } from "@/lib/image-utils";
import { useAgentChatStore } from "@/stores/use-agent-chat-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useDevAgentStore } from "@/stores/use-dev-agent-store";
import { activePromptCloudApi, modelOptionLabel, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { resolveAgentRuntime, type AgentRuntime } from "@/lib/agent-cloud-config";
import { readAgentChatResponse, redactAgentError, type StreamDelta } from "@/lib/agent-chat-stream";
import { requestAgentChat } from "@/services/api/agent-cloud";
import { deleteHistoryMessage, rebuildChatHistory, regenerationPlan, requiresUnavailableAttachments } from "@/lib/agent-chat-history";

type CloudAttachment = AgentChatAttachment & { dataUrl: string; mimeType: string; size: number };
type ApiMessage = { role: "system" | "user" | "assistant" | "tool"; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string; name?: string; provider_metadata?: unknown };

const MAX_ATTACHMENTS = 6;
const MAX_PAYLOAD_BYTES = 30 * 1024 * 1024;
const MAX_TOOL_STEPS = 8;

function readFileDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

async function requestChatStream(params: {
    runtime: AgentRuntime; messages: ApiMessage[]; signal: AbortSignal;
    onDelta?: (delta: StreamDelta) => void;
}) {
    const response = await requestAgentChat(params.runtime, {
        model: params.runtime.model, messages: params.messages,
        tools: cloudTools(), tool_choice: "auto", stream: true,
    }, params.signal);
    return readAgentChatResponse(response, { signal: params.signal, onDelta: params.onDelta, apiKey: params.runtime.apiKey });
}

function canvasFeatureCatalog() {
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
            defaults: {
                image: modelOptionLabel(config, config.imageModel || config.model),
                video: modelOptionLabel(config, config.videoModel || config.model),
            },
        },
    };
}

function compactCanvasState() {
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
            params: node.metadata?.params || null,
            freeCard: node.metadata?.freeCard ? { name: node.metadata.freeCard.name, workflowId: node.metadata.freeWorkflowId || "" } : null,
        })),
        connections: snapshot.connections.map((connection) => ({ id: connection.id, fromNodeId: connection.fromNodeId, toNodeId: connection.toNodeId })),
    };
}

function AgentSettingToggle({ icon, title, description, checked, theme, onChange }: { icon: ReactNode; title: string; description: string; checked: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition"
            style={{ borderColor: checked ? theme.node.muted : theme.node.stroke, background: checked ? theme.toolbar.activeBg : "transparent", color: theme.node.text }}
            aria-pressed={checked}
            onClick={onChange}
        >
            <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0">{icon}</span>
                <span className="min-w-0">
                    <span className="block font-medium">{title}</span>
                    <span className="mt-0.5 block text-[11px] leading-4" style={{ color: theme.node.muted }}>{description}</span>
                </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-[11px]" style={{ color: theme.node.muted }}>
                {checked ? t("agent.dev.enabled") : t("agent.dev.disabled")}
                <span className="relative inline-flex h-4 w-7 items-center rounded-full transition" style={{ background: checked ? "#16a34a" : theme.node.stroke }}>
                    <span className="absolute size-3 rounded-full bg-white transition-all" style={{ left: checked ? 14 : 2 }} />
                </span>
            </span>
        </button>
    );
}

export function AgentCloudChat() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const location = useLocation();
    const config = useConfigStore((state) => state.config);
    const api = activePromptCloudApi(config);
    const conversations = useAgentChatStore((state) => state.conversations);
    const activeId = useAgentChatStore((state) => state.activeId);
    const hydrated = useAgentChatStore((state) => state.hydrated);
    const activeConversation = conversations.find((conversation) => conversation.id === activeId);
    const loadedConversationRef = useRef<string | null>(null);
    const lastSavedActiveIdRef = useRef(activeId);
    const [prompt, setPrompt] = useState("");
    const [attachments, setAttachments] = useState<CloudAttachment[]>([]);
    const [messages, setMessages] = useState<AgentChatMessageItem[]>([]);
    const [sending, setSending] = useState(false);
    const sendingRef = useRef(false);
    const mountedRef = useRef(true);
    const historyAttachmentsRef = useRef(new Map<string, CloudAttachment[]>());
    const messagesRef = useRef<AgentChatMessageItem[]>([]);
    messagesRef.current = messages;
    const activeIdRef = useRef(activeId);
    activeIdRef.current = activeId;
    const [pending, setPending] = useState<{ summary: string; resolve: (approved: boolean) => void } | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [error, setError] = useState("");
    const apiMessagesRef = useRef<ApiMessage[]>([]);
    const listRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const pendingRef = useRef<{ resolve: (approved: boolean) => void } | null>(null);
    const attachmentUrlsRef = useRef(new Set<string>());
    const scrollTimerRef = useRef<number | null>(null);
    const queueRef = useRef<Array<{ text: string; attachments: CloudAttachment[] }>>([]);
    const [queueCount, setQueueCount] = useState(0);
    const confirmTools = useAgentStore((state) => state.confirmTools);
    const skin = useEffectiveCardSkin() as string;

    useEffect(() => {
        mountedRef.current = true;
        const state = useAgentStore.getState();
        if (state.canvasReferences.length || state.attachments.length) state.setAgentState({ canvasReferences: [], attachments: [] });
        return () => {
            mountedRef.current = false;
            queueRef.current = [];
            historyAttachmentsRef.current.clear();
            pendingRef.current?.resolve(false);
            pendingRef.current = null;
            abortRef.current?.abort();
            attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
        };
    }, []);
    useEffect(() => {
        useAgentStore.getState().setAgentState({ sending, waiting: sending });
    }, [sending]);
    useEffect(() => {
        const state = useAgentChatStore.getState();
        const active = state.conversations.find((conversation) => conversation.id === state.activeId);
        if (!hydrated || !active || loadedConversationRef.current === active.id) return;
        loadedConversationRef.current = active.id;
        setMessages(active.messages);
        messagesRef.current = active.messages;
        apiMessagesRef.current = rebuildChatHistory(active.messages, id => historyAttachmentsRef.current.get(id));
        setError("");
    }, [conversations, activeId, hydrated]);
    useEffect(() => {
        if (!hydrated || sending || loadedConversationRef.current !== activeId || messagesRef.current !== messages) return;
        if (lastSavedActiveIdRef.current !== activeId) {
            lastSavedActiveIdRef.current = activeId;
            return;
        }
        useAgentChatStore.getState().saveMessages(activeId, messages);
    }, [messages, sending, activeId, hydrated]);
    useEffect(() => {
        // Switching a configured profile never probes the provider.
        setError("");
    }, [api?.id, api?.baseUrl, api?.apiKey, api?.model, api?.apiFormat]);
    useEffect(() => {
        if (scrollTimerRef.current !== null) return;
        scrollTimerRef.current = window.setTimeout(() => {
            scrollTimerRef.current = null;
            listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
        }, 80);
    }, [messages, pending, sending, error]);
    useEffect(() => () => {
        if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    }, []);

    const appendMessage = (item: Omit<AgentChatMessageItem, "id">) => {
        setMessages((current) => [...current, { ...item, id: `cloud-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }]);
    };

    const addAttachments = async (files: FileList | File[] | null) => {
        if (!files) return;
        const images = Array.from(files).filter((file) => file.type.startsWith("image/")).slice(0, Math.max(0, MAX_ATTACHMENTS - attachments.length));
        if (!images.length) return;
        try {
            const next = await Promise.all(images.map(async (file) => {
                const dataUrl = await readFileDataUrl(file);
                const meta = await readImageMeta(dataUrl);
                const url = URL.createObjectURL(file);
                attachmentUrlsRef.current.add(url);
                return { id: `cloud-att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: file.name, url, dataUrl, mimeType: file.type, size: file.size, width: meta.width, height: meta.height };
            }));
            const merged = [...attachments, ...next];
            if (merged.reduce((sum, item) => sum + item.size, 0) > MAX_PAYLOAD_BYTES) {
                next.forEach((item) => {
                    URL.revokeObjectURL(item.url);
                    attachmentUrlsRef.current.delete(item.url);
                });
                message.error(t("agent.runtime.imageLimit"));
                return;
            }
            setAttachments(merged);
        } catch (err) {
            message.error(err instanceof Error ? err.message : t("agent.runtime.imageReadFailed"));
        }
    };

    const removeAttachment = (id: string) => {
        setAttachments((current) => {
            const target = current.find((item) => item.id === id);
            if (target) {
                URL.revokeObjectURL(target.url);
                attachmentUrlsRef.current.delete(target.url);
            }
            return current.filter((item) => item.id !== id);
        });
    };

    const requestApproval = (summary: string) => new Promise<boolean>((resolve) => {
        pendingRef.current = { resolve };
        setPending({ summary, resolve });
    });

    const updateConfirmTools = (next: boolean) => {
        localStorage.setItem("canvas-agent-confirm-tools", next ? "1" : "0");
        useAgentStore.getState().setAgentState({ confirmTools: next });
    };

    const executeTool = async (name: string, input: Record<string, unknown>) => {
        if (name === "canvas_get_state") return compactCanvasState();
        if (name === "canvas_get_features") return canvasFeatureCatalog();
        if (name === "site_navigate") {
            const path = typeof input.path === "string" ? input.path : "/";
            if (!/^\/(?:$|projects$|canvas(?:\/[^/?#]+)?$|image$|video$|assets$|config$)/.test(path)) return { error: "只允许打开已知站内页面。" };
            navigate(path);
            return { ok: true, path };
        }
        if (name === "canvas_apply_ops") {
            const context = useAgentStore.getState().canvasContext;
            if (!context) return { error: "当前不在画布页面，请先打开一个画布。" };
            const ops = Array.isArray(input.ops) ? (input.ops as CanvasAgentOp[]) : [];
            if (!ops.length) return { error: "ops 不能为空。" };
            if (useAgentStore.getState().confirmTools) {
                const summary = summarizeCanvasAgentOps(ops) || "修改当前画布";
                const approved = await requestApproval(summary);
                if (!approved) return { error: "用户拒绝了本次画布操作。" };
            }
            const result = context.applyOps(ops);
            return {
                ok: true,
                nodeCount: result.nodes.length,
                connectionCount: result.connections.length,
                selectedNodeIds: result.selectedNodeIds,
                message: ops.some((op) => op.type === "run_generation") ? "已触发生成，任务在画布中运行。" : "画布已更新。",
            };
        }
        return { error: `未知工具：${name}` };
    };

    const runChat = async (userText: string, userAttachments: CloudAttachment[], replaceHistory?: AgentChatMessageItem[]) => {
        if (sendingRef.current || !mountedRef.current) return;
        let runtime: AgentRuntime;
        // Keep the centralized native-protocol cloud path independent of the optional pi runtime.
        // Local runtime discovery/provider injection lives in the runtime/config services; a saved
        // local-pi preference must not reroute this panel or grant it developer-mode tools.
        try { runtime = resolveAgentRuntime({ ...useDevAgentStore.getState(), transport: "cloud" }, activePromptCloudApi(useConfigStore.getState().config)); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); return; }
        if (replaceHistory) {
            messagesRef.current = replaceHistory;
            setMessages(replaceHistory);
            apiMessagesRef.current = rebuildChatHistory(replaceHistory, id => historyAttachmentsRef.current.get(id));
        }
        sendingRef.current = true;
        const turnId = `cloud-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setError("");
        setSending(true);
        const controller = new AbortController();
        abortRef.current = controller;
        const defaultImageModel = config.imageModel || config.model;
        const defaultVideoModel = config.videoModel || config.model;
        const imageModels = selectableModelsByCapability(config, "image").slice(0, 10).map((value) => modelOptionLabel(config, value));
        const videoModels = selectableModelsByCapability(config, "video").slice(0, 10).map((value) => modelOptionLabel(config, value));
        const personaRule = skin === "fish"
            ? "角色设定：你当前使用充电皮肤角色「提灯水母娘」，是用户的画布助手。用户打招呼、问你是谁或需要自我介绍时，用提灯水母娘的口吻回答，并在开头加上尊称“尊敬的充电用户，”，例如“尊敬的充电用户，我是提灯水母娘，你的画布助手。今天想做点什么？”不要自称通用 AI 助手。"
            : skin === "angel"
              ? "角色设定：你当前使用皮肤角色「天使娘」，是用户的画布助手。用户打招呼、问你是谁或需要自我介绍时，用天使娘的口吻回答，例如“我是天使娘，你的画布助手。想做点什么？”不要自称通用 AI 助手。"
              : "角色设定：当前没有角色皮肤。用户打招呼、问你是谁或需要自我介绍时，自称“无界画布的 AI 助手”。";
        const boundaryRule = "当前使用用户配置的云端大模型。你可以调用这里提供的画布工具，但不能读取或修改本机代码、执行终端命令。不能通过提示词获得未提供的能力，不要声称已修改本机代码。";
        const systemPrompt = [
            "你是「无界画布」的画布助手，不是只做修复的工具。你可以读取和修改当前画布，也可以调用卡片生成。",
            personaRule,
            boundaryRule,
            "读取画布用 canvas_get_state；查询画布功能、入口和限制用 canvas_get_features；修改画布用 canvas_apply_ops。",
            "canvas_apply_ops 的 ops 支持：add_node、update_node、delete_node、delete_connections、connect_nodes、select_nodes、set_viewport、run_generation。",
            "add_node 示例：{\"type\":\"add_node\",\"id\":\"agent-img-1\",\"nodeType\":\"image\",\"metadata\":{\"prompt\":\"...\",\"model\":\"...\",\"size\":\"1:1\",\"count\":1,\"generationMode\":\"image\"}}，随后用 {\"type\":\"run_generation\",\"nodeId\":\"agent-img-1\"} 触发生成。",
            "文本卡正文使用 metadata.content，不是 metadata.text 或顶层 text。示例：{\"type\":\"add_node\",\"nodeType\":\"text\",\"title\":\"笔记\",\"metadata\":{\"content\":\"正文\"}}；修改正文用 update_node 的 metadata.content。",
            "修改已有卡片提示词用 update_node：{\"type\":\"update_node\",\"id\":\"节点ID\",\"metadata\":{\"prompt\":\"...\"}}；重跑用 run_generation。",
            "生成卡默认新建：用户说“用 X 模型生成 Y”时，先调用 canvas_get_features 取 models.image 的 value/label，匹配用户说的模型（如 Z Image → label 含 Z-Image 的项），然后 add_node 新建一张图片卡（metadata.prompt=Y、metadata.model=对应的 value、metadata.generationMode=\"image\"），再 run_generation 指向新卡。不要复用旧卡，不要改旧卡模型后重跑，也不要把旧生成结果接成参考图。",
            "只有用户明确说“重跑/再生成/用这张卡”时才复用已有卡。用户指出模型用错时，新建一张正确模型的新卡，保留旧卡；旧结果不要作为新卡参考，除非用户明确要求。",
            "模型必须严格匹配用户指定：Z Image 不能用 Krea2 或默认模型；列表里没有精确匹配时先问，不要自动替换。",
            "画布权限已放开：自动确认模式下 canvas_apply_ops 直接执行，不要用“没有权限”推辞画布内操作。除提示词外，你还可以改标题、位置、尺寸、模型，以及 metadata 里的生成参数（size、count、seed、seconds、vquality、videoMode、frameMode、imageMode、aspectRatio、params.loras 等）；先 canvas_get_state 读取 params，再 update_node 写回。",
            "可创建的卡片：文本、图片、配置、视频、音频、分组、自由卡片（free-card）、LoRA 卡（comfyui-lora:lora）。新建图片/视频卡后可用 connect_nodes 接 LoRA/参考/配置卡，再 run_generation。",
            "步数由模型型号或档位决定，不是所有卡片都能通过 metadata 改；不要承诺给任意图片卡增加步数控件。",
            "执行任何画布写入前先调用 canvas_get_state 获取真实节点 ID，不要编造 ID。",
            "画布功能索引（用户问具体功能时先调用 canvas_get_features 获取入口、步骤和限制，不要凭记忆说不知道或编造）：MOSS 区域布局、局部编辑（蒙版）、四视图、提示词优化/反推、裁剪、切图、放大、AI 超分、多角度、替换图片；视频首尾帧/全能参考、视频超分、RIFE 插帧、角色替换、极速草稿；风格配方、LoRA 叠层、自由卡片、资产库、提示词库。",
            "关键区分：MOSS 区域布局是在 MOSS 图上画多个区域并分别写提示词，背景先画、主体/文字后画，仅 MOSS 模型；局部编辑是用蒙版只改图片的一块区域。四视图是从角色图生成一张四视图设定图（固定 image-krea2-four-view），不是四张普通图，也不是多角度。",
            "回答画布功能时，优先使用 canvas_get_features 返回的 name/entry/how/limits 原文；不要用通用模型知识替代画布的实际入口和固定工作流（尤其四视图和 MOSS 区域布局）。",
            "提示词：优化提示词在配置卡/提示词面板；反推提示词在图片卡，引擎可选 Qwen3.5-9B、Florence-2 PromptGen、云端 API；提示词库在左侧。写提示词时覆盖主体、构图、光线、色彩、材质、镜头和氛围，给可直接使用的完整提示词，不要只给一句短句。",
            "生成前的模型规则：如果用户在当前消息或最近对话里已经指定了模型（型号、别名、带空格或连字符的写法如 Z image / Z-Image 都算），或者用户用“对的/是的/确认/用这个”同意你上一轮提议的模型，就直接执行，不要重复询问，也不要要求用户写出完整模型名；只有完全没指定也没确认时才问。执行时必须使用用户指定或确认的那个模型，不能换成 Krea2、默认模型或其他模型。",
            "工具执行边界：canvas_apply_ops 可直接读取/改节点/连线/选中/视口/run_generation；区域布局编辑器、局部编辑、四视图、提示词优化/反推、视频超分/插帧等是独立 UI，能说明入口，不要声称已执行。",
            `默认生图模型：${modelOptionLabel(config, defaultImageModel)}；默认视频模型：${modelOptionLabel(config, defaultVideoModel)}。`,
            `可用生图模型：${imageModels.join("、") || "无"}。`,
            `可用视频模型：${videoModels.join("、") || "无"}。`,
            `当前页面：${location.pathname}。需要切换页面时用 site_navigate。`,
            "生成任务只是触发，未返回结果前不要声称已经生成完成。",
            "回答风格（重要）：语气可以轻松可爱，但必须简短、直接。默认 1-3 句话；复杂操作最多 3 个短点。不要复述用户的话，不要解释原理，不要列通用建议清单；只有用户明确说“详细/展开”才展开。功能问题只答入口+一句用法；操作完成只报结果和下一步。canvas_get_features 是给你自己查的，不要把整段贴给用户。",
        ].join("\n");
        const systemMessage: ApiMessage = { role: "system", content: systemPrompt };
        if (apiMessagesRef.current[0]?.role === "system") apiMessagesRef.current[0] = systemMessage;
        else apiMessagesRef.current.unshift(systemMessage);
        const content: unknown = userAttachments.length
            ? [{ type: "text", text: userText || "请查看这些图片。" }, ...userAttachments.map((item) => ({ type: "image_url", image_url: { url: item.dataUrl } }))]
            : userText;
        apiMessagesRef.current.push({ role: "user", content });
        if (userAttachments.length) historyAttachmentsRef.current.set(turnId, userAttachments);
        setMessages(current => [...current, { id: turnId, turnId, role: "user", text: userText || (userAttachments.length ? `发送了 ${userAttachments.length} 张图片` : ""), promptText: userText, hasAttachments: userAttachments.length > 0, attachments: userAttachments.map(({ id, name, url }) => ({ id, name, url })) }]);
        // Regenerating must not erase an unrelated draft currently in the composer.
        if (!replaceHistory) { setPrompt(""); setAttachments([]); }
        let liveId: string | null = null;
        let allReasoning = "";
        const ensureLive = () => {
            if (liveId) return liveId;
            liveId = `cloud-live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const id = liveId;
            setMessages((current) => [...current, { id, turnId, role: "assistant", text: "", reasoning: "", streamId: id }]);
            return id;
        };
        const patchLive = (patch: Partial<AgentChatMessageItem>) => {
            if (!liveId) return;
            const id = liveId;
            setMessages((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
        };
        try {
            for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
                let roundContent = "";
                let roundReasoning = "";
                const reply = await requestChatStream({
                    runtime,
                    messages: apiMessagesRef.current,
                    signal: controller.signal,
                    onDelta: (delta) => {
                        if (delta.reasoning) {
                            roundReasoning += delta.reasoning;
                            allReasoning += delta.reasoning;
                            const id = ensureLive();
                            patchLive({ reasoning: allReasoning, streamId: id });
                        }
                        if (delta.content) {
                            roundContent += delta.content;
                            const id = ensureLive();
                            patchLive({ text: roundContent, streamId: id });
                        }
                    },
                });
                if (reply.reasoning && !roundReasoning) {
                    allReasoning += reply.reasoning;
                    const id = ensureLive();
                    patchLive({ reasoning: allReasoning, streamId: id });
                }
                if (reply.content && !roundContent) {
                    roundContent = reply.content;
                    const id = ensureLive();
                    patchLive({ text: roundContent, streamId: id });
                }
                const toolCalls = reply.toolCalls;
                if (toolCalls.length) {
                    apiMessagesRef.current.push({ role: "assistant", content: reply.content || null, provider_metadata: reply.providerMetadata, ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}), tool_calls: toolCalls.map(call => ({ ...call, type: "function" })) });
                    patchLive({ text: "" });
                    for (const call of toolCalls) {
                        const name = call.function?.name || "";
                        let input: Record<string, unknown> = {};
                        try {
                            input = JSON.parse(call.function?.arguments || "{}") as Record<string, unknown>;
                        } catch { input = {}; }
                        if (controller.signal.aborted) throw new DOMException("Canceled", "AbortError");
                        const result = await executeTool(name, input);
                        apiMessagesRef.current.push({ role: "tool", tool_call_id: call.id || "", content: JSON.stringify(result) });
                    }
                    continue;
                }
                const answer = reply.content.trim();
                if (!answer) throw new Error("API 返回了空消息。");
                apiMessagesRef.current.push({ role: "assistant", content: answer, provider_metadata: reply.providerMetadata });
                ensureLive();
                patchLive({ text: answer, reasoning: allReasoning || undefined, streamId: undefined });
                liveId = null;
                return;
            }
            ensureLive();
            patchLive({ text: "工具调用次数过多，已停止本轮操作。", reasoning: allReasoning || undefined, streamId: undefined });
            liveId = null;
        } catch (err) {
            if (liveId) {
                patchLive({ streamId: undefined });
                liveId = null;
            }
            if (controller.signal.aborted) {
                appendMessage({ role: "system", text: t("agent.runtime.taskStopped") });
            } else {
                const text = redactAgentError(err instanceof Error ? err.message : String(err), runtime.apiKey);
                setError(text);
                appendMessage({ role: "error", text });
            }
            // Partial tool-call turns are not valid inputs for the next API call.
            // Keep the existing visible history but drop incomplete assistant/tool pairs.
            apiMessagesRef.current = apiMessagesRef.current.filter(item => item.role !== "tool" && !item.tool_calls);
        } finally {
            abortRef.current = null;
            sendingRef.current = false;
            if (!mountedRef.current) return;
            const next = controller.signal.aborted ? undefined : queueRef.current.shift();
            setQueueCount(queueRef.current.length);
            if (next) {
                void runChat(next.text, next.attachments);
            } else {
                setSending(false);
            }
        }
    };

    let runtimeForDisplay: AgentRuntime | null = null;
    try { runtimeForDisplay = resolveAgentRuntime({ ...useDevAgentStore.getState(), transport: "cloud" }, api); } catch { /* The empty-state text points to central configuration. */ }
    const canUse = runtimeForDisplay !== null && hydrated;
    const modelLabel = runtimeForDisplay?.model || t("agent.cloud.notConfigured");
    const contextChars = messages.reduce((total, item) => total + item.text.length + (item.reasoning?.length || 0), 0) + prompt.length;
    const contextTokens = Math.ceil(contextChars / 4);
    const snapshot = useAgentStore((state) => state.canvasContext?.snapshot);

    const submit = () => {
        if (!canUse) return;
        const text = prompt.trim();
        if (!text && !attachments.length) return;
        if (sendingRef.current) {
            queueRef.current.push({ text, attachments });
            setQueueCount(queueRef.current.length);
            setPrompt("");
            setAttachments([]);
            message.success(t("agent.dev.queued", { count: queueRef.current.length }));
            return;
        }
        void runChat(text, attachments);
    };
    const stop = () => {
        queueRef.current = [];
        setQueueCount(0);
        pendingRef.current?.resolve(false);
        pendingRef.current = null;
        setPending(null);
        abortRef.current?.abort();
    };
    const editDialogRef = useRef(false);
    const replaceMessages = (next: AgentChatMessageItem[]) => {
        messagesRef.current = next;
        setMessages(next);
        apiMessagesRef.current = rebuildChatHistory(next, id => historyAttachmentsRef.current.get(id));
        useAgentChatStore.getState().saveMessages(activeIdRef.current, next);
        setError("");
    };
    const deleteMessage = (id: string) => {
        if (sendingRef.current || pendingRef.current || editDialogRef.current) return;
        const conversationId = activeIdRef.current;
        editDialogRef.current = true;
        modal.confirm({
            title: t("agent.message.deleteMessageConfirm"), content: t("agent.message.deleteMessageDescription"),
            okText: t("agent.message.deleteMessage"), cancelText: t("common.cancel"), okButtonProps: { danger: true },
            afterClose: () => { editDialogRef.current = false; },
            onOk: () => {
                if (sendingRef.current || conversationId !== activeIdRef.current || !mountedRef.current) return;
                const current = messagesRef.current;
                const next = deleteHistoryMessage(current, id);
                if (next === current) return; // A stale selector must not delete any history.
                for (const removed of current.slice(next.length)) {
                    historyAttachmentsRef.current.delete(removed.id);
                }
                queueRef.current = [];
                setQueueCount(0);
                replaceMessages(next);
            },
        });
    };
    const regenerateMessage = (id: string) => {
        if (sendingRef.current || pendingRef.current || editDialogRef.current || !canUse) return;
        const initial = regenerationPlan(messagesRef.current, id);
        if (!initial) { message.warning(t("agent.message.noUserPrompt")); return; }
        if (requiresUnavailableAttachments(initial.user, historyAttachmentsRef.current.get(initial.user.id))) {
            message.warning(t("agent.message.attachmentsExpired")); return;
        }
        const conversationId = activeIdRef.current;
        editDialogRef.current = true;
        modal.confirm({
            title: t("agent.message.regenerateConfirm"), content: t("agent.message.regenerateDescription"),
            okText: t("agent.message.regenerate"), cancelText: t("common.cancel"),
            afterClose: () => { editDialogRef.current = false; },
            onOk: () => {
                if (sendingRef.current || conversationId !== activeIdRef.current || !mountedRef.current) return;
                const plan = regenerationPlan(messagesRef.current, id);
                if (!plan) return;
                const images = historyAttachmentsRef.current.get(plan.user.id) || [];
                if (requiresUnavailableAttachments(plan.user, images)) { message.warning(t("agent.message.attachmentsExpired")); return; }
                queueRef.current = [];
                setQueueCount(0);
                void runChat(plan.user.promptText ?? (images.length && /^发送了 \d+ 张图片$/.test(plan.user.text) ? "" : plan.user.text), images, plan.prefix);
            },
        });
    };
    const newConversation = () => {
        if (sendingRef.current) return;
        useAgentChatStore.getState().createConversation();
    };
    const switchConversation = (id: string) => {
        if (sendingRef.current) return;
        useAgentChatStore.getState().selectConversation(id);
    };
    const deleteConversation = (id: string) => {
        if (sendingRef.current) return;
        useAgentChatStore.getState().deleteConversation(id);
    };

    const conversationMenu = (
        <div className="w-64 text-xs" style={{ color: theme.node.text }}>
            <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
                onClick={newConversation}
            >
                <Plus className="size-3.5" />
                {t("agent.dev.newChat")}
            </button>
            <div className="thin-scrollbar mt-1 max-h-64 overflow-y-auto">
                {conversations.map((conversation) => (
                    <div
                        key={conversation.id}
                        className="group flex items-center gap-1 rounded-lg px-2 py-1.5 transition hover:bg-black/5 dark:hover:bg-white/10"
                        style={{ background: conversation.id === activeId ? theme.toolbar.activeBg : "transparent", color: conversation.id === activeId ? theme.toolbar.activeText : theme.node.text }}
                    >
                        <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => switchConversation(conversation.id)} title={conversation.title}>
                            {conversation.title}
                        </button>
                        {conversations.length > 1 ? (
                            <Popconfirm title={t("agent.dev.deleteChat")} okText={t("agent.dev.delete")} cancelText={t("agent.dev.cancel")} onConfirm={() => deleteConversation(conversation.id)}>
                                <button type="button" className="grid size-5 shrink-0 place-items-center rounded opacity-0 transition group-hover:opacity-70 hover:opacity-100" aria-label={t("agent.dev.delete")}>
                                    <Trash2 className="size-3" />
                                </button>
                            </Popconfirm>
                        ) : null}
                    </div>
                ))}
            </div>
        </div>
    );
    const contextPanel = (
        <div className="w-64 space-y-1.5 text-xs" style={{ color: theme.node.text }}>
            {[
                [t("agent.dev.contextAgent"), t("agent.cloud.mode")],
                [t("agent.dev.contextModel"), modelLabel],
                [t("config.cloudApi.apiFormat"), t(`config.cloudApi.formats.${api?.apiFormat || "openai"}`)],
                [t("agent.dev.contextSession"), `${activeConversation?.title || t("agent.dev.newChat")} · ${t("agent.dev.messages", { count: messages.length })}`],
                [t("agent.dev.contextCanvas"), `${snapshot?.nodes.length || 0} ${t("agent.dev.nodes")} · ${snapshot?.connections.length || 0} ${t("agent.dev.connections")}`],
                [t("agent.dev.contextTokens"), t("agent.dev.tokens", { count: contextTokens.toLocaleString() })],
                [t("agent.dev.contextSkills"), t("agent.cloud.skills")],
            ].map(([label, value]) => (
                <div key={String(label)} className="flex items-start justify-between gap-3">
                    <span className="shrink-0" style={{ color: theme.node.muted }}>{label}</span>
                    <span className="min-w-0 truncate text-right" title={String(value)}>{value}</span>
                </div>
            ))}
            <div className="pt-1 text-[11px] leading-5" style={{ color: theme.node.muted }}>{t("agent.dev.contextNote")}</div>
        </div>
    );

    return (
        <div className="flex h-full min-h-0 flex-col" style={{ color: theme.node.text }}>
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: theme.node.stroke }}>
                <span className="grid size-7 place-items-center rounded-full" style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}>
                    <Bot className="size-4" />
                </span>
                <div className="min-w-0 flex-1" data-agent-drag-handle style={{ touchAction: "none", userSelect: "none", cursor: "grab" }} title={t("agent.cloud.dragTitle")} aria-label={t("agent.cloud.dragTitle")}>
                    <div className="flex items-center gap-1.5 text-sm font-semibold leading-5">
                        <span>{t("agent.cloud.mode")}</span>
                    </div>
                    <div className="truncate text-[10px] leading-4" style={{ color: theme.node.muted }}>
                        {modelLabel} · {activeConversation?.title || t("agent.dev.newChat")}
                    </div>
                </div>
                <Popover trigger="click" placement="bottomRight" content={conversationMenu}>
                    <Tooltip title={t("agent.dev.switchConversation")}>
                        <Button type="text" size="small" className="!h-7 !w-7 !min-w-7 !px-0" icon={<MessagesSquare className="size-4" />} aria-label={t("agent.dev.switchConversation")} />
                    </Tooltip>
                </Popover>
                <Popover trigger="click" placement="bottomRight" content={contextPanel}>
                    <Tooltip title={t("agent.dev.context")}>
                        <Button type="text" size="small" className="!h-7 !w-7 !min-w-7 !px-0" icon={<Gauge className="size-4" />} aria-label={t("agent.dev.context")} />
                    </Tooltip>
                </Popover>
                <Tooltip title={t("agent.permissions.title")}>
                    <Button type="text" size="small" className="!h-7 !w-7 !min-w-7 !px-0" icon={<ShieldCheck className="size-4" />} onClick={() => setSettingsOpen((open) => !open)} aria-label={t("agent.permissions.title")} />
                </Tooltip>
            </div>
            <div className="shrink-0 border-b px-3 py-2" style={{ borderColor: theme.node.stroke }}>
                <Select
                    className="w-full"
                    value={api?.id}
                    placeholder={t("agent.cloud.selectModel")}
                    disabled={sending}
                    aria-label={t("agent.cloud.selectModel")}
                    notFoundContent={t("agent.cloud.configurationHint")}
                    options={(config.promptCloudApis || []).map((item) => ({
                        value: item.id,
                        label: `${item.name || t("config.cloudApi.unnamed")} · ${item.model || "—"} · ${t(`config.cloudApi.formats.${item.apiFormat || "openai"}`)}`,
                    }))}
                    onChange={(id) => useConfigStore.getState().selectPromptCloudApi(id)}
                />
                {!canUse ? <p className="mt-1.5 text-[11px] leading-5" style={{ color: theme.node.muted }}>{t("agent.cloud.configurationHint")}</p> : null}
            </div>
            {settingsOpen ? (
                <div className="shrink-0 border-b px-4 py-2.5 text-xs" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                    <AgentSettingToggle
                        icon={<ShieldCheck className="size-4" />}
                        title={t("agent.permissions.canvasTitle")}
                        description={t("agent.permissions.canvasDescription")}
                        checked={confirmTools}
                        theme={theme}
                        onChange={() => updateConfirmTools(!confirmTools)}
                    />
                    <p className="mt-2 text-[11px] leading-5" style={{ color: theme.node.muted }}>{t("agent.cloud.privacy")}</p>
                </div>
            ) : null}
            <div ref={listRef} className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {!messages.length && !pending && !sending ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                        <Bot className="size-8 opacity-35" />
                        <div className="text-sm font-medium">{t("agent.cloud.emptyTitle")}</div>
                        <div className="text-xs leading-5" style={{ color: theme.node.muted }}>{t(canUse ? "agent.cloud.emptyHint" : "agent.cloud.configurationHint")}</div>
                    </div>
                ) : null}
                <div className="space-y-4">
                    {messages.map((item) => <AgentChatMessage key={item.id} item={item} theme={theme}
                        onRegenerate={regenerateMessage} onDelete={deleteMessage}
                        actionsDisabled={sending || Boolean(pending)}
                        regenerateDisabled={!canUse || !regenerationPlan(messages, item.id)} />)}
                    {pending ? <AgentPendingToolCard summary={pending.summary} theme={theme} onReject={() => { pending.resolve(false); pendingRef.current = null; setPending(null); }} onApprove={() => { pending.resolve(true); pendingRef.current = null; setPending(null); }} /> : null}
                    {sending ? (
                        <div className="flex items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                            <LoaderCircle className="size-3.5 animate-spin" />
                            {t("agent.cloud.thinking")}
                        </div>
                    ) : null}
                    {error ? <div className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: "rgba(220,38,38,.35)", color: "#dc2626" }}>{error}</div> : null}
                </div>
            </div>
            {queueCount ? (
                <div className="px-4 pb-1 text-[11px]" style={{ color: theme.node.muted }}>{t("agent.dev.queued", { count: queueCount })}</div>
            ) : null}
            <AgentChatComposer
                prompt={prompt}
                attachments={attachments.map(({ id, name, url }) => ({ id, name, url }))}
                disabled={!canUse}
                sending={sending}
                placeholder={canUse ? t("agent.cloud.placeholder") : t("agent.cloud.notConfigured")}
                theme={theme}
                onPromptChange={setPrompt}
                onSubmit={submit}
                onStop={stop}
                onAddFiles={addAttachments}
                onRemoveAttachment={removeAttachment}
                confirmTools={confirmTools}
                onConfirmToolsChange={updateConfirmTools}
            />
        </div>
    );
}

function cloudTools() {
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
                description: "对当前画布批量执行操作。ops 支持 add_node、update_node、delete_node、delete_connections、connect_nodes、select_nodes、set_viewport、run_generation。新建生成卡时给 add_node 指定 id，再用 run_generation 指向该 id。文本卡用 nodeType=text、metadata.content 填写正文。",
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
                                    nodeType: { type: "string", description: "卡片类型，如 text、image、config、video、audio、group、free-card、comfyui-lora:lora" },
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
