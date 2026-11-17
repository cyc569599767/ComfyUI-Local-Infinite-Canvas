import { useEffect, useState } from "react";
import { Button, Modal } from "antd";
import { Maximize2 } from "lucide-react";


import type { CanvasNodeData } from "@/types/canvas";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";

export type CanvasVideoUpscaleMethod = "seedvr2" | "relayvsr" | "dlss5";
export type CanvasVideoUpscaleParams = { scale: 1.5 | 2; resolution: number; fps: number; factor: number; detail: number; color?: number; style?: string; motion?: string };

const METHODS: Record<CanvasVideoUpscaleMethod, { title: string; note: string; hint: string }> = {
    // 倍率来自权重对本身：x2 用 lightx2v 权重，x4 换 x4 权重，混用会直接失败。
    seedvr2: { title: "SeedVR2 视频超分", note: "SeedVR2 3B · H.264 · 原音频直通", hint: "耗时随分辨率/时长增长；生成期间请保持画布打开。1.5× 适合 720p→1080p，2× 更慢。" },
    relayvsr: {
        title: "RelayVSR 视频超分",
        note: "RelayVSR · 单步稀疏关键帧 · 原音频与帧率直通",
        hint: "RelayVSR 需要 ComfyUI 0.45.0 及以上（核心节点 RelayVSRConditioning / VSRDecode）。2× 与 4× 必须使用同一档位的权重对，混用会失败；显存不足时请先裁剪片段再分段超分。",
    },
    dlss5: {
        title: "DLSS5 视频超分",
        note: "NVIDIA DLSS 5 神经渲染 · 原音频直通",
        hint: "需要 models/dlss5 下自备 NVIDIA NGX 运行时（nvngx_dlssnr.dll，>1× 还需 nvngx_dlss.dll）。DLSS 输出回传受显存与 PCIe 限制，长片建议先分段；运行时报错请先确认 DLL 与显卡匹配。",
    },
};

/** 每种方式的倍率档位与是否暴露细节/色彩参数。 */
const FACTORS: Record<CanvasVideoUpscaleMethod, readonly number[]> = {
    seedvr2: [1.5, 2],
    relayvsr: [2, 4],
    dlss5: [1.5, 1.724, 2, 3],
};

type Props = {
    open: boolean;
    node: CanvasNodeData | null;
    method?: CanvasVideoUpscaleMethod;
    onClose: () => void;
    onConfirm: (params: CanvasVideoUpscaleParams) => void;
};

