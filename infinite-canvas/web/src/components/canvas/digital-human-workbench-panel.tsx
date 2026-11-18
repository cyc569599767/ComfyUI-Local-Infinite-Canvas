import { useCallback, useMemo, useState } from "react";
import { App, Button, Empty, Input, InputNumber, Modal, Select, Tag, Tooltip } from "antd";
import { AudioLines, Scissors, Sparkles, Trash2, User } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";

/**
 * 数字人工作台 V2。
 *
 * 和故事分镜导演台的区别：那个从「一段故事」出发，这个从「一段音频」出发。
 * 音频先切成段，每段对应一个镜头，镜头之间要求连续性，所以约束更硬：
 *  - 只允许特写：数字人主体是小景别人物，远景会让人脸失去辨识度。
 *  - 同一运镜 5 镜内不得重复：连续同一种推拉会让成片像卡住的动图。
 *
 * 这两条来自参考实现（闲兔数字人工作台）的硬性规则，不是可选项。
 */

const CAMERA_MOVES = ["固定", "缓慢推近", "缓慢拉远", "左移", "右移", "上摇", "下摇"] as const;
type CameraMove = (typeof CAMERA_MOVES)[number];

/** 同一运镜在多少镜之内不允许重复。 */
const CAMERA_REPEAT_WINDOW = 5;

export type DigitalHumanSegment = {
    id: string;
    /** 该段对应的音频起止秒数，由切分产生。 */
    start: number;
    end: number;
    text: string;
    camera: CameraMove;
    /** 该镜的参考图（数字人立绘），空表示沿用上一镜。 */
    reference: string;
};

type Props = {
    open: boolean;
    nodeTitle?: string;
    onClose: () => void;
    /** 把选中的分镜交给画布去生成；由画布负责建卡与请求。 */
    onGenerateSegments?: (segments: DigitalHumanSegment[]) => Promise<void>;
};

