import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Input, Modal, Select } from "antd";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readWorkflowApps, writeWorkflowApps, type WorkflowApp, type WorkflowAppStep } from "@/lib/canvas/workflow-apps";
import type { FreeWorkflowSummary } from "@/services/api/free-workflow";

type DraftStep = { workflowId: string; label: string };

type Props = {
    open: boolean;
    onClose: () => void;
    /** 可用的工作流列表，由画布页传入（已经拉过一次，不在这里重复请求）。 */
    workflows: FreeWorkflowSummary[];
    /** 编辑已有应用时传入；不传表示新建。 */
    editing?: WorkflowApp | null;
    onSaved?: (app: WorkflowApp) => void;
};

function emptyStep(): DraftStep {
    return { workflowId: "", label: "" };
}

/**
 * 表单式「应用」编辑器。
 *
 * 步骤顺序就是执行链的顺序：第 1 步在第 0 列、第 2 步在第 1 列，依此类推，
 * 保存时会串成一条「上一步产出给下一步」的线性链。
 *
 * 为什么不做自由连线：应用的价值是把一段固定流程固化下来，用户需要的是
 * 「哪几步、什么顺序」，而不是再画一遍图。要自由编排可以直接在画布上拖卡片。
 * 数字人这种「语音克隆 → 视频生成」正是两段线性链。
 */
