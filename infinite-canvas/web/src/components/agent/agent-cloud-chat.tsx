import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { App, Button, Popconfirm, Popover, Select, Tooltip } from "antd";
import { Bot, Gauge, LoaderCircle, MessagesSquare, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentChatComposer } from "./agent-chat-composer";
import { AgentChatMessage, AgentPendingToolCard, type AgentChatMessageItem } from "./agent-chat-message";
import { canvasFeatureCatalog, cloudTools, compactCanvasState } from "./agent-cloud-shared";
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
import { AGENT_CHAT_RECOVERY_KEY, applyApprovedCanvasOps, createChatPersistence, encodeChatRecoveryCheckpoint, recoverChatCheckpoint } from "@/lib/agent-chat-lifecycle";

import { MAX_CLOUD_IMAGES, MAX_CLOUD_IMAGE_PAYLOAD_BYTES, prepareCloudReferences, type CloudReferenceAttachment, type PreparedCloudReferences } from "@/lib/agent-cloud-references";

type CloudAttachment = CloudReferenceAttachment;
type CloudSubmission = PreparedCloudReferences & { text: string };
type ApiMessage = { role: "system" | "user" | "assistant" | "tool"; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string; name?: string; provider_metadata?: unknown };

const MAX_ATTACHMENTS = MAX_CLOUD_IMAGES;
const MAX_PAYLOAD_BYTES = MAX_CLOUD_IMAGE_PAYLOAD_BYTES;
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
    const recoveryCheckedRef = useRef(false);
    const [prompt, setPrompt] = useState("");
    const [attachments, setAttachments] = useState<CloudAttachment[]>([]);
    const [messages, setMessagesState] = useState<AgentChatMessageItem[]>([]);
    const [sending, setSending] = useState(false);
    const sendingRef = useRef(false);
    const mountedRef = useRef(true);
    const historyAttachmentsRef = useRef(new Map<string, CloudAttachment[]>());
    const messagesRef = useRef<AgentChatMessageItem[]>([]);
    const persistenceRef = useRef<ReturnType<typeof createChatPersistence<AgentChatMessageItem>> | null>(null);
    if (!persistenceRef.current) persistenceRef.current = createChatPersistence({
        save: (id, next) => useAgentChatStore.getState().saveMessages(id, next),
    });
    const setMessages = (update: AgentChatMessageItem[] | ((current: AgentChatMessageItem[]) => AgentChatMessageItem[])) => {
        // Keep the latest stream delta synchronous for pagehide/turn-end flushes.
        if (!mountedRef.current || loadedConversationRef.current !== activeId) return;
        const next = typeof update === "function" ? update(messagesRef.current) : update;
        messagesRef.current = next;
        setMessagesState(next);
        if (useAgentChatStore.getState().hydrated) persistenceRef.current?.stage(activeId, next);
    };
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
    const queueRef = useRef<CloudSubmission[]>([]);
    const preparationRef = useRef<AbortController | null>(null);
    const draftRef = useRef({ prompt, attachments });
    draftRef.current = { prompt, attachments };
    const [queueCount, setQueueCount] = useState(0);
    const confirmTools = useAgentStore((state) => state.confirmTools);
    const skin = useEffectiveCardSkin() as string;

    useEffect(() => {
        mountedRef.current = true;
        const state = useAgentStore.getState();
        if (state.canvasReferences.length || state.attachments.length) state.setAgentState({ canvasReferences: [], attachments: [] });
        const flushOnLeave = () => {
            const id = loadedConversationRef.current;
            if (!id || !useAgentChatStore.getState().hydrated) return;
            persistenceRef.current?.flush();
            try { localStorage.setItem(AGENT_CHAT_RECOVERY_KEY, encodeChatRecoveryCheckpoint(id, Date.now(), messagesRef.current)); } catch { /* storage quota cannot break close */ }
        };
        window.addEventListener("pagehide", flushOnLeave);
        return () => {
            flushOnLeave();
            window.removeEventListener("pagehide", flushOnLeave);
            mountedRef.current = false;
            preparationRef.current?.abort();
            useAgentStore.getState().setAgentState({ sending: false, waiting: false });
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
        if (!hydrated) return;
        if (!recoveryCheckedRef.current) {
            recoveryCheckedRef.current = true;
            try {
                const recovered = recoverChatCheckpoint(localStorage.getItem(AGENT_CHAT_RECOVERY_KEY), useAgentChatStore.getState().conversations);
                if (recovered) useAgentChatStore.getState().saveMessages(recovered.id, recovered.messages);
                localStorage.removeItem(AGENT_CHAT_RECOVERY_KEY);
            } catch { /* Keep the normal IndexedDB history on storage failures. */ }
        }
        const state = useAgentChatStore.getState();
        const active = state.conversations.find((conversation) => conversation.id === state.activeId);
        if (!active || loadedConversationRef.current === active.id) return;
        persistenceRef.current?.flush();
        loadedConversationRef.current = active.id;
        messagesRef.current = active.messages;
        setMessagesState(active.messages);
        apiMessagesRef.current = rebuildChatHistory(active.messages, id => historyAttachmentsRef.current.get(id));
        setError("");
    }, [conversations, activeId, hydrated]);
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

    const executeTool = async (name: string, input: Record<string, unknown>, signal: AbortSignal) => {
        if (name === "canvas_get_state") return compactCanvasState();
        if (name === "canvas_get_features") return canvasFeatureCatalog();
        if (name === "site_navigate") {
            const path = typeof input.path === "string" ? input.path : "/";
            if (!/^\/(?:$|projects$|canvas(?:\/[^/?#]+)?$|image$|video$|assets$|config$)/.test(path)) return { error: "只允许打开已知站内页面。" };
            navigate(path);
            return { ok: true, path };
        }
        if (name === "canvas_apply_ops") {
            const ops = Array.isArray(input.ops) ? (input.ops as CanvasAgentOp[]) : [];
            if (!ops.length) return { error: "ops 不能为空。" };
            const applied = await applyApprovedCanvasOps({
                ops,
                summary: summarizeCanvasAgentOps(ops) || "修改当前画布",
                confirmTools: useAgentStore.getState().confirmTools,
                readContext: () => useAgentStore.getState().canvasContext,
                requestApproval,
                signal,
            });
            if ("error" in applied) return applied;
            const result = applied.snapshot;
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

    const runChat = async (userText: string, userAttachments: CloudAttachment[], options: { source: "submit" | "queued" | "regenerate"; replaceHistory?: AgentChatMessageItem[]; submission?: CloudSubmission }) => {
        const { replaceHistory, submission } = options;
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
            "可创建的卡片：文本、图片、配置、视频、音频、分组、自由卡片（free-card）、LoRA 卡（comfyui-lora:lora）、工作台卡（workbench）。新建图片/视频卡后可用 connect_nodes 接 LoRA/参考/配置卡，再 run_generation。",
            "工作台卡示例：{\"type\":\"add_node\",\"id\":\"agent-wb-1\",\"nodeType\":\"workbench\",\"title\":\"视频剪辑台\",\"metadata\":{\"workbenchKind\":\"video-editor\"}}。workbenchKind 取值：storyboard（故事分镜导演台）、digital-human（数字人）、video-editor（视频剪辑台）、novel（小说）、agent-creation（一站式创作），漏写会退化成故事分镜导演台。工作台本身不产出媒体，只是进入编辑面板的入口；打开 video-editor 工作台会自动把画布上的视频铺成时间线，用户可一键合成成片。",
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
        const requestText = submission?.requestText ?? userText;
        const content: unknown = userAttachments.length
            ? [{ type: "text", text: requestText || "请查看这些图片。" }, ...userAttachments.map((item) => ({ type: "image_url", image_url: { url: item.dataUrl } }))]
            : requestText;
        apiMessagesRef.current.push({ role: "user", content });
        if (userAttachments.length) historyAttachmentsRef.current.set(turnId, userAttachments);
        setMessages(current => [...current, { id: turnId, turnId, role: "user", text: userText || (userAttachments.length ? `发送了 ${userAttachments.length} 张图片` : "引用了画布素材"), promptText: requestText, hasAttachments: userAttachments.length > 0, attachments: userAttachments.map(({ id, name, url }) => ({ id, name, url })), canvasReferences: submission?.canvasReferences }]);
        // submit() consumed only its captured draft after preparation succeeded.
        // Queued turns and regeneration must never erase a newer draft.
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
                        const result = await executeTool(name, input, controller.signal);
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
            persistenceRef.current?.flush();
            abortRef.current = null;
            sendingRef.current = false;
            if (!mountedRef.current) return;
            const next = controller.signal.aborted ? undefined : queueRef.current.shift();
            setQueueCount(queueRef.current.length);
            if (next) {
                void runChat(next.text, next.attachments, { source: "queued", submission: next });
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

    const submit = async () => {
        if (!canUse || preparationRef.current) return;
        const text = prompt.trim();
        const references = useAgentStore.getState().canvasReferences;
        if (!text && !attachments.length && !references.length) return;
        const conversationId = activeIdRef.current;
        const controller = new AbortController();
        preparationRef.current = controller;
        try {
            const prepared = await prepareCloudReferences({ text, attachments, references, readCanvas: () => useAgentStore.getState().canvasContext?.snapshot, signal: controller.signal });
            if (!mountedRef.current || controller.signal.aborted || activeIdRef.current !== conversationId) return;
            // Configuration may have changed while storage was being read; fail
            // before consuming the draft rather than losing unsent attachments.
            resolveAgentRuntime({ ...useDevAgentStore.getState(), transport: "cloud" }, activePromptCloudApi(useConfigStore.getState().config));
            const submission: CloudSubmission = { text, ...prepared };
            const queued = sendingRef.current;
            if (queued) {
                queueRef.current.push(submission);
                setQueueCount(queueRef.current.length);
            }
            // A changed draft (including reselected references) belongs to the
            // next message and must survive this asynchronous preparation.
            const state = useAgentStore.getState();
            if (draftRef.current.prompt === prompt && draftRef.current.attachments === attachments && state.canvasReferences === references) {
                setPrompt("");
                setAttachments([]);
                state.setAgentState({ canvasReferences: [] });
            }
            if (queued) message.success(t("agent.dev.queued", { count: queueRef.current.length }));
            else void runChat(text, prepared.attachments, { source: "submit", submission });
        } catch (err) {
            if (mountedRef.current && !controller.signal.aborted && activeIdRef.current === conversationId) {
                message.error(err instanceof Error ? err.message : t("agent.runtime.canvasImageReadFailed"));
            }
        } finally {
            if (preparationRef.current === controller) preparationRef.current = null;
        }
    };
    const stop = () => {
        preparationRef.current?.abort();
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
                void runChat(plan.user.text, images, { source: "regenerate", replaceHistory: plan.prefix, submission: { text: plan.user.text, requestText: plan.user.promptText ?? (images.length && /^发送了 \d+ 张图片$/.test(plan.user.text) ? "" : plan.user.text), attachments: images, canvasReferences: plan.user.canvasReferences || [] } });
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