const uid = () => `seg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function DigitalHumanWorkbenchPanel({ open, nodeTitle, onClose, onGenerateSegments }: Props) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const { message } = App.useApp();

    const [audioName, setAudioName] = useState("");
    const [audioDuration, setAudioDuration] = useState(30);
    const [segmentSeconds, setSegmentSeconds] = useState(6);
    const [reference, setReference] = useState("");
    const [segments, setSegments] = useState<DigitalHumanSegment[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [generating, setGenerating] = useState(false);

    /**
     * 按固定时长切分音频。
     *
     * 不在这里做真正的波形分析：音频解码和 VAD 属于网关/浏览器的重活，
     * 面板只负责给出「初始切分」，用户可以在表格里自己改。
     */
    const splitAudio = useCallback(() => {
        if (!audioName) {
            message.warning(t("canvas.digitalHuman.needAudio"));
            return;
        }
        const per = Math.max(1, Math.min(60, segmentSeconds));
        const count = Math.max(1, Math.ceil(audioDuration / per));
        const next: DigitalHumanSegment[] = Array.from({ length: count }, (_, index) => {
            const start = index * per;
            return {
                id: uid(),
                start,
                end: Math.min(audioDuration, start + per),
                text: "",
                // 轮换运镜，天然满足「5 镜内不重复」的初值要求。
                camera: CAMERA_MOVES[1 + (index % (CAMERA_MOVES.length - 1))],
                reference: index === 0 ? reference : "",
            };
        });
        setSegments(next);
        setSelected(new Set(next.map((item) => item.id)));
    }, [audioDuration, audioName, message, reference, segmentSeconds, t]);

    /**
     * 运镜冲突检查：同一运镜在前 N 镜内出现过就报错。
     *
     * 「固定」不算运镜，重复固定机位是正常的对话戏拍法，不该被拦。
     * 窗口语义是「间隔 N 镜内」，所以 back 取 1..N-1：
     * 间隔正好 N 镜（中间夹了 N-1 个别的镜头）是允许的，否则「5 镜内不重复」
     * 会退化成「6 镜内不重复」，把合法编排也拦掉。
     */
    const conflicts = useMemo(() => {
        const map = new Map<string, string>();
        segments.forEach((segment, index) => {
            if (segment.camera === "固定") return;
            for (let back = 1; back < CAMERA_REPEAT_WINDOW && index - back >= 0; back += 1) {
                if (segments[index - back].camera === segment.camera) {
                    map.set(segment.id, t("canvas.digitalHuman.cameraConflict", { count: back, move: segment.camera }));
                    break;
                }
            }
        });
        return map;
    }, [segments, t]);

    const patchSegment = (id: string, patch: Partial<DigitalHumanSegment>) => {
        setSegments((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };

    const totalSeconds = segments.reduce((sum, item) => sum + Math.max(0, item.end - item.start), 0);

    const generate = async () => {
        const picked = segments.filter((item) => selected.has(item.id));
        if (!picked.length) {
            message.warning(t("canvas.digitalHuman.needSegments"));
            return;
        }
        if (conflicts.size) {
            // 冲突不静默放过：成片里连续同一种推拉一眼就能看出来，必须让用户先改。
            message.error(t("canvas.digitalHuman.cameraBlocked"));
            return;
        }
        setGenerating(true);
        try {
            await onGenerateSegments?.(picked);
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setGenerating(false);
        }
    };

    return (
        <Modal
            open={open}
            onCancel={onClose}
            footer={null}
            width="92vw"
            centered
            destroyOnHidden
            transitionName=""
            maskTransitionName=""
            title={
                <span className="flex items-center gap-2">
                    <User className="size-4" />
                    {t("canvas.workbench.digitalHuman")}
                    {nodeTitle ? <Tag color="magenta">{nodeTitle}</Tag> : null}
                </span>
            }
        >
            <div className="flex max-h-[78vh] flex-col gap-3 overflow-hidden" style={{ color: theme.node.text }}>
                {/* 音频来源与切分 */}
                <div className="flex flex-wrap items-end gap-2 rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                    <label className="flex flex-col gap-1 text-xs">
                        <span style={{ color: theme.node.muted }}>{t("canvas.digitalHuman.audio")}</span>
                        <Input
                            size="small"
                            value={audioName}
                            placeholder={t("canvas.digitalHuman.audioPlaceholder")}
                            onChange={(event) => setAudioName(event.target.value)}
                            style={{ width: 240 }}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                        <span style={{ color: theme.node.muted }}>{t("canvas.digitalHuman.duration")}</span>
                        <InputNumber size="small" min={1} max={3600} value={audioDuration} onChange={(value) => setAudioDuration(Number(value) || 30)} addonAfter="s" />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                        <span style={{ color: theme.node.muted }}>{t("canvas.digitalHuman.perSegment")}</span>
                        <InputNumber size="small" min={1} max={60} value={segmentSeconds} onChange={(value) => setSegmentSeconds(Number(value) || 6)} addonAfter="s" />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                        <span style={{ color: theme.node.muted }}>{t("canvas.digitalHuman.reference")}</span>
                        <Input
                            size="small"
                            value={reference}
                            placeholder={t("canvas.digitalHuman.referencePlaceholder")}
                            onChange={(event) => setReference(event.target.value)}
                            style={{ width: 220 }}
                        />
                    </label>
                    <Button size="small" icon={<Scissors className="size-3.5" />} onClick={splitAudio}>
                        {t("canvas.digitalHuman.split")}
                    </Button>
                    <div className="flex-1" />
                    <span className="text-xs" style={{ color: theme.node.muted }}>
                        {t("canvas.digitalHuman.summary", { count: segments.length, seconds: totalSeconds })}
                    </span>
                </div>

                {/* 约束提示：这两条是硬规则，不是建议 */}
                <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                    <Tag color="blue">{t("canvas.digitalHuman.ruleCloseUp")}</Tag>
                    <Tag color={conflicts.size ? "red" : "default"}>{t("canvas.digitalHuman.ruleCamera", { count: CAMERA_REPEAT_WINDOW })}</Tag>
                    {conflicts.size ? <span className="text-red-500">{t("canvas.digitalHuman.conflictCount", { count: conflicts.size })}</span> : null}
                </div>

                {/* 镜头表 */}
                <div className="min-h-0 flex-1 overflow-auto rounded-lg border thin-scrollbar" style={{ borderColor: theme.node.stroke }}>
                    {!segments.length ? (
                        <div className="flex h-40 items-center justify-center">
                            <Empty description={t("canvas.digitalHuman.noSegments")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                        </div>
                    ) : (
                        <table className="w-full border-collapse text-xs">
                            <thead className="sticky top-0 z-10" style={{ background: theme.node.fill }}>
                                <tr style={{ color: theme.node.muted }}>
                                    <th className="w-8 p-2" />
                                    <th className="w-10 p-2 text-left">#</th>
                                    <th className="w-28 p-2 text-left">{t("canvas.digitalHuman.colRange")}</th>
                                    <th className="p-2 text-left">{t("canvas.digitalHuman.colText")}</th>
                                    <th className="w-32 p-2">{t("canvas.digitalHuman.colCamera")}</th>
                                    <th className="w-40 p-2 text-left">{t("canvas.digitalHuman.colReference")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {segments.map((segment, index) => {
                                    const conflict = conflicts.get(segment.id);
                                    return (
                                        <tr key={segment.id} style={{ borderTop: `1px solid ${theme.node.stroke}` }} className="align-top">
                                            <td className="p-2">
                                                <input
                                                    type="checkbox"
                                                    checked={selected.has(segment.id)}
                                                    onChange={(event) =>
                                                        setSelected((prev) => {
                                                            const next = new Set(prev);
                                                            if (event.target.checked) next.add(segment.id);
                                                            else next.delete(segment.id);
                                                            return next;
                                                        })
                                                    }
                                                />
                                            </td>
                                            <td className="p-2">{index + 1}</td>
                                            <td className="p-2" style={{ color: theme.node.muted }}>
                                                {segment.start.toFixed(1)}–{segment.end.toFixed(1)}s
                                            </td>
                                            <td className="p-2">
                                                <Input
                                                    size="small"
                                                    value={segment.text}
                                                    placeholder={t("canvas.digitalHuman.textPlaceholder")}
                                                    onChange={(event) => patchSegment(segment.id, { text: event.target.value })}
                                                />
                                            </td>
                                            <td className="p-2">
                                                <Tooltip title={conflict || ""}>
                                                    <Select
                                                        size="small"
                                                        value={segment.camera}
                                                        status={conflict ? "error" : undefined}
                                                        options={CAMERA_MOVES.map((move) => ({ value: move, label: move }))}
                                                        onChange={(value) => patchSegment(segment.id, { camera: value as CameraMove })}
                                                        className="w-full"
                                                    />
                                                </Tooltip>
                                            </td>
                                            <td className="p-2">
                                                <Input
                                                    size="small"
                                                    value={segment.reference}
                                                    placeholder={t("canvas.digitalHuman.reusePrevious")}
                                                    onChange={(event) => patchSegment(segment.id, { reference: event.target.value })}
                                                />
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: theme.node.muted }}>
                        {t("canvas.digitalHuman.selected", { count: selected.size })}
                    </span>
                    <div className="flex-1" />
                    {segments.length ? (
                        <Button
                            size="small"
                            icon={<Trash2 className="size-3.5" />}
                            onClick={() => {
                                setSegments([]);
                                setSelected(new Set());
                            }}
                        >
                            {t("canvas.digitalHuman.clear")}
                        </Button>
                    ) : null}
                    <Button
                        size="small"
                        type="primary"
                        icon={<Sparkles className="size-3.5" />}
                        loading={generating}
                        disabled={!segments.length || !onGenerateSegments}
                        onClick={generate}
                    >
                        {t("canvas.digitalHuman.generate")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

/** 供外部（节点定义）复用的运镜常量。 */
export { CAMERA_MOVES, CAMERA_REPEAT_WINDOW };
export type { CameraMove };