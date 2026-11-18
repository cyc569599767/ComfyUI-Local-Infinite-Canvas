import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Checkbox, Empty, Input, InputNumber, Modal, Select, Spin, Tag, Tooltip } from "antd";
import { Clapperboard, Download, Film, Image as ImageIcon, Loader2, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { useEffectiveConfig } from "@/stores/use-config-store";
import {
    breakdownStoryboard,
    deleteStoryboardProject,
    exportStoryboardComfyJson,
    getStoryboardProject,
    listStoryboardProjects,
    saveStoryboardProject,
    type StoryboardProject,
    type StoryboardShot,
    type StoryboardSummary,
} from "@/services/api/storyboard";

const VIDEO_MODES = ["图生视频", "首尾帧", "多参考图", "文生视频", "参考视频", "视频延长"];

type Props = {
    open: boolean;
    projectId?: string;
    nodeTitle?: string;
    onClose: () => void;
    onProjectChange: (projectId: string, name: string) => void;
    /** 把选中的分镜提示词交回画布去生成；返回后由画布把结果写回分镜。 */
    onGenerateShots?: (shots: StoryboardShot[]) => Promise<void>;
};

export function StoryboardWorkbenchPanel({ open, projectId, nodeTitle, onClose, onProjectChange, onGenerateShots }: Props) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const [projects, setProjects] = useState<StoryboardSummary[]>([]);
    const [project, setProject] = useState<StoryboardProject | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [breaking, setBreaking] = useState(false);
    // 默认本地：本地渠道没有 chat 接口，走云端会直接 404。
    const [engine, setEngine] = useState<"local" | "cloud">("local");
    const [error, setError] = useState("");
    const [storyDraft, setStoryDraft] = useState("");
    const [styleDraft, setStyleDraft] = useState("");
    const [maxShotSeconds, setMaxShotSeconds] = useState(10);
    const [targetShotCount, setTargetShotCount] = useState(0);
    const [activeShotId, setActiveShotId] = useState("");
    const dirtyRef = useRef(false);

    const refreshProjects = useCallback(async () => {
        try {
            setProjects(await listStoryboardProjects(config));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, [config]);

    // 打开时优先加载节点绑定的项目；没绑定就退到最近一个，避免空白面板。
    useEffect(() => {
        if (!open) return;
        let alive = true;
        setLoading(true);
        setError("");
        (async () => {
            const list = await listStoryboardProjects(config);
            if (!alive) return;
            setProjects(list);
            const targetId = projectId && list.some((item) => item.id === projectId) ? projectId : projectId ? "" : list[0]?.id || "";
            if (!targetId) {
                setProject(null);
                return;
            }
            const loaded = await getStoryboardProject(config, targetId);
            if (!alive) return;
            setProject(loaded);
            setStoryDraft(loaded.project.story);
            setStyleDraft(loaded.project.style);
            setMaxShotSeconds(loaded.project.max_shot_seconds || 10);
            setTargetShotCount(loaded.project.target_shot_count || 0);
            setActiveShotId(loaded.active_shot_id || loaded.shots[0]?.id || "");
            dirtyRef.current = false;
            if (projectId !== loaded.id) onProjectChange(loaded.id, loaded.project.name);
        })()
            .catch((cause) => alive && setError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => alive && setLoading(false));
        return () => {
            alive = false;
        };
        // projectId 变化才重新加载；onProjectChange 用 ref 语义，不参与依赖。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, projectId, config]);

    const patchProject = useCallback((updater: (current: StoryboardProject) => StoryboardProject) => {
        setProject((current) => (current ? updater(current) : current));
        dirtyRef.current = true;
    }, []);

    const patchShot = useCallback(
        (shotId: string, patch: Partial<StoryboardShot>) => {
            patchProject((current) => ({ ...current, shots: current.shots.map((shot) => (shot.id === shotId ? { ...shot, ...patch } : shot)) }));
        },
        [patchProject],
    );

    const persist = useCallback(
        async (next: StoryboardProject, { quiet = false } = {}) => {
            setSaving(true);
            try {
                const saved = await saveStoryboardProject(config, next);
                setProject(saved);
                dirtyRef.current = false;
                if (!quiet) message.success(t("canvas.workbench.saved"));
                await refreshProjects();
                return saved;
            } catch (cause) {
                message.error(cause instanceof Error ? cause.message : String(cause));
                return null;
            } finally {
                setSaving(false);
            }
        },
        [config, message, refreshProjects, t],
    );

    const createProject = async () => {
        const name = nodeTitle?.trim() || t("canvas.workbench.newProject");
        setSaving(true);
        try {
            const saved = await saveStoryboardProject(config, {
                project: { name, story: "", style: "", aspect_ratio: "16:9", max_shot_seconds: 10, target_shot_count: 0, negative_prompt: "", video_model: "", image_model: "" },
                shots: [],
                characters: [],
                scenes: [],
                props: [],
                story_beats: [],
                active_shot_id: "",
                selection_mode: "当前分镜",
            });
            setProject(saved);
            setStoryDraft("");
            setStyleDraft("");
            setActiveShotId("");
            await refreshProjects();
            onProjectChange(saved.id, saved.project.name);
            message.success(t("canvas.workbench.created"));
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setSaving(false);
        }
    };

    const runBreakdown = async () => {
        if (!storyDraft.trim()) {
            message.warning(t("canvas.workbench.storyRequired"));
            return;
        }
        setBreaking(true);
        setError("");
        try {
            const board = await breakdownStoryboard(config, {
                story: storyDraft,
                style: styleDraft,
                maxShotSeconds,
                targetShotCount,
                engine,
            });
            // 拆解结果直接落到当前项目：用户点「拆解」就是想拿到镜头表，
            // 不再要求先保存再导入一步。
            const base = project ?? null;
            const next: StoryboardProject = {
                id: base?.id ?? "",
                version: 3,
                project: {
                    name: base?.project.name || nodeTitle || t("canvas.workbench.newProject"),
                    story: storyDraft,
                    style: styleDraft,
                    aspect_ratio: base?.project.aspect_ratio || "16:9",
                    max_shot_seconds: maxShotSeconds,
                    target_shot_count: targetShotCount,
                    negative_prompt: base?.project.negative_prompt || "",
                    video_model: base?.project.video_model || "",
                    image_model: base?.project.image_model || "",
                },
                characters: board.characters.map((item) => ({ ...item, kind: "character" as const })),
                scenes: board.scenes.map((item) => ({ ...item, kind: "scene" as const })),
                props: board.props.map((item) => ({ ...item, kind: "prop" as const })),
                story_beats: board.beats,
                shots: board.shots.map((shot) => ({ ...shot, selected: false })) as StoryboardShot[],
                active_shot_id: board.shots[0]?.id || "",
                selection_mode: base?.selection_mode || "当前分镜",
                createdAt: base?.createdAt || "",
                updatedAt: base?.updatedAt || "",
            };
            const saved = await saveStoryboardProject(config, next);
            setProject(saved);
            setActiveShotId(saved.shots[0]?.id || "");
            await refreshProjects();
            onProjectChange(saved.id, saved.project.name);
            // 截断时镜头数会少于预期，不说清楚用户会以为拆漏了。
            if (board.truncated) {
                message.warning(t("canvas.workbench.breakdownTruncated", { count: saved.shots.length }));
            } else {
                message.success(t("canvas.workbench.breakdownDone", { count: saved.shots.length }));
            }
        } catch (cause) {
            const text = cause instanceof Error ? cause.message : String(cause);
            setError(text);
            message.error(text);
        } finally {
            setBreaking(false);
        }
    };

    const selectedShots = useMemo(() => project?.shots.filter((shot) => shot.selected) || [], [project]);
    const activeShot = useMemo(() => project?.shots.find((shot) => shot.id === activeShotId) || null, [project, activeShotId]);

    const requestClose = () => {
        if (dirtyRef.current && project) {
            Modal.confirm({
                title: t("canvas.workbench.unsavedTitle"),
                content: t("canvas.workbench.unsavedBody"),
                okText: t("canvas.workbench.saveAndClose"),
                cancelText: t("canvas.workbench.discardClose"),
                onOk: async () => {
                    await persist(project, { quiet: true });
                    onClose();
                },
                onCancel: () => onClose(),
            });
            return;
        }
        onClose();
    };

    const exportComfyJson = async () => {
        if (!project) return;
        try {
            const json = await exportStoryboardComfyJson(config, project.id);
            await navigator.clipboard.writeText(json);
            message.success(t("canvas.workbench.copied"));
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : String(cause));
        }
    };

    return (
        <Modal
            open={open}
            onCancel={requestClose}
            footer={null}
            width="92vw"
            centered
            destroyOnHidden
            transitionName=""
            maskTransitionName=""
            title={
                <span className="flex items-center gap-2">
                    <Clapperboard className="size-4" />
                    {t("canvas.workbench.storyboard")}
                    {project ? <Tag color="blue">{project.project.name}</Tag> : null}
                </span>
            }
        >
            <div className="flex max-h-[78vh] flex-col gap-3 overflow-hidden" style={{ color: theme.node.text }}>
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        className="min-w-[220px]"
                        placeholder={t("canvas.workbench.selectProject")}
                        value={project?.id}
                        options={projects.map((item) => ({ value: item.id, label: `${item.name}（${item.shotCount} 镜）` }))}
                        onChange={async (id) => {
                            setLoading(true);
                            try {
                                const loaded = await getStoryboardProject(config, id);
                                setProject(loaded);
                                setStoryDraft(loaded.project.story);
                                setStyleDraft(loaded.project.style);
                                setMaxShotSeconds(loaded.project.max_shot_seconds || 10);
                                setTargetShotCount(loaded.project.target_shot_count || 0);
                                setActiveShotId(loaded.shots[0]?.id || "");
                                onProjectChange(loaded.id, loaded.project.name);
                            } catch (cause) {
                                message.error(cause instanceof Error ? cause.message : String(cause));
                            } finally {
                                setLoading(false);
                            }
                        }}
                    />
                    <Button icon={<Plus className="size-4" />} onClick={() => void createProject()} loading={saving}>
                        {t("canvas.workbench.newProject")}
                    </Button>
                    <Button icon={<RefreshCw className="size-4" />} onClick={() => void (project && persist(project))} loading={saving} disabled={!project}>
                        {t("canvas.workbench.save")}
                    </Button>
                    <Button icon={<Download className="size-4" />} onClick={() => void exportComfyJson()} disabled={!project}>
                        {t("canvas.workbench.exportComfy")}
                    </Button>
                    {project ? (
                        <Button
                            danger
                            icon={<Trash2 className="size-4" />}
                            onClick={() =>
                                Modal.confirm({
                                    title: t("canvas.workbench.deleteTitle", { name: project.project.name }),
                                    onOk: async () => {
                                        await deleteStoryboardProject(config, project.id);
                                        setProject(null);
                                        setStoryDraft("");
                                        await refreshProjects();
                                    },
                                })
                            }
                        >
                            {t("common.delete")}
                        </Button>
                    ) : null}
                </div>

                {error ? <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</div> : null}

                <div className="flex min-h-0 flex-1 gap-3">
                    {/* 左：故事与拆解 */}
                    <div className="flex w-[340px] shrink-0 flex-col gap-2 overflow-y-auto thin-scrollbar">
                        <div className="text-xs font-medium" style={{ color: theme.node.muted }}>
                            {t("canvas.workbench.story")}
                        </div>
                        <Input.TextArea
                            value={storyDraft}
                            onChange={(event) => setStoryDraft(event.target.value)}
                            placeholder={t("canvas.workbench.storyPlaceholder")}
                            autoSize={{ minRows: 8, maxRows: 14 }}
                        />
                        <Input value={styleDraft} onChange={(event) => setStyleDraft(event.target.value)} placeholder={t("canvas.workbench.stylePlaceholder")} />
                        <div className="flex items-center gap-2 text-xs">
                            <span style={{ color: theme.node.muted }}>{t("canvas.workbench.maxSeconds")}</span>
                            <InputNumber min={1} max={60} value={maxShotSeconds} onChange={(value) => setMaxShotSeconds(Number(value) || 10)} className="w-20" />
                            <span style={{ color: theme.node.muted }}>{t("canvas.workbench.shotCount")}</span>
                            <InputNumber min={0} max={60} value={targetShotCount} onChange={(value) => setTargetShotCount(Number(value) || 0)} className="w-20" />
                        </div>
                        <div className="flex items-center gap-2">
                            <Button type="primary" icon={breaking ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} loading={breaking} onClick={() => void runBreakdown()}>
                                {t("canvas.workbench.breakdown")}
                            </Button>
                            <Select
                                size="small"
                                className="w-28"
                                value={engine}
                                onChange={(value) => setEngine(value)}
                                options={[
                                    { value: "local", label: t("canvas.workbench.engineLocal") },
                                    { value: "cloud", label: t("canvas.workbench.engineCloud") },
                                ]}
                            />
                        </div>
                        <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                            {engine === "local" ? t("canvas.workbench.engineLocalHint") : t("canvas.workbench.engineCloudHint")}
                        </div>
                        {project?.story_beats.length ? (
                            <div className="rounded-lg border p-2 text-xs" style={{ borderColor: theme.node.stroke }}>
                                <div className="mb-1 font-medium" style={{ color: theme.node.muted }}>
                                    {t("canvas.workbench.beats")}
                                </div>
                                {project.story_beats.map((beat) => (
                                    <div key={beat.id} className="truncate" title={beat.summary}>
                                        · {beat.summary}
                                    </div>
                                ))}
                            </div>
                        ) : null}
                        {project?.characters.length ? (
                            <div className="rounded-lg border p-2 text-xs" style={{ borderColor: theme.node.stroke }}>
                                <div className="mb-1 font-medium" style={{ color: theme.node.muted }}>
                                    {t("canvas.workbench.characters")}
                                </div>
                                {project.characters.map((item) => (
                                    <div key={item.id} className="truncate" title={item.appearance}>
                                        · {item.name}
                                        {item.role ? `（${item.role}）` : ""}
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </div>

                    {/* 右：分镜表 */}
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <span className="text-xs" style={{ color: theme.node.muted }}>
                                {t("canvas.workbench.shotsTotal", { count: project?.shots.length || 0 })}
                            </span>
                            <span className="text-xs text-blue-500">{t("canvas.workbench.shotsSelected", { count: selectedShots.length })}</span>
                            <div className="flex-1" />
                            <Button
                                size="small"
                                disabled={!selectedShots.length || !onGenerateShots}
                                icon={<ImageIcon className="size-3.5" />}
                                onClick={async () => {
                                    try {
                                        await onGenerateShots?.(selectedShots);
                                    } catch (cause) {
                                        message.error(cause instanceof Error ? cause.message : String(cause));
                                    }
                                }}
                            >
                                {t("canvas.workbench.generateSelected")}
                            </Button>
                        </div>
                        {loading ? (
                            <div className="flex flex-1 items-center justify-center">
                                <Spin />
                            </div>
                        ) : !project?.shots.length ? (
                            <div className="flex flex-1 items-center justify-center">
                                <Empty description={t("canvas.workbench.noShots")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                            </div>
                        ) : (
                            <div className="min-h-0 flex-1 overflow-auto rounded-lg border thin-scrollbar" style={{ borderColor: theme.node.stroke }}>
                                <table className="w-full border-collapse text-xs">
                                    <thead className="sticky top-0" style={{ background: theme.node.fill }}>
                                        <tr style={{ color: theme.node.muted }}>
                                            <th className="w-8 p-2" />
                                            <th className="w-10 p-2 text-left">#</th>
                                            <th className="p-2 text-left">{t("canvas.workbench.colPrompt")}</th>
                                            <th className="w-16 p-2">{t("canvas.workbench.colDuration")}</th>
                                            <th className="w-24 p-2">{t("canvas.workbench.colMode")}</th>
                                            <th className="w-16 p-2">{t("canvas.workbench.colState")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {project.shots.map((shot, index) => (
                                            <tr
                                                key={shot.id}
                                                onClick={() => {
                                                    setActiveShotId(shot.id);
                                                    patchProject((current) => ({ ...current, active_shot_id: shot.id }));
                                                }}
                                                style={{ background: shot.id === activeShotId ? `${theme.node.text}08` : "transparent", borderTop: `1px solid ${theme.node.stroke}` }}
                                                className="cursor-pointer align-top"
                                            >
                                                <td className="p-2">
                                                    <Checkbox checked={shot.selected} onChange={(event) => patchShot(shot.id, { selected: event.target.checked })} />
                                                </td>
                                                <td className="p-2">{index + 1}</td>
                                                <td className="p-2">
                                                    <div className="font-medium">{shot.title}</div>
                                                    <div className="mt-0.5 line-clamp-2" style={{ color: theme.node.muted }} title={shot.positive}>
                                                        {shot.positive}
                                                    </div>
                                                </td>
                                                <td className="p-2 text-center">
                                                    <InputNumber size="small" min={1} max={60} value={shot.duration} onChange={(value) => patchShot(shot.id, { duration: Number(value) || 5 })} className="w-14" />
                                                </td>
                                                <td className="p-2">
                                                    <Select size="small" value={shot.video_mode} options={VIDEO_MODES.map((mode) => ({ value: mode, label: mode }))} onChange={(value) => patchShot(shot.id, { video_mode: value })} className="w-full" />
                                                </td>
                                                <td className="p-2 text-center">
                                                    {shot.status === "done" ? (
                                                        <Tag color="green">已完成</Tag>
                                                    ) : shot.status === "running" ? (
                                                        <Loader2 className="mx-auto size-3.5 animate-spin" />
                                                    ) : shot.status === "failed" ? (
                                                        <Tooltip title={shot.error}>
                                                            <Tag color="red">失败</Tag>
                                                        </Tooltip>
                                                    ) : (
                                                        <span style={{ color: theme.node.faint }}>—</span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        {/* 当前镜头的完整编辑区 */}
                        {activeShot ? (
                            <div className="space-y-1.5 rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                                <div className="flex items-center gap-2 text-xs">
                                    <Film className="size-3.5" />
                                    <span className="font-medium">{activeShot.title}</span>
                                    <span style={{ color: theme.node.muted }}>{activeShot.shot_type} · {activeShot.camera_angle}</span>
                                </div>
                                <Input.TextArea
                                    value={activeShot.positive}
                                    onChange={(event) => patchShot(activeShot.id, { positive: event.target.value })}
                                    placeholder={t("canvas.workbench.promptPlaceholder")}
                                    autoSize={{ minRows: 3, maxRows: 6 }}
                                />
                                <Input.TextArea
                                    value={activeShot.dialogue}
                                    onChange={(event) => patchShot(activeShot.id, { dialogue: event.target.value })}
                                    placeholder={t("canvas.workbench.dialoguePlaceholder")}
                                    autoSize={{ minRows: 1, maxRows: 3 }}
                                    className="text-xs"
                                />
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
        </Modal>
    );
}