export function CanvasNodeVideoUpscaleDialog({ open, node, method = "seedvr2", onClose, onConfirm }: Props) {
    const theme = useCanvasTheme();
    const [scale, setScale] = useState<1.5 | 2>(1.5);
    // 倍数档位统一放这里：SeedVR2 用 1.5/2，RelayVSR 用 2/4，DLSS5 用 1.5/1.724/2/3。
    const [factor, setFactor] = useState<number>(2);
    const [detail, setDetail] = useState(1);
    const [color, setColor] = useState(1);
    const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });

    useEffect(() => {
        if (!open || !node) return;
        setScale(1.5);
        setFactor(FACTORS[method]?.[0] ?? 2);
        setDetail(1);
        setColor(1);
        setSourceSize({
            width: node.metadata?.naturalWidth || node.width || 0,
            height: node.metadata?.naturalHeight || node.height || 0,
        });
    }, [node, open, method]);

    if (!node) return null;

    const meta = METHODS[method];
    const sourceWidth = sourceSize.width;
    const sourceHeight = sourceSize.height;
    const hasVideo = Boolean(node.metadata?.content);
    const shortest = Math.min(sourceWidth, sourceHeight);
    // SeedVR2 的目标短边由用户填的倍数决定；RelayVSR / DLSS5 由权重或 upscaling_mode 决定。
    const effectiveFactor = method === "seedvr2" ? scale : factor;
    const resolution = shortest ? Math.min(4096, Math.max(256, Math.round(shortest * effectiveFactor))) : 1104;
    const outputWidth = sourceWidth ? Math.round(sourceWidth * effectiveFactor) : 0;
    const outputHeight = sourceHeight ? Math.round(sourceHeight * effectiveFactor) : 0;

    return (
        <Modal
            open={open}
            onCancel={onClose}
            footer={null}
            width={560}
            centered
            destroyOnHidden
            transitionName=""
            maskTransitionName=""
            title={
                <span className="flex items-center gap-2">
                    <Maximize2 className="size-4" />
                    {meta.title}
                </span>
            }
        >
            <div className="space-y-4" style={{ color: theme.node.text }}>
                <div className="overflow-hidden rounded-2xl border bg-black" style={{ borderColor: theme.node.stroke }}>
                    {hasVideo ? (
                        <video
                            src={node.metadata?.content}
                            controls
                            playsInline
                            className="max-h-[260px] w-full bg-black object-contain"
                            onLoadedMetadata={(event) =>
                                setSourceSize({
                                    width: event.currentTarget.videoWidth || sourceWidth,
                                    height: event.currentTarget.videoHeight || sourceHeight,
                                })
                            }
                        />
                    ) : (
                        <div className="flex h-40 items-center justify-center text-xs" style={{ color: theme.node.muted }}>
                            源视频还没有内容
                        </div>
                    )}
                </div>

                <div className="text-xs" style={{ color: theme.node.muted }}>
                    源尺寸 {sourceWidth || "?"} × {sourceHeight || "?"} · 24fps · 保留原音频
                </div>

                <div className="space-y-2">
                    <div className="text-xs font-medium" style={{ color: theme.node.muted }}>
                        {method === "seedvr2" ? "放大倍数" : method === "relayvsr" ? "超分倍率（由权重决定）" : "超分档位（DLSS 固定倍率）"}
                    </div>
                    <div className={method === "dlss5" ? "grid grid-cols-4 gap-2" : "grid grid-cols-2 gap-2"}>
                        {FACTORS[method].map((value) => {
                            const active = effectiveFactor === value;
                            return (
                                <button
                                    key={value}
                                    type="button"
                                    className="h-10 rounded-xl border text-sm font-medium transition"
                                    style={{
                                        borderColor: active ? theme.node.text : theme.node.stroke,
                                        background: active ? `${theme.node.text}12` : "transparent",
                                        color: theme.node.text,
                                    }}
                                    onClick={() => (method === "seedvr2" ? setScale(value as 1.5 | 2) : setFactor(value))}
                                >
                                    {value}×
                                </button>
                            );
                        })}
                    </div>
                </div>

                {method === "relayvsr" || method === "dlss5" ? (
                    <div className="space-y-2">
                        <div className="text-xs font-medium" style={{ color: theme.node.muted }}>
                            细节强度 {Math.round(detail * 100)}%
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={method === "dlss5" ? 2 : 1}
                            step={0.05}
                            value={detail}
                            aria-label="细节强度"
                            className="w-full"
                            onChange={(event) => setDetail(Number(event.target.value))}
                        />
                    </div>
                ) : null}

                {method === "dlss5" ? (
                    <div className="space-y-2">
                        <div className="text-xs font-medium" style={{ color: theme.node.muted }}>
                            色彩跟随 {Math.round(color * 100)}%（0 只取亮度，1 完全采用模型色彩）
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={color}
                            aria-label="色彩跟随"
                            className="w-full"
                            onChange={(event) => setColor(Number(event.target.value))}
                        />
                    </div>
                ) : null}

                <div className="space-y-1 rounded-xl border p-3 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                    <div>
                        {method === "seedvr2" ? "目标短边" : "预计输出"}{" "}
                        <span style={{ color: theme.node.text }}>{method === "seedvr2" ? `${resolution}px` : `${outputWidth || "?"} × ${outputHeight || "?"}`}</span>
                    </div>
                    {method === "seedvr2" ? (
                        <div>
                            预计输出 <span style={{ color: theme.node.text }}>{outputWidth || "?"} × {outputHeight || "?"}</span>
                        </div>
                    ) : null}
                    <div>{meta.note}</div>
                </div>

                <div className="text-[11px] leading-5" style={{ color: theme.node.muted }}>
                    {meta.hint}
                </div>

                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>取消</Button>
                    <Button type="primary" disabled={!hasVideo} onClick={() => onConfirm({ scale, resolution, fps: 24, factor: effectiveFactor, detail, color, style: "default", motion: "auto" })}>
                        开始超分
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
