import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { App, Button, Modal, Popover, Select, Switch, Tooltip } from "antd";
import { ArrowDown, ArrowRight, ArrowUp, BookOpen, Download, Loader2, RotateCcw, Save, Trash2, Upload, Workflow } from "lucide-react";
import {
    CREATION_STAGES, currentCreationStage, defaultCreationPipeline, inspectCreationStage, validatePipelineConfig,
    type CreationPipelineState, type CreationStageId, type SkillPipelineConfig,
} from "@/lib/agent/creation-pipeline";
import { exportCreationPipeline, importCreationPipeline, listCreationSkills, loadCreationSkill } from "@/lib/agent/creation-skills";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCreationAgentStore } from "@/stores/use-creation-agent-store";
import { useCreationPipelineStore } from "@/stores/use-creation-pipeline-store";

type Props = { nodeId: string; disabled?: boolean };
const EMPTY_STATE: CreationPipelineState = { version: 1, completed: [] };
const DEFAULT_PIPELINE = defaultCreationPipeline();
const DEFAULT_BINDINGS = CREATION_STAGES.reduce((sum, stage) => sum + DEFAULT_PIPELINE.nodes[stage.id].skills.length, 0);
const DEFAULT_SKILLS = new Set(CREATION_STAGES.flatMap((stage) => DEFAULT_PIPELINE.nodes[stage.id].skills)).size;

function assertSkillsAvailable(config: SkillPipelineConfig, names: string[]) {
    const available = new Set(names);
    const missing = [...new Set(CREATION_STAGES.flatMap((stage) => config.nodes[stage.id].skills))].filter((name) => !available.has(name));
    if (missing.length) throw new Error(`缺少技能：${missing.join("、")}。请导入包含这些技能正文的完整 ZIP；原配置未覆盖。`);
}

