export const audioVoiceOptions = [
    { value: "alloy", label: "Alloy" },
    { value: "ash", label: "Ash" },
    { value: "ballad", label: "Ballad" },
    { value: "coral", label: "Coral" },
    { value: "echo", label: "Echo" },
    { value: "fable", label: "Fable" },
    { value: "nova", label: "Nova" },
    { value: "onyx", label: "Onyx" },
    { value: "sage", label: "Sage" },
    { value: "shimmer", label: "Shimmer" },
    { value: "verse", label: "Verse" },
    { value: "marin", label: "Marin" },
    { value: "cedar", label: "Cedar" },
];

// 本地网关的三种音频任务；云端 OpenAI 兼容渠道只有 speech（音色设计）。
export const audioModeOptions = [
    { value: "voice-design", label: "音色设计" },
    { value: "voice-clone", label: "音色克隆" },
    { value: "music", label: "音乐生成" },
];

export type CanvasAudioMode = "voice-design" | "voice-clone" | "music";

export function normalizeAudioModeValue(value: string): CanvasAudioMode {
    return audioModeOptions.some((item) => item.value === value) ? (value as CanvasAudioMode) : "voice-design";
}

export function audioModeLabel(value: string) {
    const mode = normalizeAudioModeValue(value);
    return audioModeOptions.find((item) => item.value === mode)?.label || mode;
}

// 本地网关每种音频能力是一个独立工作流模型；模型与模式必须一致，
// 否则网关会拒绝（例如用音色设计的模型去生成音乐）。
const MODEL_SUFFIX_BY_MODE: Record<CanvasAudioMode, string> = {
    "voice-design": "audio-voice-design",
    "voice-clone": "audio-voice-clone",
    music: "audio-music",
};

/** 从模型名反推音频模式；不是音频工作流模型时返回 null。 */
export function audioModeForModel(model: string): CanvasAudioMode | null {
    const name = audioWorkflowId(model).toLowerCase();
    for (const [mode, suffix] of Object.entries(MODEL_SUFFIX_BY_MODE)) {
        if (name === suffix || name.endsWith(`::${suffix}`)) return mode as CanvasAudioMode;
    }
    // 网关后续新增同类工作流（audio-music-xxx 之类）也归到同一分类，不必改前端映射。
    if (/clone/.test(name)) return "voice-clone";
    if (/voice[-_]?design|tts/.test(name)) return "voice-design";
    if (/music|song/.test(name)) return "music";
    return null;
}

/** 在可选模型里找出该模式对应的工作流模型（保持渠道前缀编码）。 */
export function audioModelForMode(mode: CanvasAudioMode, options: string[]): string | undefined {
    const suffix = MODEL_SUFFIX_BY_MODE[mode];
    return options.find((option) => option === suffix || option.endsWith(`::${suffix}`));
}

/** 去掉渠道前缀，拿到网关工作流 id（audio-music / audio-voice-design / audio-voice-clone）。 */
export function audioWorkflowId(model: string) {
    const text = String(model || "");
    const index = text.indexOf("::");
    return index >= 0 ? text.slice(index + 2) : text;
}


export const audioLanguageOptions = [
    { value: "Auto", label: "自动" },
    { value: "Chinese", label: "中文" },
    { value: "English", label: "英语" },
    { value: "Japanese", label: "日语" },
    { value: "Korean", label: "韩语" },
];

export function normalizeAudioLanguageValue(value: string) {
    return audioLanguageOptions.some((item) => item.value === value) ? value : "Auto";
}

export function normalizeMusicDurationValue(value: string) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return "60";
    return String(Math.max(1, Math.min(360, Math.round(seconds))));
}

export function normalizeAudioSeedValue(value: string) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    const seed = Number(text);
    if (!Number.isFinite(seed) || seed < 0) return "";
    return String(Math.floor(seed));
}

export const audioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "aac", label: "AAC" },
    { value: "flac", label: "FLAC" },
    { value: "pcm", label: "PCM" },
];

export function normalizeAudioVoiceValue(value: string) {
    return audioVoiceOptions.some((item) => item.value === value) ? value : "alloy";
}

export function normalizeAudioFormatValue(value: string) {
    return audioFormatOptions.some((item) => item.value === value) ? value : "mp3";
}

export function normalizeAudioSpeedValue(value: string) {
    const speed = Number(value);
    if (!Number.isFinite(speed)) return "1";
    return String(Math.max(0.25, Math.min(4, Number(speed.toFixed(2)))));
}

export function audioVoiceLabel(value: string) {
    const voice = normalizeAudioVoiceValue(value);
    return audioVoiceOptions.find((item) => item.value === voice)?.label || voice;
}

export function audioFormatLabel(value: string) {
    const format = normalizeAudioFormatValue(value);
    return audioFormatOptions.find((item) => item.value === format)?.label || format;
}

export function audioSpeedLabel(value: string) {
    return `${normalizeAudioSpeedValue(value)}x`;
}

export function audioMimeType(format: string) {
    if (format === "wav") return "audio/wav";
    if (format === "opus") return "audio/opus";
    if (format === "aac") return "audio/aac";
    if (format === "flac") return "audio/flac";
    if (format === "pcm") return "audio/pcm";
    return "audio/mpeg";
}

