import { useMemo, type CSSProperties } from "react";
import { Image as ImageIcon, LoaderCircle, MessageSquare, Music2, Play, Settings2, Square, Video } from "lucide-react";
import { Button, Segmented } from "antd";
import { useTranslation } from "react-i18next";

import { BaseModelPicker, WorkflowModelPicker } from "@/components/model-picker";
import { AudioModeSelect } from "@/components/audio-settings-panel";
import { CONFIG_COMPOSER_ENABLED } from "@/constant/canvas";
import { LOCAL_ONLY } from "@/constant/app-mode";
import { defaultConfig, modelOptionLabel, resolveModelForCapability, selectableModelsByCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { videoModelForWorkflow, videoModelModePatch, videoWorkflowId, isNoVdnWorkflowId } from "@/lib/canvas/video-model-mode";
import { audioModeForModel, audioModelForMode } from "@/lib/audio-generation";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number };
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string) => void;
    onStop: (nodeId: string) => void;
    onComposerToggle: () => void;
    onOpenMaskEditor?: (nodeId: string) => void;
    onOpenOutpaintEditor?: (nodeId: string) => void;
    onOpenMossLayoutEditor?: (nodeId: string) => void;
};

export function CanvasConfigNodePanel({ node, isRunning, inputSummary, onConfigChange, onGenerate, onStop, onComposerToggle, onOpenMaskEditor, onOpenOutpaintEditor, onOpenMossLayoutEditor }: CanvasConfigNodePanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = useCanvasTheme();
    const mode = node.metadata?.generationMode || "image";
    const config = buildNodeConfig(globalConfig, node, mode);
    // 音频卡片里的「工作流」下拉：本地网关的音频工作流模型，带渠道前缀。
    const audioWorkflowOptions = useMemo(
        () => selectableModelsByCapability(globalConfig, "audio").map((value) => ({ value, label: modelOptionLabel(globalConfig, value) })),
        [globalConfig],
    );
    const chipStyle = { background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text };
    const frameMode: "first" | "last" | "both" =
        node.metadata?.frameMode === "last" || node.metadata?.frameMode === "both" || node.metadata?.frameMode === "first"
            ? node.metadata.frameMode
            : inputSummary.imageCount >= 2
              ? "both"
              : "first";
    const changeVideoMode = (value: "text" | "frames" | "reference") => {
        if (videoWorkflowId(config, config.model) === "video-h3-fast") {
            onConfigChange(node.id, { videoMode: value, ...(value === "frames" ? { frameMode } : {}) });
            return;
        }
        const baseId = value === "reference" ? "video-h3-ref2va" : value === "frames" ? "video-h3-frames" : "video-h3-t2v";
        const nextModel = videoModelForWorkflow(config, baseId, { noVdn: isNoVdnWorkflowId(videoWorkflowId(config, config.model)) });
        onConfigChange(node.id, { ...(nextModel ? { model: nextModel } : {}), videoMode: value, ...(value === "frames" ? { frameMode } : {}) });
    };
    const hasAnyInput = Boolean(inputSummary.textCount || inputSummary.imageCount || inputSummary.videoCount || inputSummary.audioCount);
    const hasComposerContent = Boolean((node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim());
    const canGenerate = hasComposerContent || (mode === "audio" ? inputSummary.textCount > 0 : hasAnyInput);

    return (
        <div className="flex h-full w-full cursor-move flex-col px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="shrink-0 text-sm font-semibold">{t("canvas.configNode.title")}</div>
                <div className="cursor-default" style={{ "--canvas-node-text": theme.node.text } as CSSProperties} onMouseDown={(event) => event.stopPropagation()}>
                    <Segmented
                        size="small"
                        className="canvas-config-mode !rounded-md !p-0.5"
                        value={mode}
                        onChange={(value) => onConfigChange(node.id, { generationMode: value as CanvasGenerationMode })}
                        options={[
                            {
                                value: "image",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <ImageIcon className="size-3.5" />
                                        {t("canvas.configNode.image")}
                                    </span>
                                ),
                            },
                            {
                                value: "text",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <MessageSquare className="size-3.5" />
                                        {t("canvas.configNode.text")}
                                    </span>
                                ),
                            },
                            {
                                value: "video",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Video className="size-3.5" />
                                        {t("canvas.configNode.video")}
                                    </span>
                                ),
                            },
                            {
                                value: "audio",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Music2 className="size-3.5" />
                                        {t("canvas.configNode.audio")}
                                    </span>
                                ),
                            },
                        ].filter((option) => !LOCAL_ONLY || option.value === "image" || option.value === "video")}
                    />
                </div>
            </div>

            <div className="mb-2 flex flex-wrap gap-1.5">
                <InputChip label={t("canvas.configNode.prompt")} value={t("canvas.configNode.items", { count: inputSummary.textCount })} style={chipStyle} />
                <InputChip label={t("canvas.configNode.references")} value={t("canvas.configNode.images", { count: inputSummary.imageCount })} style={chipStyle} />
                <InputChip label={t("canvas.configNode.videoReferences")} value={t("canvas.configNode.items", { count: inputSummary.videoCount })} style={chipStyle} />
                {!LOCAL_ONLY ? <InputChip label={t("canvas.configNode.audioReferences")} value={t("canvas.configNode.items", { count: inputSummary.audioCount })} style={chipStyle} /> : null}
                {CONFIG_COMPOSER_ENABLED ? (
                    <button type="button" className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px]" style={chipStyle} onMouseDown={(event) => event.stopPropagation()} onClick={onComposerToggle}>
                        <Settings2 className="size-3.5" />
                        {t("canvas.configNode.compose")}
                    </button>
                ) : null}
            </div>

            {mode === "audio" ? (
                // 卡片底部放操作类型，工作流与参数收进齿轮弹层。
                <div className="mb-2 flex min-w-0 cursor-default items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
                    <AudioModeSelect
                        config={config}
                        theme={theme}
                        className="min-w-0 flex-1"
                        onChange={(nextMode) => {
                            const nextModel = audioModelForMode(nextMode, audioWorkflowOptions.map((option) => option.value));
                            onConfigChange(node.id, { audioMode: nextMode, ...(nextModel ? { model: nextModel } : {}) });
                        }}
                    />
                    <CanvasAudioSettingsPopover
                        config={config}
                        placement="topRight"
                        compact
                        buttonClassName="canvas-compact-control !h-10 !w-10 !min-w-10 !rounded-lg !p-0"
                        onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))}
                        workflowOptions={audioWorkflowOptions}
                        onWorkflowChange={(model) => {
                            const nextMode = audioModeForModel(model);
                            onConfigChange(node.id, nextMode ? { model, audioMode: nextMode } : { model });
                        }}
                        onMissingConfig={() => openConfigDialog(true)}
                    />
                </div>
            ) : (
                <div className="mb-2 grid min-w-0 cursor-default grid-cols-[minmax(0,1fr)_148px] items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
                    <div className="flex min-w-0 flex-col gap-1">
                        <WorkflowModelPicker className="canvas-compact-control h-10" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, mode === "video" ? videoModelModePatch(config, model) : { model })} capability={mode} onMissingConfig={() => openConfigDialog(true)} fullWidth />
                        <BaseModelPicker className="canvas-compact-control h-10" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} fullWidth />
                    </div>
                    {mode === "video" ? (
                        <CanvasVideoSettingsPopover
                            config={config}
                            placement="topRight"
                            buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2"
                            onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))}
                            frameMode={frameMode}
                            onFrameModeChange={(value) => onConfigChange(node.id, { frameMode: value })}
                            onModeChange={changeVideoMode}
                        />
                    ) : mode === "image" ? (
                        <CanvasImageSettingsPopover config={config} placement="topRight" autoAdjustOverflow={false} buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })} onParamsChange={(params) => onConfigChange(node.id, { params: { ...node.metadata?.params, ...params } })} onOpenMaskEditor={() => onOpenMaskEditor?.(node.id)} onOpenOutpaintEditor={() => onOpenOutpaintEditor?.(node.id)} onOpenMossLayoutEditor={() => onOpenMossLayoutEditor?.(node.id)} />
                    ) : (
                        <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                    )}
                </div>
            )}

            <Button
                type="primary"
                className="mt-auto !h-9 !w-full !cursor-pointer !rounded-lg"
                danger={isRunning}
                disabled={!isRunning && !canGenerate}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => (isRunning ? onStop(node.id) : onGenerate(node.id))}
            >
                <span className="inline-flex items-center gap-1.5">
                    {isRunning ? (
                        <>
                            <LoaderCircle className="size-4 animate-spin" />
                            <Square className="size-3.5 fill-current" />
                            <span>{t("canvas.configNode.stop")}</span>
                        </>
                    ) : (
                        <>
                            <Play className="size-4" />
                            <span>{t("canvas.configNode.generate")}</span>
                        </>
                    )}
                </span>
            </Button>
        </div>
    );
}