export function CreationPipelinePanel({ nodeId, disabled = false }: Props) {
    const theme = useCanvasTheme();
    const { message, modal } = App.useApp();
    const config = useCreationPipelineStore((state) => state.config);
    const files = useCreationPipelineStore((state) => state.files);
    const hydrated = useCreationPipelineStore((state) => state.hydrated);
    const setConfig = useCreationPipelineStore((state) => state.setConfig);
    const importBundle = useCreationPipelineStore((state) => state.importBundle);
    const reset = useCreationPipelineStore((state) => state.reset);
    const anyRunning = useCreationAgentStore((state) => Object.keys(state.runs).length > 0);
    const snapshot = useAgentStore((state) => state.canvasContext?.snapshot);
    const [draft, setDraft] = useState(config);
    const [selectedStage, setSelectedStage] = useState<CreationStageId | null>(null);
    const [catalog, setCatalog] = useState<string[] | null>(null);
    const [catalogError, setCatalogError] = useState("");
    const [catalogAttempt, setCatalogAttempt] = useState(0);
    const [operation, setOperation] = useState<"import" | "export" | null>(null);
    const [appliedAt, setAppliedAt] = useState("");
    const [previewName, setPreviewName] = useState<string | null>(null);
    const [preview, setPreview] = useState<Awaited<ReturnType<typeof loadCreationSkill>> | null>(null);
    const [previewError, setPreviewError] = useState("");
    const [previewAttempt, setPreviewAttempt] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const transferRef = useRef(false);
    const dirty = JSON.stringify(draft) !== JSON.stringify(config);
    const editingLocked = disabled || anyRunning || !hydrated || operation !== null;
    const projectNode = snapshot?.nodes.find((node) => node.id === nodeId);
    const pipelineState = projectNode?.metadata?.creationPipeline || EMPTY_STATE;
    const renderMedia = projectNode?.metadata?.agentCreation?.createImages !== false;
    const renderVideos = projectNode?.metadata?.agentCreation?.createVideos !== false;
    const currentStage = currentCreationStage(pipelineState);
    const completedCount = CREATION_STAGES.filter((stage) => pipelineState.completed.includes(stage.id)).length;
    const bindings = CREATION_STAGES.reduce((sum, stage) => sum + draft.nodes[stage.id].skills.length, 0);
    const skillCount = new Set(CREATION_STAGES.flatMap((stage) => draft.nodes[stage.id].skills)).size;
    const muted = { color: theme.node.muted };
    const panelStyle = { background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text };

    useEffect(() => { setDraft(config); }, [config]);
    useEffect(() => {
        let active = true;
        setCatalog(null);
        setCatalogError("");
        if (hydrated) void listCreationSkills(files).then((names) => {
            if (active) setCatalog(names);
        }).catch((error: unknown) => {
            if (active) setCatalogError(error instanceof Error ? error.message : String(error));
        });
        return () => { active = false; };
    }, [files, hydrated, catalogAttempt]);
    useEffect(() => {
        let active = true;
        setPreview(null);
        setPreviewError("");
        if (previewName) void loadCreationSkill(previewName, files).then((skill) => {
            if (active) setPreview(skill);
        }).catch((error: unknown) => {
            if (active) setPreviewError(error instanceof Error ? error.message : String(error));
        });
        return () => { active = false; };
    }, [previewName, files, previewAttempt]);

    const assertEditable = () => {
        if (disabled || Object.keys(useCreationAgentStore.getState().runs).length) throw new Error("有创作项目正在运行，全局流水线配置暂不可修改；请等待运行结束后重试。");
        if (!useCreationPipelineStore.getState().hydrated) throw new Error("正在加载已保存的流水线配置，请稍后重试。");
    };
    const updateStage = (stage: CreationStageId, patch: Partial<SkillPipelineConfig["nodes"][CreationStageId]>) => {
        if (editingLocked) return;
        try {
            assertEditable();
            setDraft((previous) => ({ nodes: { ...previous.nodes, [stage]: { ...previous.nodes[stage], ...patch } } }));
        } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
    };
    const moveSkill = (stage: CreationStageId, index: number, direction: -1 | 1) => {
        const skills = [...draft.nodes[stage].skills];
        const target = index + direction;
        if (target < 0 || target >= skills.length) return;
        [skills[index], skills[target]] = [skills[target], skills[index]];
        updateStage(stage, { skills });
    };
    const save = () => {
        if (editingLocked || !catalog) return;
        try {
            assertEditable();
            const validated = validatePipelineConfig(draft);
            assertSkillsAvailable(validated, catalog);
            setConfig(validated);
            setAppliedAt(new Date().toLocaleTimeString());
            message.success("流水线配置已应用，浏览器将自动保存。下一次创作使用此配置。");
        } catch (error) { message.error(`保存失败：${error instanceof Error ? error.message : String(error)}`); }
    };
    const importFile = async (file: File) => {
        if (transferRef.current) return;
        transferRef.current = true;
        setOperation("import");
        try {
            assertEditable();
            if (file.size > 50 * 1024 * 1024) throw new Error("ZIP 文件超过 50MB，请缩小技能包后重试。");
            const bundle = await importCreationPipeline(new Uint8Array(await file.arrayBuffer()));
            const validated = validatePipelineConfig(bundle.config);
            const names = await listCreationSkills(bundle.files);
            assertSkillsAvailable(validated, names);
            // 校验期间其他工作台可能已启动，提交前必须再次检查全局运行态。
            assertEditable();
            importBundle(validated, bundle.files);
            setAppliedAt(new Date().toLocaleTimeString());
            message.success("ZIP 已验证并导入，配置已应用；浏览器将自动保存。");
        } catch (error) { message.error(`导入失败，原配置未覆盖：${error instanceof Error ? error.message : String(error)}`); }
        finally { transferRef.current = false; setOperation(null); }
    };
    const chooseImport = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file || editingLocked) return;
        if (dirty) {
            modal.confirm({
                title: "导入 ZIP 并替换未保存的修改？",
                content: "只有配置和技能文件全部验证通过后才会替换。验证失败会保留当前配置与修改。",
                okText: "验证并导入", cancelText: "取消",
                okButtonProps: { "aria-label": "确认验证并导入流水线 ZIP" }, cancelButtonProps: { "aria-label": "取消导入流水线 ZIP" },
                onOk: () => importFile(file),
            });
        } else void importFile(file);
    };
    const exportZip = async () => {
        if (!hydrated || transferRef.current) return;
        transferRef.current = true;
        setOperation("export");
        try {
            const validated = validatePipelineConfig(draft);
            const bytes = await exportCreationPipeline(validated, files);
            const blob = new Blob([new Uint8Array(bytes)], { type: "application/zip" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "creation-pipeline.zip";
            document.body.appendChild(link);
            try { link.click(); }
            finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
            message.success(dirty ? "ZIP 已导出（包含未保存的修改）；运行配置尚未改变。" : "流水线配置及完整技能文件已导出。");
        } catch (error) { message.error(`导出失败：${error instanceof Error ? error.message : String(error)}`); }
        finally { transferRef.current = false; setOperation(null); }
    };
    const restoreDefaults = () => {
        if (editingLocked) return;
        modal.confirm({
            title: "恢复默认创作流水线？",
            content: `恢复 ${DEFAULT_BINDINGS} 个默认绑定和 ${DEFAULT_SKILLS} 个技能，并清除已导入的技能覆盖及未保存修改。项目产物与执行进度不会被清除；如需保留自定义内容，请先导出 ZIP。`,
            okText: "恢复默认", cancelText: "取消",
            okButtonProps: { "aria-label": "确认恢复默认流水线" }, cancelButtonProps: { "aria-label": "取消恢复默认流水线" },
            onOk: () => {
                try {
                    assertEditable();
                    if (transferRef.current) throw new Error("正在处理 ZIP，请完成后重试。");
                    reset();
                    setAppliedAt(new Date().toLocaleTimeString());
                    message.success("默认配置已恢复，项目执行进度保持不变。");
                } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
            },
        });
    };

    const renderStage = (stage: typeof CREATION_STAGES[number], index: number) => {
        const entry = draft.nodes[stage.id];
        const inspection = inspectCreationStage(stage.id, pipelineState.review ? { ...pipelineState, review: undefined } : pipelineState, snapshot?.nodes || [], nodeId, renderMedia, renderVideos);
        const complete = pipelineState.completed.includes(stage.id);
        const current = Boolean(projectNode && currentStage === stage.id);
        const status = !projectNode ? "等待画布" : complete ? inspection.ready ? "已完成" : "待修复" : current ? inspection.waiting ? "生成中" : inspection.ready ? "待确认" : "当前阶段" : "待处理";
        const content = (
            <div className="w-[min(340px,76vw)] space-y-3" style={{ color: theme.node.text }} role="group" aria-label={`${stage.label}技能配置`}>
                <div className="flex items-start justify-between gap-3">
                    <div><div className="text-sm font-semibold">{String(index + 1).padStart(2, "0")} · {stage.label}</div><div className="mt-1 text-[11px]" style={muted}>技能从上至下按优先级使用；阶段顺序固定。</div></div>
                    <span className="shrink-0 rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: theme.node.stroke }}>{status}</span>
                </div>
                {entry.skills.length ? <ol className="thin-scrollbar max-h-60 space-y-1.5 overflow-y-auto" aria-label={`${stage.label}有序技能列表`}>
                    {entry.skills.map((name, skillIndex) => <li key={name} className="flex items-center gap-1 rounded-lg border px-2 py-1.5" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                        <span className="w-4 shrink-0 text-[10px] tabular-nums" style={muted}>{skillIndex + 1}</span>
                        <Tooltip title={`查看 ${name} 正文`}><button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs underline-offset-2 hover:underline focus-visible:underline" aria-label={`查看技能 ${name} 正文`} onClick={() => setPreviewName(name)}>{name}</button></Tooltip>
                        <Button type="text" size="small" aria-label={`上移技能 ${name}`} title="上移优先级" icon={<ArrowUp className="size-3" />} disabled={editingLocked || skillIndex === 0} onClick={() => moveSkill(stage.id, skillIndex, -1)} />
                        <Button type="text" size="small" aria-label={`下移技能 ${name}`} title="下移优先级" icon={<ArrowDown className="size-3" />} disabled={editingLocked || skillIndex === entry.skills.length - 1} onClick={() => moveSkill(stage.id, skillIndex, 1)} />
                        <Button type="text" size="small" danger aria-label={`删除技能 ${name}`} title="解除此阶段的绑定，不删除技能文件" icon={<Trash2 className="size-3" />} disabled={editingLocked} onClick={() => updateStage(stage.id, { skills: entry.skills.filter((skill) => skill !== name) })} />
                    </li>)}
                </ol> : <div className="rounded-lg border border-dashed p-3 text-xs" style={{ borderColor: theme.node.stroke, ...muted }}>{entry.fallback ? "未绑定技能，将自动匹配此阶段默认技能。" : "未绑定且关闭自动匹配，此阶段将无法运行。"}</div>}
                <Select aria-label={`为${stage.label}添加技能`} className="w-full" size="small" showSearch optionFilterProp="label" value={null} getPopupContainer={(trigger) => trigger.parentElement || trigger}
                    placeholder={catalogError ? "技能目录加载失败，请重试" : !catalog ? "技能目录加载中" : entry.skills.length >= 20 ? "每阶段最多绑定 20 个技能" : "添加技能至优先级末尾"}
                    disabled={editingLocked || !catalog || entry.skills.length >= 20}
                    options={(catalog || []).filter((name) => !entry.skills.includes(name)).map((name) => ({ value: name, label: name }))}
                    onChange={(name: string) => updateStage(stage.id, { skills: [...entry.skills, name] })} />
                <div className="flex items-center justify-between gap-3 text-xs"><span>允许自动匹配（fallback）</span><Switch size="small" aria-label={`${stage.label}自动匹配 fallback 开关`} checked={entry.fallback} disabled={editingLocked} onChange={(fallback) => updateStage(stage.id, { fallback })} /></div>
                <p className="text-[11px] leading-5" style={muted}>开启后，空绑定会匹配默认技能，并允许加载已安装的补充技能；关闭后仅使用绑定列表。修改后请点击「保存配置」。</p>
                {projectNode && (current || complete) && inspection.reasons.length > 0 ? <div className="border-t pt-2 text-xs leading-5" style={{ borderColor: theme.node.stroke }}>
                    <div className="font-medium">{complete ? "已完成产物需要修复" : "本阶段待处理"}</div>
                    <ul className="thin-scrollbar max-h-28 list-inside list-disc overflow-auto break-words" style={muted}>{inspection.reasons.map((reason, reasonIndex) => <li key={`${reasonIndex}-${reason}`}>{reason}</li>)}</ul>
                </div> : null}
                {current && inspection.ready ? <p className="text-[11px]" style={muted}>当前产物已满足检查条件，等待执行引擎确认；本面板不会推进阶段。</p> : null}
            </div>
        );
        return <li key={stage.id} className="relative min-w-0">
            <Popover content={content} trigger={["hover", "click"]} placement="bottom" mouseEnterDelay={0.15} mouseLeaveDelay={0.2}
                open={selectedStage === stage.id} onOpenChange={(open) => setSelectedStage((previous) => open ? stage.id : previous === stage.id ? null : previous)}
                styles={{ container: { background: theme.node.panel, border: `1px solid ${theme.node.stroke}` } }}>
                <button type="button" aria-label={`阶段${index + 1} ${stage.label}，${status}，编辑技能`} aria-expanded={selectedStage === stage.id}
                    className="flex w-full cursor-pointer flex-col gap-2 rounded-xl border p-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ background: current || selectedStage === stage.id ? theme.node.fill : theme.node.panel, borderColor: current || selectedStage === stage.id ? theme.node.activeStroke : theme.node.stroke, color: theme.node.text }}>
                    <span className="flex w-full items-center justify-between gap-1"><span className="flex size-6 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums" style={{ background: theme.node.fill, color: theme.node.text }}>{String(index + 1).padStart(2, "0")}</span><span className="text-[10px]" style={muted}>{status}</span></span>
                    <span className="text-xs font-semibold">{stage.label}</span>
                    <span className="text-[10px]" style={muted}>{entry.skills.length} 技能 · {entry.fallback ? "自动匹配" : "仅绑定"}</span>
                </button>
            </Popover>
            {index % 4 !== 3 ? <ArrowRight aria-hidden="true" className="absolute -right-5 top-1/2 size-4 -translate-y-1/2" style={muted} /> : null}
        </li>;
    };

    return <section className="space-y-3 rounded-xl border p-3" style={panelStyle} aria-label="创作技能流水线">
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold"><Workflow className="size-4" aria-hidden="true" />创作技能流水线<span className="rounded-full border px-2 py-0.5 text-[10px] font-normal" style={{ borderColor: theme.node.stroke }}>{bindings} 绑定 / {skillCount} skills</span></h3>
                <p className="mt-1 text-[11px] leading-5" style={muted}>12 个固定阶段按箭头顺序执行；点击或悬浮节点编辑技能优先级，不支持拖拽改序。</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
                <Button size="small" aria-label="恢复默认流水线" icon={<RotateCcw className="size-3.5" />} disabled={editingLocked} onClick={restoreDefaults}>恢复默认</Button>
                <Button size="small" aria-label="导入流水线 ZIP" icon={<Upload className="size-3.5" />} disabled={editingLocked} loading={operation === "import"} onClick={() => inputRef.current?.click()}>导入 ZIP</Button>
                <Tooltip title="导出面板中的配置（含未保存修改）与绑定技能的完整文件，不改变运行配置。"><Button size="small" aria-label="导出流水线 ZIP" icon={<Download className="size-3.5" />} disabled={!hydrated || operation !== null} loading={operation === "export"} onClick={() => void exportZip()}>导出 ZIP</Button></Tooltip>
                <Button size="small" type="primary" aria-label="保存流水线配置" icon={<Save className="size-3.5" />} disabled={editingLocked || !dirty || !catalog} onClick={save}>保存配置</Button>
                <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden" aria-label="选择流水线 ZIP 文件" disabled={editingLocked} onChange={chooseImport} />
            </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]" aria-live="polite">
            <span>{!projectNode ? "等待当前项目画布快照" : pipelineState.review ? "当前：素材重生成待确认 · 流水线已暂停，原完成记录保留" : `当前：${CREATION_STAGES.find((stage) => stage.id === currentStage)?.label || "全部阶段已完成"} · 已完成 ${completedCount}/12 · 待处理 ${12 - completedCount}`}</span>
            <span role="status" style={muted}>{!hydrated ? "正在加载已保存配置…" : operation === "import" ? "正在验证 ZIP，尚未覆盖原配置…" : operation === "export" ? "正在打包完整技能文件…" : dirty ? "有未保存修改 · 运行仍使用上次保存的配置" : appliedAt ? `${appliedAt} 已应用 · 浏览器自动保存` : "配置已加载 · 修改后请保存"}</span>
        </div>
        {disabled || anyRunning ? <p role="status" className="rounded-lg border px-2.5 py-2 text-[11px] leading-5" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>有创作项目正在运行：全局配置编辑、导入及重置已锁定，仍可查看技能与导出备份。</p> : null}
        {!renderMedia ? <p role="note" className="rounded-lg border px-2.5 py-2 text-xs leading-5" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>当前为纯文本模式：仅生成文字方案、素材描述与提示词，不代表图片、音频、视频已制作完成，也不是完整媒体制作。</p> : !renderVideos ? <p className="text-[11px]" style={muted}>当前未启用视频生成，阶段完成不代表已制作视频或合成成片。</p> : null}
        {catalogError ? <div role="alert" className="flex flex-wrap items-center gap-2 text-xs"><span>技能目录加载失败：{catalogError}</span><Button size="small" aria-label="重试加载技能目录" onClick={() => setCatalogAttempt((attempt) => attempt + 1)}>重试</Button></div> : null}
        <div className="thin-scrollbar overflow-x-auto pb-1" role="group" aria-label="十二阶段固定执行顺序">
            <div className="min-w-[620px]">
                {[0, 1, 2].map((row) => <div key={row}>
                    <ol start={row * 4 + 1} className="grid grid-cols-4 gap-6" aria-label={`第 ${row + 1} 行执行阶段`}>{CREATION_STAGES.slice(row * 4, row * 4 + 4).map((stage, index) => renderStage(stage, row * 4 + index))}</ol>
                    {row < 2 ? <svg className="h-7 w-full" viewBox="0 0 1000 28" preserveAspectRatio="none" aria-hidden="true" style={muted}><path d="M 884 0 V 10 Q 884 14 880 14 H 120 Q 116 14 116 18 V 26 M 112 22 L 116 26 L 120 22" fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" /></svg> : null}
                </div>)}
            </div>
        </div>
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t pt-2 text-[10px] leading-5" style={{ borderColor: theme.node.stroke, ...muted }}>
            <span>全局配置 · 默认 {DEFAULT_BINDINGS} 绑定 / {DEFAULT_SKILLS} skills · 项目进度由执行引擎实时写入</span>
            <span>技能包：PolyForm Noncommercial 1.0.0，商业使用需授权。</span>
        </div>
        <Modal open={previewName !== null} onCancel={() => setPreviewName(null)} footer={null} width="min(800px, 94vw)" destroyOnHidden
            closable={{ "aria-label": "关闭技能正文预览" }} styles={{ container: panelStyle, header: { background: theme.node.panel }, title: { color: theme.node.text } }}
            title={<span className="flex items-center gap-2"><BookOpen className="size-4" aria-hidden="true" /><span className="break-all">{previewName} · 技能正文</span></span>}>
            <div className="space-y-2" style={{ color: theme.node.text }}>
                <p className="text-[11px]" style={muted}>只读预览；正文以纯文本展示，不执行其中的代码或指令。</p>
                {previewError ? <div role="alert" className="space-y-2 text-xs"><p>技能正文加载失败：{previewError}</p><Button size="small" aria-label="重试加载技能正文" onClick={() => setPreviewAttempt((attempt) => attempt + 1)}>重试</Button></div> : preview && preview.name === previewName ? <>
                    <pre className="thin-scrollbar max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 text-xs leading-6" style={panelStyle} aria-label={`${previewName}技能正文`}>{preview.content}</pre>
                    <p className="text-[11px]" style={muted}>附带 {preview.references.length} 个可读取参考文件；导出 ZIP 会保留绑定技能的完整文件。</p>
                </> : <div role="status" className="flex items-center gap-2 py-6 text-xs"><Loader2 className="size-4 animate-spin" aria-hidden="true" />正在读取技能正文…</div>}
            </div>
        </Modal>
    </section>;
}
