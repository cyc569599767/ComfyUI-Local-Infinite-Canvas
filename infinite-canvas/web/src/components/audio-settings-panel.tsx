import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import {
    audioInlineFields,
    audioModeForModel,
    audioModeOptions,
    audioPanelFields,
    audioWorkflowSpec,
    audioWorkflowSpecForMode,
    cloudAudioWorkflowSpec,
    normalizeAudioModeValue,
    normalizeAudioSeedValue,
    normalizeAudioSpeedValue,
    normalizeMusicDurationValue,
    type AudioFieldKey,
    type AudioFieldSpec,
    type AudioWorkflowSpec,
    type CanvasAudioMode,
} from "@/lib/audio-generation";
import { type CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";

export type AudioSettingKey =
    | "audioVoice"
    | "audioFormat"
    | "audioSpeed"
    | "audioInstructions"
    | "audioMode"
    | "audioVoiceDescription"
    | "audioLyrics"
    | "audioLanguage"
    | "audioMaxDuration"
    | "audioSeed";

export type AudioWorkflowOption = { value: string; label: string };

type AudioConfigChange = (key: AudioSettingKey, value: string) => void;

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: AudioConfigChange;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    /** 本地网关才支持音色克隆与音乐生成。 */
    localMode?: boolean;
    /** 可选工作流（本地网关的音频工作流模型，含渠道前缀）。 */
    workflowOptions?: AudioWorkflowOption[];
    /** 当前工作流模型值，与 config.model 保持一致。 */
    workflowValue?: string;
    /** 切换工作流；调用方负责写回模型。 */
    onWorkflowChange?: (model: string) => void;
    /** 没有可用工作流时引导去配置。 */
    onMissingConfig?: () => void;
};

const FIELD_LABEL_KEY: Record<AudioFieldKey, string> = {
    audioVoice: "settingsPanels.audio.voice",
    audioFormat: "settingsPanels.audio.format",
    audioSpeed: "settingsPanels.audio.speed",
    audioInstructions: "settingsPanels.audio.instructions",
    audioVoiceDescription: "settingsPanels.audio.voiceDescription",
    audioLyrics: "settingsPanels.audio.lyrics",
    audioLanguage: "settingsPanels.audio.language",
    audioMaxDuration: "settingsPanels.audio.duration",
    audioSeed: "settingsPanels.audio.seed",
};

const FIELD_PLACEHOLDER_KEY: Partial<Record<AudioFieldKey, string>> = {
    audioInstructions: "settingsPanels.audio.instructionsPlaceholder",
    audioVoiceDescription: "settingsPanels.audio.voiceDescriptionPlaceholder",
    audioLyrics: "settingsPanels.audio.lyricsPlaceholder",
    audioMaxDuration: "settingsPanels.audio.durationPlaceholder",
    audioSeed: "settingsPanels.common.seedPlaceholder",
};

/** 当前操作类型对应的工作流定义：优先按模型反查，查不到按类型回落。 */
export function audioSpecFor(config: AiConfig, workflowValue = "", localMode = true): AudioWorkflowSpec {
    if (!localMode) return cloudAudioWorkflowSpec;
    return audioWorkflowSpec(workflowValue) || audioWorkflowSpecForMode(normalizeAudioModeValue(config.audioMode || ""));
}

/**
 * 音频设置弹层：工作流 + 技术参数。
 * 操作类型与内容字段（音色描述、歌词等）都在节点卡片上，这里不重复。
 */
