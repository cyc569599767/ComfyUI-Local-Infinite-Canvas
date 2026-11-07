import { Button, InputNumber } from "antd";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { DEFAULT_LOCAL_PROMPT_TIMEOUT_SECONDS, MIN_LOCAL_PROMPT_TIMEOUT_SECONDS, MAX_LOCAL_PROMPT_TIMEOUT_SECONDS, normalizeLocalPromptTimeoutSeconds } from "@/lib/prompt-local-timeout";

export type PromptOptimizeEngine = "local" | "cloud";
export type PromptOptimizeLanguage = "zh" | "en";

type PromptOptimizeOptionsProps = {
    engine: PromptOptimizeEngine;
    language: PromptOptimizeLanguage;
    cloudReady: boolean;
    cloudModel?: string;
    localReady?: boolean;
    localTimeoutSeconds?: number;
    onLocalTimeoutChange?: (seconds: number) => void;
    title?: string;
    disabled?: boolean;
    className?: string;
    onEngineChange: (engine: PromptOptimizeEngine) => void;
    onLanguageChange: (language: PromptOptimizeLanguage) => void;
    onOpenSettings: () => void;
    onOpenLocalSettings?: () => void;
    onStart: () => void;
    onClose: () => void;
};

export function PromptOptimizeOptions({
    engine,
    language,
    cloudReady,
    cloudModel,
    localReady = true,
    localTimeoutSeconds = DEFAULT_LOCAL_PROMPT_TIMEOUT_SECONDS,
    onLocalTimeoutChange,
    title,
    disabled = false,
    className = "",
    onEngineChange,
    onLanguageChange,
    onOpenSettings,
    onOpenLocalSettings,
    onStart,
    onClose,
}: PromptOptimizeOptionsProps) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();
    return (
        <div
            className={`space-y-2 rounded-xl border p-2 ${className}`}
            style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{title || t("canvas.promptPanel.optimizeOptions")}</span>
                <Button
                    type="text"
                    size="small"
                    className="!h-6 !w-6 !min-w-6 !rounded-full !p-0"
                    icon={<X className="size-3.5" />}
                    onClick={onClose}
                    aria-label={t("canvas.promptPanel.optimizeClose")}
                />
            </div>
            <div>
                <div className="mb-1 text-[11px] opacity-70">{t("canvas.promptPanel.optimizeEngine")}</div>
                <div className="grid grid-cols-2 gap-2">
                    <Button size="small" type={engine === "local" ? "primary" : "default"} onClick={() => onEngineChange("local")}>
                        {t("canvas.promptPanel.optimizeEngineLocal")}
                    </Button>
                    <Button size="small" type={engine === "cloud" ? "primary" : "default"} onClick={() => onEngineChange("cloud")}>
                        {t("canvas.promptPanel.optimizeEngineCloud")}
                    </Button>
                </div>
                {engine === "cloud" ? (
                    <div className="mt-2 flex items-center justify-between gap-2 text-[11px] opacity-70">
                        <span className="min-w-0 truncate">
                            {cloudReady
                                ? t("canvas.promptPanel.optimizeCloudReady", { model: cloudModel || "" })
                                : t("canvas.promptPanel.optimizeCloudMissing")}
                        </span>
                        {!cloudReady ? (
                            <Button size="small" className="shrink-0" onClick={onOpenSettings}>
                                {t("canvas.promptPanel.optimizeOpenSettings")}
                            </Button>
                        ) : null}
                    </div>
                ) : null}
                {engine === "local" && !localReady ? (
                    <div className="mt-2 flex items-center justify-between gap-2 text-[11px] opacity-70">
                        <span className="min-w-0 truncate">{t("canvas.promptPanel.optimizeLocalMissing")}</span>
                        <Button size="small" className="shrink-0" onClick={onOpenLocalSettings || onOpenSettings}>
                            {t("canvas.promptPanel.captionInstall")}
                        </Button>
                    </div>
                ) : null}
            </div>
            {engine === "local" && onLocalTimeoutChange ? (
                <div>
                    <div className="mb-1 text-[11px] opacity-70">{t("config.preferences.promptLocalTimeoutSeconds")}</div>
                    <InputNumber
                        size="small"
                        min={MIN_LOCAL_PROMPT_TIMEOUT_SECONDS}
                        max={MAX_LOCAL_PROMPT_TIMEOUT_SECONDS}
                        precision={0}
                        step={1}
                        value={normalizeLocalPromptTimeoutSeconds(localTimeoutSeconds)}
                        onChange={(value) => onLocalTimeoutChange(normalizeLocalPromptTimeoutSeconds(value))}
                        aria-label={t("config.preferences.promptLocalTimeoutSeconds")}
                        disabled={disabled}
                        className="!w-full"
                    />
                    <div className="mt-1 text-[11px] opacity-70">{t("config.preferences.promptLocalTimeoutHint")}</div>
                </div>
            ) : null}
            <div>
                <div className="mb-1 text-[11px] opacity-70">{t("canvas.promptPanel.optimizeLanguage")}</div>
                <div className="grid grid-cols-2 gap-2">
                    <Button size="small" type={language === "zh" ? "primary" : "default"} onClick={() => onLanguageChange("zh")}>
                        {t("canvas.promptPanel.optimizeLanguageZh")}
                    </Button>
                    <Button size="small" type={language === "en" ? "primary" : "default"} onClick={() => onLanguageChange("en")}>
                        {t("canvas.promptPanel.optimizeLanguageEn")}
                    </Button>
                </div>
            </div>
            <div className="flex justify-end gap-2">
                <Button size="small" onClick={onClose}>
                    {t("canvas.promptPanel.optimizeClose")}
                </Button>
                <Button size="small" type="primary" disabled={disabled || (engine === "cloud" && !cloudReady) || (engine === "local" && !localReady)} onClick={onStart}>
                    {t("canvas.promptPanel.optimizeStart")}
                </Button>
            </div>
        </div>
    );
}