function InputChip({ label, value, style }: { label: string; value: string; style: CSSProperties }) {
    return (
        <div className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]" style={style}>
            <span>{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? "",
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        videoMode: node.metadata?.videoMode || globalConfig.videoMode || defaultConfig.videoMode,
        frameMode: node.metadata?.frameMode,
        imageMode: node.metadata?.imageMode || globalConfig.imageMode || "",
        outpaint: node.metadata?.outpaint || globalConfig.outpaint,
        layout: node.metadata?.layout || globalConfig.layout,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        audioMode: node.metadata?.audioMode || globalConfig.audioMode || defaultConfig.audioMode,
        audioVoiceDescription: node.metadata?.audioVoiceDescription ?? globalConfig.audioVoiceDescription ?? defaultConfig.audioVoiceDescription,
        audioLyrics: node.metadata?.audioLyrics ?? globalConfig.audioLyrics ?? defaultConfig.audioLyrics,
        audioLanguage: node.metadata?.audioLanguage || globalConfig.audioLanguage || defaultConfig.audioLanguage,
        audioMaxDuration: node.metadata?.audioMaxDuration || globalConfig.audioMaxDuration || defaultConfig.audioMaxDuration,
        audioSeed: node.metadata?.audioSeed || globalConfig.audioSeed || defaultConfig.audioSeed,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
        seed: node.metadata?.seed || globalConfig.seed || "",
        seedFixed: node.metadata?.seedFixed ?? globalConfig.seedFixed ?? "false",
        params: node.metadata?.params || globalConfig.params,
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoMode") return { videoMode: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    // 节点元数据字段名与配置键一致，直接落盘即可（audioMode 需要窄化类型）。
    if (key === "audioMode") return { audioMode: value as CanvasNodeMetadata["audioMode"] };
    return { [key]: value };
}