export function AudioSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", localMode = true, workflowOptions = [], workflowValue = "", onWorkflowChange, onMissingConfig }: AudioSettingsPanelProps) {
    const { t } = useTranslation();
    const mode = normalizeAudioModeValue(config.audioMode || "");
    const modeWorkflows = workflowOptions.filter((option) => audioModeForModel(option.value) === mode);
    const currentWorkflow = modeWorkflows.find((option) => option.value === workflowValue) || modeWorkflows[0];
    const spec = audioSpecFor(config, currentWorkflow?.value || workflowValue, localMode);
    const fields = audioPanelFields(spec);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.audio.title")}</div> : null}

                {localMode ? (
                    <SettingGroup title={t("settingsPanels.audio.workflow")} color={theme.node.muted}>
                        {modeWorkflows.length ? (
                            <AudioSelect
                                theme={theme}
                                value={currentWorkflow?.value || ""}
                                options={modeWorkflows}
                                onChange={(next) => {
                                    if (next === currentWorkflow?.value) return;
                                    if (onWorkflowChange) onWorkflowChange(next);
                                    else onConfigChange("audioMode", normalizeAudioModeValue(audioModeForModel(next) || mode));
                                }}
                            />
                        ) : (
                            <div className="flex items-center gap-2 rounded-xl border px-3 py-2 text-[11px] leading-4" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                                <span className="min-w-0 flex-1">{t("settingsPanels.audio.workflowEmpty")}</span>
                                {onMissingConfig ? (
                                    <button type="button" className="shrink-0 cursor-pointer underline" style={{ color: theme.node.text }} onClick={onMissingConfig}>
                                        {t("settingsPanels.audio.workflowConfigure")}
                                    </button>
                                ) : null}
                            </div>
                        )}
                        <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                            {t(`settingsPanels.audio.${spec.hintKey}`)}
                        </div>
                    </SettingGroup>
                ) : null}

                {fields.map((field) => (
                    <AudioFieldControl key={field.key} field={field} config={config} theme={theme} onConfigChange={onConfigChange} />
                ))}
            </div>
        </ImageSettingsTheme>
    );
}

/**
 * 节点卡片上的内容字段：随操作类型切换，音色描述 / 声音指令 / 歌词等都在这里填。
 * 音色克隆的参考音色优先用连入的音频节点；没连时执行会把本节点的音频当参考并另开新节点。
 */
export function AudioInlineFields({ config, onConfigChange, theme, localMode = true, hasReferenceAudio = false, hasOwnAudio = false, workflowValue = "" }: { config: AiConfig; onConfigChange: AudioConfigChange; theme: CanvasTheme; localMode?: boolean; hasReferenceAudio?: boolean; hasOwnAudio?: boolean; workflowValue?: string }) {
    const { t } = useTranslation();
    const spec = audioSpecFor(config, workflowValue, localMode);
    const fields = audioInlineFields(spec);
    if (!localMode || (!fields.length && !spec.needsReferenceAudio)) return null;
    const referenceState = hasReferenceAudio ? "connected" : hasOwnAudio ? "self" : "missing";
    const referenceText = t(`settingsPanels.audio.referenceState.${referenceState}`);

    return (
        <div className="mt-2 space-y-2" onMouseDown={(event) => event.stopPropagation()}>
            {spec.needsReferenceAudio ? (
                <div className="rounded-lg border px-2 py-1.5 text-[11px] leading-4" style={{ borderColor: referenceState === "missing" ? "#f59e0b" : theme.node.text, color: referenceState === "missing" ? "#f59e0b" : theme.node.text }}>
                    {referenceText}
                </div>
            ) : null}
            {fields.map((field) => (
                <AudioFieldControl key={field.key} field={field} config={config} theme={theme} onConfigChange={onConfigChange} dense />
            ))}
        </div>
    );
}

/** 操作类型下拉：放在节点卡片底部，切换即切工作流与字段。 */
export function AudioModeSelect({ config, theme, onChange, className }: { config: AiConfig; theme: CanvasTheme; onChange: (mode: CanvasAudioMode) => void; className?: string }) {
    const { t } = useTranslation();
    const mode = normalizeAudioModeValue(config.audioMode || "");
    return (
        <AudioSelect
            theme={theme}
            className={className}
            ariaLabel={t("settingsPanels.audio.operation")}
            value={mode}
            options={audioModeOptions.map((item) => ({ value: item.value, label: t(`settingsPanels.audio.modes.${item.value}`) }))}
            onChange={(next) => onChange(next as CanvasAudioMode)}
        />
    );
}