export type AudioFieldKey =
    | "audioVoice"
    | "audioFormat"
    | "audioSpeed"
    | "audioInstructions"
    | "audioVoiceDescription"
    | "audioLyrics"
    | "audioLanguage"
    | "audioMaxDuration"
    | "audioSeed";

export type AudioFieldControl = "textarea" | "number" | "select";

export type AudioFieldSpec = {
    key: AudioFieldKey;
    control: AudioFieldControl;
    /** 必填项在卡片上标星，并在提交前拦住空值。 */
    required?: boolean;
    /** 内容类字段（音色描述、歌词等）直接摆在节点卡片上，其余参数留在设置弹层里。 */
    inline?: boolean;
    /** 覆盖默认文案（settingsPanels.audio.* 下的键）。 */
    labelKey?: string;
    placeholderKey?: string;
    /** control=select 时的选项；labelKey 走 i18n 前缀 settingsPanels.audio.*，专有名词直接给 label。 */
    options?: { value: string; labelKey?: string; label?: string }[];
    min?: number;
    max?: number;
    step?: number;
};

export type AudioWorkflowSpec = {
    /** 网关工作流 id，同时也是模型名后缀。 */
    id: string;
    mode: CanvasAudioMode;
    /** 卡片上的工作流标题，走 i18n：settingsPanels.audio.workflows.<id>。 */
    labelKey: string;
    hintKey: string;
    fields: AudioFieldSpec[];
    /** 音色克隆要用连入的参考音频，卡片里单独提示。 */
    needsReferenceAudio?: boolean;
};

const languageField: AudioFieldSpec = {
    key: "audioLanguage",
    control: "select",
    options: audioLanguageOptions.map((item) => ({ value: item.value, labelKey: `languages.${item.value}` })),
};

const formatField: AudioFieldSpec = {
    key: "audioFormat",
    control: "select",
    options: audioFormatOptions.map((item) => ({ value: item.value, labelKey: `formats.${item.value}` })),
};

/**
 * 音频卡片的工作流目录：一个工作流 = 一组要填的字段。
 * 卡片按选中的工作流渲染字段，新增工作流时在这里加一条即可。
 */
export const audioWorkflowSpecs: AudioWorkflowSpec[] = [
    {
        id: "audio-voice-design",
        mode: "voice-design",
        labelKey: "workflows.voiceDesign",
        hintKey: "workflowHintDesign",
        fields: [
            { key: "audioVoiceDescription", control: "textarea", required: true, inline: true },
            { key: "audioInstructions", control: "textarea", inline: true },
            languageField,
            formatField,
            { key: "audioSpeed", control: "number", min: 0.25, max: 4, step: 0.05 },
        ],
    },
    {
        id: "audio-voice-clone",
        mode: "voice-clone",
        labelKey: "workflows.voiceClone",
        hintKey: "workflowHintClone",
        needsReferenceAudio: true,
        fields: [
            { key: "audioVoiceDescription", control: "textarea", inline: true, labelKey: "cloneDescription", placeholderKey: "cloneDescriptionPlaceholder" },
            { key: "audioInstructions", control: "textarea", inline: true },
            languageField,
            formatField,
        ],
    },
    {
        id: "audio-music",
        mode: "music",
        labelKey: "workflows.music",
        hintKey: "workflowHintMusic",
        fields: [
            { key: "audioLyrics", control: "textarea", inline: true },
            { key: "audioMaxDuration", control: "number", min: 1, max: 360, step: 1 },
            { key: "audioSeed", control: "number", min: 0, step: 1 },
            formatField,
        ],
    },
];

/** 云端 OpenAI 兼容渠道只有音色设计这一种能力，字段沿用旧式音色参数。 */
export const cloudAudioWorkflowSpec: AudioWorkflowSpec = {
    id: "cloud-tts",
    mode: "voice-design",
    labelKey: "workflows.cloudTts",
    hintKey: "workflowHintCloud",
    fields: [
        { key: "audioVoice", control: "select", options: audioVoiceOptions.map((item) => ({ value: item.value, label: item.label })) },
        formatField,
        { key: "audioSpeed", control: "number", min: 0.25, max: 4, step: 0.05 },
        { key: "audioInstructions", control: "textarea" },
    ],
};

/** 按工作流 id 取字段定义；取不到时按模式回落到该模式的默认工作流。 */
export function audioWorkflowSpec(id: string): AudioWorkflowSpec | null {
    const key = audioWorkflowId(id);
    return audioWorkflowSpecs.find((item) => item.id === key) || null;
}

export function audioWorkflowSpecForMode(mode: CanvasAudioMode): AudioWorkflowSpec {
    return audioWorkflowSpecs.find((item) => item.mode === mode) || audioWorkflowSpecs[0];
}

/** 节点卡片上直接展示的内容字段（随操作类型切换）。 */
export function audioInlineFields(spec: AudioWorkflowSpec): AudioFieldSpec[] {
    return spec.fields.filter((field) => field.inline === true);
}

/** 设置弹层里保留的参数（格式、语速、时长等）。 */
export function audioPanelFields(spec: AudioWorkflowSpec): AudioFieldSpec[] {
    return spec.fields.filter((field) => field.inline !== true);
}
