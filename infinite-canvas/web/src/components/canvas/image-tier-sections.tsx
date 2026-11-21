import { Slider } from "antd";

import { OptionPill, SettingTitle } from "@/components/image-settings-panel";
import type { CanvasTheme } from "@/lib/canvas-theme";

/**
 * 图像质量档位选择器（F 项前端）。
 *
 * 对应网关四个档位模块：
 * - Krea2 Turbo：三档 + 加速（关闭/低/中/高 → 0/5/6/7）
 * - Qwen 2.1：三档（仅文生图/编辑）
 * - Z-Image Turbo：加速开关（仅 2k/4k）
 * - MOSS-Image：三档（可用性由资源状态决定）
 *
 * 全部通过 `onParamsChange` 写入 `config.params`，与网关 `applyKrea2Mode` 等函数
 * 读取的键名一致；不传档位时网关侧完全跳过，行为与旧版一致。
 */

type TierCommon = {
    theme: CanvasTheme;
    onParamsChange?: (params: Record<string, unknown>) => void;
};

/** 三档选择：快速 / 质量 / 极致。 */
function TierPills({
    theme,
    value,
    onChange,
    availability,
}: {
    theme: CanvasTheme;
    value: string;
    onChange: (value: string) => void;
    availability?: Record<string, { available?: boolean; reason?: string | null }>;
}) {
    return (
        <div className="grid grid-cols-3 gap-2.5">
            {(["fast", "quality", "ultra"] as const).map((tier) => {
                const status = availability?.[tier];
                return (
                    <OptionPill key={tier} selected={value === tier} disabled={status?.available === false} theme={theme} onClick={() => onChange(tier)}>
                        {{ fast: "快速", quality: "质量", ultra: "极致" }[tier]}
                    </OptionPill>
                );
            })}
        </div>
    );
}

export function Krea2TierSection({ theme, onParamsChange, mode, accelIndex }: TierCommon & { mode: string; accelIndex: number }) {
    return (
        <div className="space-y-2.5 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
            <SettingTitle color={theme.node.muted}>生成档位</SettingTitle>
            <TierPills theme={theme} value={mode} onChange={(tier) => onParamsChange?.({ krea2Mode: tier })} />
            <SettingTitle color={theme.node.muted}>生成加速</SettingTitle>
            <Slider
                min={0}
                max={3}
                step={1}
                value={accelIndex}
                onChange={(value) => onParamsChange?.({ krea2AccelT: [0, 5, 6, 7][value] ?? 0 })}
                marks={{ 0: "关闭", 1: "低", 2: "中", 3: "高" }}
                tooltip={{ formatter: (value) => ["关闭", "低", "中", "高"][value ?? 0] }}
            />
            <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                快速=一采；质量=低清起稿后精修；极致=质量+两倍放大。加速会把一采换成 SelfLift 并挂 SageAttention。
            </div>
        </div>
    );
}

export function QwenTierSection({ theme, onParamsChange, mode }: TierCommon & { mode: string }) {
    return (
        <div className="space-y-2.5 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
            <SettingTitle color={theme.node.muted}>生成档位</SettingTitle>
            <TierPills theme={theme} value={mode} onChange={(tier) => onParamsChange?.({ qwenT2iMode: tier })} />
            <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                质量档在 Qwen 之后接一次精修，极致档再加放大。仅文生图与编辑模式生效。
            </div>
        </div>
    );
}

export function ZImageTierSection({ theme, onParamsChange, on, available }: TierCommon & { on: boolean; available: boolean }) {
    return (
        <div className="space-y-2.5 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
            <SettingTitle color={theme.node.muted}>生图加速</SettingTitle>
            <Slider
                min={0}
                max={1}
                step={1}
                value={on ? 1 : 0}
                disabled={!available}
                onChange={(value) => onParamsChange?.({ zimageAccelT: value === 1 ? 5 : 0 })}
                marks={{ 0: "关闭", 1: "开启" }}
                tooltip={{ formatter: (value) => (value === 1 ? "开启" : "关闭") }}
            />
            {!available ? (
                <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                    加速仅在 2k / 4k 分辨率下可用。
                </div>
            ) : null}
        </div>
    );
}

export function MossTierSection({ theme, onParamsChange, mode, tiers }: TierCommon & { mode: string; tiers: Record<string, { available?: boolean; reason?: string | null }> }) {
    return (
        <div className="space-y-2.5 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
            <SettingTitle color={theme.node.muted}>生成档位</SettingTitle>
            <TierPills theme={theme} value={mode} onChange={(tier) => onParamsChange?.({ mossTier: tier })} availability={tiers} />
            {tiers?.quality?.available === false ? (
                <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                    {tiers.quality.reason || "12 步加速 LoRA 未安装"}
                </div>
            ) : null}
        </div>
    );
}