function AudioFieldControl({ field, config, theme, onConfigChange, dense = false }: { field: AudioFieldSpec; config: AiConfig; theme: CanvasTheme; onConfigChange: AudioConfigChange; dense?: boolean }) {
    const { t } = useTranslation();
    const rawValue = String((config as unknown as Record<string, string | undefined>)[field.key] ?? "");
    const label = t(field.labelKey ? `settingsPanels.audio.${field.labelKey}` : FIELD_LABEL_KEY[field.key]);
    const placeholderKey = field.placeholderKey ? `settingsPanels.audio.${field.placeholderKey}` : FIELD_PLACEHOLDER_KEY[field.key];
    const placeholder = placeholderKey ? t(placeholderKey) : "";
    const missing = field.required === true && !rawValue.trim();
    const borderColor = missing ? "#f59e0b" : theme.node.stroke;
    const textareaHeight = field.key === "audioLyrics" ? (dense ? "h-16" : "h-24") : dense ? "h-14" : "h-20";

    if (field.control === "select") {
        const options = (field.options || []).map((option) => ({ value: option.value, label: option.labelKey ? t(`settingsPanels.audio.${option.labelKey}`) : option.label || option.value }));
        return (
            <SettingGroup title={label} color={theme.node.muted}>
                <AudioSelect theme={theme} value={rawValue || options[0]?.value || ""} options={options} onChange={(next) => onConfigChange(field.key, next)} />
            </SettingGroup>
        );
    }

    if (field.control === "number") {
        return (
            <SettingGroup title={label} color={theme.node.muted}>
                <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    placeholder={placeholder}
                    className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    style={{ borderColor, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                    value={rawValue}
                    onChange={(event) => onConfigChange(field.key, event.target.value)}
                    onBlur={(event) => onConfigChange(field.key, normalizeNumberField(field.key, event.target.value))}
                    onMouseDown={(event) => event.stopPropagation()}
                />
            </SettingGroup>
        );
    }

    return (
        <div className="space-y-1">
            <div className="text-xs font-medium" style={{ color: theme.node.muted }}>
                {label}
                {field.required ? <span style={{ color: "#f59e0b" }}> *</span> : null}
            </div>
            <textarea
                value={rawValue}
                placeholder={placeholder}
                className={`thin-scrollbar w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none ${textareaHeight}`}
                style={{ borderColor, color: theme.node.text }}
                onChange={(event) => onConfigChange(field.key, event.target.value)}
                onMouseDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
            />
            {missing ? (
                <div className="text-[11px] leading-4" style={{ color: "#f59e0b" }}>
                    {t("settingsPanels.audio.voiceDescriptionRequired")}
                </div>
            ) : null}
        </div>
    );
}

function normalizeNumberField(key: AudioFieldKey, value: string) {
    if (key === "audioMaxDuration") return normalizeMusicDurationValue(value);
    if (key === "audioSeed") return normalizeAudioSeedValue(value);
    return normalizeAudioSpeedValue(value);
}

function AudioSelect({ value, options, theme, onChange, className = "", ariaLabel }: { value: string; options: AudioWorkflowOption[]; theme: CanvasTheme; onChange: (value: string) => void; className?: string; ariaLabel?: string }) {
    return (
        <div className={`relative ${className}`}>
            <select
                aria-label={ariaLabel}
                className="h-9 w-full cursor-pointer appearance-none rounded-xl border bg-transparent px-3 pr-8 text-sm outline-none"
                style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value} style={{ color: "#1c1917" }}>
                        {option.label}
                    </option>
                ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2" style={{ color: theme.node.muted }} />
        </div>
    );
}

export type { CanvasAudioMode };

function SettingGroup({ title, color, children }: { title: ReactNode; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}
