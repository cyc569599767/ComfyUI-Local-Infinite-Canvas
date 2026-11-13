import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { AudioSettingsPanel, type AudioWorkflowOption } from "@/components/audio-settings-panel";
import { audioFormatLabel, audioModeLabel, audioSpeedLabel, audioVoiceLabel, normalizeAudioModeValue } from "@/lib/audio-generation";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";
import { isLocalGatewayUrl } from "@/constant/app-mode";

export type CanvasAudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions" | "audioMode" | "audioVoiceDescription" | "audioLyrics" | "audioLanguage" | "audioMaxDuration" | "audioSeed";

type CanvasAudioSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    /** 只显示齿轮图标（卡片底部已有操作类型下拉时用）。 */
    compact?: boolean;
    /** 可选工作流列表（本地网关音频工作流模型，含渠道前缀）。 */
    workflowOptions?: AudioWorkflowOption[];
    /** 切换工作流；调用方负责写回模型。 */
    onWorkflowChange?: (model: string) => void;
    /** 没有可用工作流时的配置入口。 */
    onMissingConfig?: () => void;
};

export function CanvasAudioSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft", compact = false, workflowOptions = [], onWorkflowChange, onMissingConfig }: CanvasAudioSettingsPopoverProps) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const localMode = isLocalGatewayUrl(config.baseUrl);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const panel = open && buttonRect ? <AudioSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} onConfigChange={onConfigChange} localMode={localMode} workflowOptions={workflowOptions} onWorkflowChange={onWorkflowChange} onMissingConfig={onMissingConfig} /> : null;
    const mode = normalizeAudioModeValue(config.audioMode || "");
    // 本地模式显示操作类型，不再显示工作流名；云端沿用旧式音色参数摘要。
    const summary = localMode ? audioModeLabel(mode) : `${audioVoiceLabel(config.audioVoice)} · ${audioFormatLabel(config.audioFormat)} · ${audioSpeedLabel(config.audioSpeed)}`;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                {compact ? (
                    <Button size="small" type="text" className={buttonClassName || "!h-9 !w-9 !min-w-9 !rounded-full !p-0"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)} aria-label={t("settingsPanels.audio.title")} title={t("settingsPanels.audio.title")} />
                ) : (
                    <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                        <span className="truncate">{summary}</span>
                    </Button>
                )}
            </span>
            {panel}
        </>
    );
}

function AudioSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    onConfigChange,
    localMode,
    workflowOptions,
    onWorkflowChange,
    onMissingConfig,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasAudioSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    localMode: boolean;
    workflowOptions: AudioWorkflowOption[];
    onWorkflowChange?: (model: string) => void;
    onMissingConfig?: () => void;
}) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-image-settings-popover"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <AudioSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" localMode={localMode} workflowOptions={workflowOptions} workflowValue={config.model} onWorkflowChange={onWorkflowChange} onMissingConfig={onMissingConfig} />
        </div>,
        document.body,
    );
}