export function WorkflowAppEditorModal({ open, onClose, workflows, editing, onSaved }: Props) {
    const { t } = useTranslation();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [steps, setSteps] = useState<DraftStep[]>([emptyStep()]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    // 每次打开都重置：复用同一个弹窗时不能残留上一次的草稿。
    useEffect(() => {
        if (!open) return;
        setName(editing?.name || "");
        setDescription(editing?.description || "");
        setSteps(editing?.steps.length ? editing.steps.map((step) => ({ workflowId: step.workflowId, label: step.label || "" })) : [emptyStep()]);
        setError("");
        setSaving(false);
    }, [editing, open]);

    const workflowOptions = useMemo(
        () => workflows.map((item) => ({
            value: item.id,
            label: `${item.name}（${item.outputType ? t(`canvas.sidePanel.workflowOutput.${item.outputType}`) : t("canvas.sidePanel.workflowOutput.other")}）`,
        })),
        [t, workflows],
    );
    const workflowName = useMemo(() => new Map(workflows.map((item) => [item.id, item.name])), [workflows]);

    const patchStep = (index: number, patch: Partial<DraftStep>) => {
        setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
    };

    const move = (index: number, delta: number) => {
        setSteps((current) => {
            const next = [...current];
            const target = index + delta;
            if (target < 0 || target >= next.length) return current;
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
    };

    const removedWorkflow = steps.some((step) => step.workflowId && !workflowName.has(step.workflowId));

    const save = () => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            setError(t("canvas.sidePanel.workflowAppNameRequired"));
            return;
        }
        const valid = steps.filter((step) => step.workflowId.trim());
        if (!valid.length) {
            setError(t("canvas.sidePanel.workflowAppStepsRequired"));
            return;
        }
        setSaving(true);
        const now = new Date().toISOString();
        const nextSteps: WorkflowAppStep[] = valid.map((step, index) => ({
            workflowId: step.workflowId.trim(),
            label: step.label.trim() || undefined,
            column: index,
        }));
        const app: WorkflowApp = {
            id: editing?.id || `app-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: trimmedName,
            description: description.trim() || undefined,
            createdAt: editing?.createdAt || now,
            updatedAt: now,
            steps: nextSteps,
        };
        const apps = readWorkflowApps();
        const next = editing ? apps.map((item) => (item.id === app.id ? app : item)) : [...apps, app];
        if (!writeWorkflowApps(next)) {
            setSaving(false);
            setError(t("canvas.sidePanel.workflowAppSaveFailed"));
            return;
        }
        setSaving(false);
        onSaved?.(app);
        onClose();
    };

    return (
        <Modal
            title={editing ? t("canvas.sidePanel.workflowAppEditTitle") : t("canvas.sidePanel.workflowAppCreateTitle")}
            open={open}
            onCancel={onClose}
            destroyOnHidden
            width={640}
            footer={[
                <Button key="cancel" onClick={onClose}>{t("common.cancel")}</Button>,
                <Button key="save" type="primary" loading={saving} onClick={save}>{t("common.save")}</Button>,
            ]}
        >
            <div className="space-y-4 pt-2">
                <div>
                    <div className="mb-1.5 text-xs font-medium opacity-70">{t("canvas.sidePanel.workflowAppName")}</div>
                    <Input
                        value={name}
                        maxLength={60}
                        placeholder={t("canvas.sidePanel.workflowAppNamePlaceholder")}
                        onChange={(event) => { setName(event.target.value); setError(""); }}
                    />
                </div>
                <div>
                    <div className="mb-1.5 text-xs font-medium opacity-70">{t("canvas.sidePanel.workflowAppDescription")}</div>
                    <Input
                        value={description}
                        maxLength={200}
                        placeholder={t("canvas.sidePanel.workflowAppDescriptionPlaceholder")}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </div>

                <div>
                    <div className="mb-1.5 flex items-center justify-between">
                        <div className="text-xs font-medium opacity-70">{t("canvas.sidePanel.workflowAppSteps")}</div>
                        <span className="text-[11px] opacity-45">{t("canvas.sidePanel.workflowAppStepsHint")}</span>
                    </div>
                    <div className="space-y-2">
                        {steps.map((step, index) => (
                            <div key={index} className="flex items-center gap-2">
                                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-black/5 text-[11px] font-medium opacity-70 dark:bg-white/10">{index + 1}</span>
                                {/* antd 的 Select / Input 根节点不接受 flex 类的宽度控制（内部有固定 min-width 与 inline-block），
                                    宽度必须由外层 div 给，否则 Select 会被挤成 24px、Input 会撑满整行。 */}
                                <div className="min-w-0 flex-1">
                                    <Select
                                        className="w-full"
                                        value={step.workflowId || undefined}
                                        placeholder={t("canvas.sidePanel.workflowAppPickWorkflow")}
                                        options={workflowOptions}
                                        showSearch
                                        optionFilterProp="label"
                                        onChange={(value) => patchStep(index, { workflowId: value })}
                                    />
                                </div>
                                <div className="w-32 shrink-0">
                                    <Input
                                        value={step.label}
                                        maxLength={30}
                                        placeholder={t("canvas.sidePanel.workflowAppStepLabel")}
                                        onChange={(event) => patchStep(index, { label: event.target.value })}
                                    />
                                </div>
                                <button
                                    type="button"
                                    className="grid size-7 shrink-0 place-items-center rounded-md opacity-45 transition hover:bg-black/10 hover:opacity-100 disabled:opacity-20 dark:hover:bg-white/10"
                                    title={t("canvas.sidePanel.workflowAppMoveUp")}
                                    aria-label={t("canvas.sidePanel.workflowAppMoveUp")}
                                    disabled={index === 0}
                                    onClick={() => move(index, -1)}
                                >
                                    <ArrowUp className="size-3.5" />
                                </button>
                                <button
                                    type="button"
                                    className="grid size-7 shrink-0 place-items-center rounded-md opacity-45 transition hover:bg-black/10 hover:opacity-100 disabled:opacity-20 dark:hover:bg-white/10"
                                    title={t("canvas.sidePanel.workflowAppMoveDown")}
                                    aria-label={t("canvas.sidePanel.workflowAppMoveDown")}
                                    disabled={index === steps.length - 1}
                                    onClick={() => move(index, 1)}
                                >
                                    <ArrowDown className="size-3.5" />
                                </button>
                                <button
                                    type="button"
                                    className="grid size-7 shrink-0 place-items-center rounded-md opacity-45 transition hover:bg-black/10 hover:opacity-100 disabled:opacity-20 dark:hover:bg-white/10"
                                    title={t("canvas.sidePanel.workflowAppRemoveStep")}
                                    aria-label={t("canvas.sidePanel.workflowAppRemoveStep")}
                                    disabled={steps.length === 1}
                                    onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            </div>
                        ))}
                    </div>
                    <Button className="mt-2" size="small" icon={<Plus className="size-3.5" />} onClick={() => setSteps((current) => [...current, emptyStep()])}>
                        {t("canvas.sidePanel.workflowAppAddStep")}
                    </Button>
                </div>

                {!workflows.length ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="text-xs opacity-55">{t("canvas.sidePanel.workflowAppNoWorkflows")}</span>} />
                ) : null}

                {removedWorkflow ? (
                    <div className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">{t("canvas.sidePanel.workflowAppRemovedStep")}</div>
                ) : null}
                {error ? <div className="text-xs text-red-500">{error}</div> : null}
            </div>
        </Modal>
    );
}
