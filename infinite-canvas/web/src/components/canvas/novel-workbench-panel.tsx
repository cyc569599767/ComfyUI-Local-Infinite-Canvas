import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Empty, Input, InputNumber, Modal, Segmented, Select, Spin, Tag, Tooltip } from "antd";
import { BookOpen, Plus, RefreshCw, Save, Scroll, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { activePromptCloudApi, useEffectiveConfig } from "@/stores/use-config-store";
import {
    createNovel,
    deleteNovel,
    generateNovel,
    getNovel,
    listNovels,
    saveNovel,
    type NovelChapter,
    type NovelProject,
    type NovelSummary,
    type NovelVolume,
} from "@/services/api/novel";

/**
 * 「无限・卷轴」工作台。
 *
 * 四层结构：总纲 → 分卷 → 章纲 → 正文。左侧放设定与生成入口，
 * 右侧是分卷/章纲表格 + 当前章详情。
 *
 * 生成策略是「一层一步、正文一章一次」，不做「一键写完整本」：
 * 本地模型单次 token 上限写不了一整章，强行一次性要求只会得到被截断的半成品。
 */

type Props = {
    open: boolean;
    projectId?: string;
    nodeTitle?: string;
    onClose: () => void;
    onProjectChange: (id: string, name: string) => void;
};

type Tab = "volumes" | "chapters";

export function NovelWorkbenchPanel({ open, projectId, nodeTitle, onClose, onProjectChange }: Props) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const { message } = App.useApp();
    const config = useEffectiveConfig();

    const [novels, setNovels] = useState<NovelSummary[]>([]);
    const [project, setProject] = useState<NovelProject | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [generating, setGenerating] = useState("");
    const [error, setError] = useState("");
    const [tab, setTab] = useState<Tab>("volumes");
    const [activeChapterId, setActiveChapterId] = useState("");
    // 默认本地：本项目默认只有本地 ComfyUI 渠道，它没有 chat 接口。
    const [engine, setEngine] = useState<"local" | "cloud">("local");
    const [volumeCount, setVolumeCount] = useState(5);
    const [chapterCount, setChapterCount] = useState(20);
    const [targetWords, setTargetWords] = useState(1200);
    const [ideaDraft, setIdeaDraft] = useState("");
    const [createOpen, setCreateOpen] = useState(false);
    const [createName, setCreateName] = useState("");
    const [createIdea, setCreateIdea] = useState("");

    const refreshList = useCallback(async () => {
        try {
            setNovels(await listNovels(config));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, [config]);

    const loadProject = useCallback(
        async (id: string) => {
            if (!id) return;
            setLoading(true);
            try {
                const data = await getNovel(config, id);
                setProject(data);
                setIdeaDraft(data.idea);
                setActiveChapterId((current) => (data.chapters.some((c) => c.id === current) ? current : data.chapters[0]?.id || ""));
            } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
                setLoading(false);
            }
        },
        [config],
    );

    /**
     * 打开面板：先拉列表，再决定加载哪一本。
     *
     * 两个 effect 分开写会踩竞态：拉列表的 effect 返回后 novels 才更新，
     * 而「自动选中」的 effect 依赖里没有 novels，那时它已经跑过了、
     * 看到的还是空数组，于是一直停在空状态。合并成一个才不会漏。
     */
    useEffect(() => {
        if (!open) return;
        let alive = true;
        (async () => {
            setLoading(true);
            try {
                const list = await listNovels(config);
                if (!alive) return;
                setNovels(list);
                // 已绑定的项目优先；否则退到最近一个，避免打开就是空白。
                const targetId = projectId && list.some((item) => item.id === projectId) ? projectId : list[0]?.id;
                if (targetId) {
                    const data = await getNovel(config, targetId);
                    if (!alive) return;
                    setProject(data);
                    setIdeaDraft(data.idea);
                    setActiveChapterId((current) => (data.chapters.some((c) => c.id === current) ? current : data.chapters[0]?.id || ""));
                } else {
                    setProject(null);
                }
            } catch (cause) {
                if (alive) setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [open, projectId, config]);

    const activeChapter = useMemo(
        () => project?.chapters.find((c) => c.id === activeChapterId) || null,
        [project, activeChapterId],
    );

    /**
     * 云端生成要的是「云端 API」那份配置，不是 config.baseUrl。
     *
     * config.baseUrl 指向本地网关（127.0.0.1:8190/v1），它没有 /v1/chat/completions，
     * 直接拿它当云端端点会得到 "Not found: POST /v1/chat/completions"。
     * 真正的云端配置在 promptCloudApis 里，由 activePromptCloudApi 取当前激活项。
     */
    const cloud = useMemo(() => {
        if (engine !== "cloud") return undefined;
        const api = activePromptCloudApi(config);
        if (!api) return undefined;
        return { baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model, apiFormat: api.apiFormat };
    }, [engine, config]);

    // 选了云端却还没配云端 API：直接禁用生成并提示，别发一个注定 502 的请求。
    const cloudReady = engine !== "cloud" || Boolean(cloud?.baseUrl && cloud?.apiKey && cloud?.model);

    const patchChapter = (id: string, patch: Partial<NovelChapter>) => {
        setProject((current) => (current ? { ...current, chapters: current.chapters.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : current));
    };

    const patchVolume = (id: string, patch: Partial<NovelVolume>) => {
        setProject((current) => (current ? { ...current, volumes: current.volumes.map((v) => (v.id === id ? { ...v, ...patch } : v)) } : current));
    };

    const save = async () => {
        if (!project) return;
        setSaving(true);
        try {
            const next = await saveNovel(config, project.id, {
                name: project.name,
                idea: ideaDraft,
                structure: project.structure,
                characters: project.characters,
                memory: project.memory,
                volumes: project.volumes,
                chapters: project.chapters,
            });
            setProject(next);
            message.success(t("canvas.novel.saved"));
            void refreshList();
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setSaving(false);
        }
    };

    const runStep = async (step: "outline" | "volumes" | "chapters" | "write", chapterId?: string) => {
        if (!project) return;
        // 前置拦截：选了云端却没配云端 API 时，请求注定 404/502，先说清楚。
        if (!cloudReady) {
            message.error(t("canvas.novel.cloudNotConfigured"));
            return;
        }
        setGenerating(step + (chapterId || ""));
        setError("");
        try {
            const next = await generateNovel(config, project.id, {
                step,
                idea: ideaDraft,
                engine,
                cloud,
                volumeCount,
                chapterCount,
                targetWords,
                chapterId,
            });
            setProject(next);
            message.success(t(`canvas.novel.stepDone.${step}`));
            void refreshList();
        } catch (cause) {
            const text = cause instanceof Error ? cause.message : String(cause);
            setError(text);
            message.error(text);
        } finally {
            setGenerating("");
        }
    };

    const create = async () => {
        try {
            const created = await createNovel(config, { name: createName.trim(), idea: createIdea.trim() });
            setCreateOpen(false);
            setCreateName("");
            setCreateIdea("");
            await refreshList();
            setProject(created);
            setIdeaDraft(created.idea);
            onProjectChange(created.id, created.name);
            message.success(t("canvas.novel.created"));
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const remove = async () => {
        if (!project) return;
        Modal.confirm({
            title: t("canvas.novel.deleteTitle", { name: project.name }),
            okButtonProps: { danger: true },
            onOk: async () => {
                await deleteNovel(config, project.id);
                setProject(null);
                setActiveChapterId("");
                await refreshList();
                message.success(t("canvas.novel.deleted"));
            },
        });
    };

    const busy = Boolean(generating);

    return (
        <Modal
            open={open}
            onCancel={onClose}
            footer={null}
            width="94vw"
            centered
            destroyOnHidden
            transitionName=""
            maskTransitionName=""
            title={
                <span className="flex items-center gap-2">
                    <Scroll className="size-4" />
                    {t("canvas.workbench.novel")}
                    {nodeTitle ? <Tag color="gold">{nodeTitle}</Tag> : null}
                </span>
            }
        >
            <div className="flex max-h-[80vh] flex-col gap-2.5 overflow-hidden" style={{ color: theme.node.text }}>
                {/* 表格内的受控输入必须显式染色：antd 默认深色字在深色主题下与背景同色，
                    值填进去了却看不见，会被误判成「数据没加载出来」。 */}
                <style>{`
                    .novel-workbench-table .ant-input,
                    .novel-workbench-table .ant-input-sm,
                    .novel-workbench-table textarea.ant-input { color: ${theme.node.text}; background: transparent; }
                    .novel-workbench-table .ant-input::placeholder { color: ${theme.node.muted}; }
                `}</style>
                {/* 工具栏 */}
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        size="small"
                        value={project?.id}
                        placeholder={t("canvas.novel.selectProject")}
                        style={{ minWidth: 220 }}
                        options={novels.map((item) => ({ value: item.id, label: `${item.name}（${item.chapterCount} 章）` }))}
                        onChange={(id) => {
                            onProjectChange(id, novels.find((n) => n.id === id)?.name || "");
                            void loadProject(id);
                        }}
                    />
                    <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => setCreateOpen(true)}>
                        {t("canvas.novel.newProject")}
                    </Button>
                    <Button size="small" icon={<Save className="size-3.5" />} loading={saving} disabled={!project || busy} onClick={save}>
                        {t("canvas.novel.save")}
                    </Button>
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} disabled={busy} onClick={() => void refreshList()}>
                        {t("canvas.novel.refresh")}
                    </Button>
                    <div className="flex-1" />
                    {project ? (
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={busy} onClick={remove}>
                            {t("canvas.novel.delete")}
                        </Button>
                    ) : null}
                </div>

                {error ? <div className="rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-500">{error}</div> : null}

                {!project ? (
                    <div className="flex h-64 items-center justify-center">
                        {loading ? <Spin /> : <Empty description={t("canvas.novel.noProject")} image={Empty.PRESENTED_IMAGE_SIMPLE} />}
                    </div>
                ) : (
                    <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
                        {/* 左：设定与生成 */}
                        <div className="flex w-[300px] shrink-0 flex-col gap-2 overflow-y-auto pr-1 thin-scrollbar">
                            <div className="rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                                <div className="mb-1 text-xs font-medium">{t("canvas.novel.idea")}</div>
                                <Input.TextArea
                                    value={ideaDraft}
                                    onChange={(event) => setIdeaDraft(event.target.value)}
                                    autoSize={{ minRows: 4, maxRows: 8 }}
                                    className="text-xs"
                                    placeholder={t("canvas.novel.ideaPlaceholder")}
                                />
                            </div>

                            <div className="rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
                                    <Wand2 className="size-3.5" />
                                    {t("canvas.novel.generate")}
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    <Segmented
                                        size="small"
                                        block
                                        value={engine}
                                        onChange={(value) => setEngine(value as "local" | "cloud")}
                                        options={[
                                            { value: "local", label: t("canvas.novel.engineLocal") },
                                            { value: "cloud", label: t("canvas.novel.engineCloud") },
                                        ]}
                                    />
                                    {!cloudReady ? (
                                        <div className="rounded bg-amber-500/10 px-1.5 py-1 text-[11px] leading-4 text-amber-500">
                                            {t("canvas.novel.cloudNotConfigured")}
                                        </div>
                                    ) : null}
                                    <div className="flex items-center gap-1">
                                        <Button
                                            size="small"
                                            block
                                            loading={generating === "outline"}
                                            disabled={!cloudReady || (busy && generating !== "outline")}
                                            icon={<Sparkles className="size-3.5" />}
                                            onClick={() => void runStep("outline")}
                                        >
                                            {t("canvas.novel.stepOutline")}
                                        </Button>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button size="small" block loading={generating === "volumes"} disabled={!cloudReady || (busy && generating !== "volumes")} onClick={() => void runStep("volumes")}>
                                            {t("canvas.novel.stepVolumes")}
                                        </Button>
                                        <InputNumber size="small" min={1} max={30} value={volumeCount} onChange={(value) => setVolumeCount(Number(value) || 5)} style={{ width: 60 }} />
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button size="small" block loading={generating === "chapters"} disabled={!cloudReady || (busy && generating !== "chapters")} onClick={() => void runStep("chapters")}>
                                            {t("canvas.novel.stepChapters")}
                                        </Button>
                                        <InputNumber size="small" min={1} max={200} value={chapterCount} onChange={(value) => setChapterCount(Number(value) || 20)} style={{ width: 60 }} />
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button
                                            size="small"
                                            block
                                            type="primary"
                                            loading={generating === "write"}
                                            disabled={!cloudReady || (busy && generating !== "write") || !project.chapters.some((c) => c.outline && !c.novel)}
                                            onClick={() => void runStep("write")}
                                        >
                                            {t("canvas.novel.stepWrite")}
                                        </Button>
                                        <InputNumber size="small" min={300} max={6000} step={100} value={targetWords} onChange={(value) => setTargetWords(Number(value) || 1200)} style={{ width: 70 }} />
                                    </div>
                                    <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                                        {t("canvas.novel.writeHint")}
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                                    <BookOpen className="size-3.5" />
                                    {t("canvas.novel.outlineTitle")}
                                </div>
                                <Input.TextArea
                                    value={project.structure.outline}
                                    onChange={(event) => setProject({ ...project, structure: { ...project.structure, outline: event.target.value } })}
                                    autoSize={{ minRows: 5, maxRows: 12 }}
                                    className="text-xs"
                                    placeholder={t("canvas.novel.outlinePlaceholder")}
                                />
                            </div>

                            {project.characters.length ? (
                                <div className="rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                                    <div className="mb-1 text-xs font-medium">{t("canvas.novel.characters")}</div>
                                    <div className="space-y-1">
                                        {project.characters.map((character) => (
                                            <div key={character.id} className="text-[11px] leading-4">
                                                <span className="font-medium">{character.name}</span>
                                                {character.role ? <span style={{ color: theme.node.muted }}>（{character.role}）</span> : null}
                                                <div style={{ color: theme.node.muted }} className="line-clamp-2">
                                                    {character.description}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ) : null}
                        </div>

                        {/* 右：分卷 / 章纲 */}
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                            <div className="flex items-center gap-2">
                                <Segmented
                                    size="small"
                                    value={tab}
                                    onChange={(value) => setTab(value as Tab)}
                                    options={[
                                        { value: "volumes", label: t("canvas.novel.tabVolumes", { count: project.volumes.length }) },
                                        { value: "chapters", label: t("canvas.novel.tabChapters", { count: project.chapters.length }) },
                                    ]}
                                />
                                <div className="flex-1" />
                                <span className="text-xs" style={{ color: theme.node.muted }}>
                                    {t("canvas.novel.wordCount", { count: project.chapters.reduce((sum, c) => sum + c.novel.length, 0) })}
                                </span>
                            </div>

                            <div className="novel-workbench-table min-h-0 flex-1 overflow-auto rounded-lg border thin-scrollbar" style={{ borderColor: theme.node.stroke }}>
                                {tab === "volumes" ? (
                                    !project.volumes.length ? (
                                        <div className="flex h-32 items-center justify-center">
                                            <Empty description={t("canvas.novel.noVolumes")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                                        </div>
                                    ) : (
                                        <table className="w-full border-collapse text-xs">
                                            <thead className="sticky top-0 z-10" style={{ background: theme.node.fill }}>
                                                <tr style={{ color: theme.node.muted }}>
                                                    <th className="w-12 p-2 text-left">#</th>
                                                    <th className="w-40 p-2 text-left">{t("canvas.novel.colVolTitle")}</th>
                                                    <th className="w-24 p-2 text-left">{t("canvas.novel.colRange")}</th>
                                                    <th className="p-2 text-left">{t("canvas.novel.colVolOutline")}</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {project.volumes.map((volume) => (
                                                    <tr key={volume.id} style={{ borderTop: `1px solid ${theme.node.stroke}` }} className="align-top">
                                                        <td className="p-2">{volume.seq}</td>
                                                        <td className="p-2">
                                                            <Input size="small" value={volume.title} onChange={(event) => patchVolume(volume.id, { title: event.target.value })} />
                                                        </td>
                                                        <td className="p-2" style={{ color: theme.node.muted }}>
                                                            {volume.chapterFrom}-{volume.chapterTo}
                                                        </td>
                                                        <td className="p-2">
                                                            <Input.TextArea
                                                                value={volume.outline}
                                                                onChange={(event) => patchVolume(volume.id, { outline: event.target.value })}
                                                                autoSize={{ minRows: 2, maxRows: 5 }}
                                                                className="text-xs"
                                                            />
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )
                                ) : !project.chapters.length ? (
                                    <div className="flex h-32 items-center justify-center">
                                        <Empty description={t("canvas.novel.noChapters")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                                    </div>
                                ) : (
                                    <table className="w-full border-collapse text-xs">
                                        <thead className="sticky top-0 z-10" style={{ background: theme.node.fill }}>
                                            <tr style={{ color: theme.node.muted }}>
                                                <th className="w-12 p-2 text-left">#</th>
                                                <th className="w-16 p-2 text-left">{t("canvas.novel.colVol")}</th>
                                                <th className="w-44 p-2 text-left">{t("canvas.novel.colChapterTitle")}</th>
                                                <th className="p-2 text-left">{t("canvas.novel.colChapterOutline")}</th>
                                                <th className="w-20 p-2">{t("canvas.novel.colState")}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {project.chapters.map((chapter) => (
                                                <tr
                                                    key={chapter.id}
                                                    onClick={() => setActiveChapterId(chapter.id)}
                                                    className="cursor-pointer align-top"
                                                    style={{
                                                        borderTop: `1px solid ${theme.node.stroke}`,
                                                        background: chapter.id === activeChapterId ? `${theme.node.text}08` : "transparent",
                                                    }}
                                                >
                                                    <td className="p-2">{chapter.seq}</td>
                                                    <td className="p-2" style={{ color: theme.node.muted }}>{chapter.volume}</td>
                                                    <td className="p-2 font-medium">{chapter.title}</td>
                                                    <td className="p-2" style={{ color: theme.node.muted }}>
                                                        <div className="line-clamp-2">{chapter.outline}</div>
                                                    </td>
                                                    <td className="p-2 text-center">
                                                        <Tooltip title={t(`canvas.novel.state.${chapter.status}`)}>
                                                            <Tag color={chapter.status === "done" ? "green" : chapter.status === "outlined" ? "blue" : "default"}>
                                                                {chapter.novel ? `${Math.round(chapter.novel.length / 100) / 10}k` : t(`canvas.novel.state.${chapter.status}`)}
                                                            </Tag>
                                                        </Tooltip>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                            </div>

                            {/* 当前章详情 */}
                            {activeChapter ? (
                                <div className="flex h-[210px] shrink-0 flex-col gap-1.5 rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-medium">
                                            {t("canvas.novel.chapterN", { n: activeChapter.seq })} · {activeChapter.title}
                                        </span>
                                        <Tag color="purple">{t("canvas.novel.volumeN", { n: activeChapter.volume })}</Tag>
                                        <div className="flex-1" />
                                        <Button
                                            size="small"
                                            loading={generating === `write${activeChapter.id}`}
                                            disabled={!cloudReady || !activeChapter.outline || (busy && generating !== `write${activeChapter.id}`)}
                                            onClick={() => void runStep("write", activeChapter.id)}
                                        >
                                            {t("canvas.novel.writeThis")}
                                        </Button>
                                    </div>
                                    <Input.TextArea
                                        value={activeChapter.outline}
                                        onChange={(event) => patchChapter(activeChapter.id, { outline: event.target.value })}
                                        autoSize={{ minRows: 2, maxRows: 4 }}
                                        className="text-xs"
                                        placeholder={t("canvas.novel.chapterOutlinePlaceholder")}
                                    />
                                    <Input.TextArea
                                        value={activeChapter.novel}
                                        onChange={(event) => patchChapter(activeChapter.id, { novel: event.target.value, status: event.target.value ? "done" : "outlined" })}
                                        className="min-h-0 flex-1 text-xs"
                                        placeholder={t("canvas.novel.chapterBodyPlaceholder")}
                                    />
                                </div>
                            ) : null}
                        </div>
                    </div>
                )}
            </div>

            <Modal
                open={createOpen}
                title={t("canvas.novel.newProject")}
                onCancel={() => setCreateOpen(false)}
                onOk={() => void create()}
                okText={t("common.create")}
                cancelText={t("common.cancel")}
                destroyOnHidden
            >
                <div className="flex flex-col gap-2 pt-2">
                    <Input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder={t("canvas.novel.namePlaceholder")} />
                    <Input.TextArea value={createIdea} onChange={(event) => setCreateIdea(event.target.value)} autoSize={{ minRows: 4, maxRows: 8 }} placeholder={t("canvas.novel.ideaPlaceholder")} />
                </div>
            </Modal>
        </Modal>
    );
}