import { Alert, App, Button, Input, Modal, Select, Spin, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchWorkflowModels, saveWorkflowModels, type RegisteredWorkflow, type WorkflowModelConfig, type WorkflowModelField } from "@/services/api/resources";

const keyFor = (field: WorkflowModelField) => `${field.nodeId}\u0000${field.input}`;

export function WorkflowModelConfigDialog({ workflow, onClose, onSaved }: {
    workflow: RegisteredWorkflow | null; onClose: () => void; onSaved: () => void;
}) {
    const { i18n } = useTranslation();
    const zh = i18n.language.startsWith("zh");
    const { message } = App.useApp();
    const [data, setData] = useState<WorkflowModelConfig | null>(null);
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const request = useRef(0);
    const currentId = useRef(workflow?.id);
    currentId.current = workflow?.id;
    const load = async (id: string) => {
        const serial = ++request.current;
        setLoading(true); setError(""); setData(null);
        try {
            const next = await fetchWorkflowModels(id);
            if (request.current !== serial || currentId.current !== id) return;
            setData(next); setDraft(Object.fromEntries(next.fields.map(f => [keyFor(f), f.value])));
        } catch (e) {
            if (request.current === serial && currentId.current === id) setError(e instanceof Error ? e.message : String(e));
        } finally { if (request.current === serial && currentId.current === id) setLoading(false); }
    };
    useEffect(() => {
        setSaving(false); setData(null); setError("");
        if (workflow?.id) void load(workflow.id);
        return () => { request.current += 1; };
    }, [workflow?.id]);
    const changes = data?.fields.filter(f => (draft[keyFor(f)] ?? f.value) !== f.value) || [];
    const invalid = changes.some(f => {
        const value = draft[keyFor(f)];
        return value !== f.defaultValue && (f.missingNode || !value?.trim() || ((f.optionKind === "files" || f.options.length > 0) && !f.options.includes(value)));
    });
    const save = async () => {
        if (!data || !changes.length || saving || data.offline || invalid) return;
        const id = data.id, serial = request.current;
        setSaving(true); setError("");
        try {
            await saveWorkflowModels(id, { overrides: changes.map(f => ({ nodeId: f.nodeId, input: f.input, value: draft[keyFor(f)] === f.defaultValue ? null : draft[keyFor(f)] })) });
            if (request.current !== serial || currentId.current !== id) return;
            message.success(zh ? "模型配置已保存，后续任务使用新设置；兼容性仍需实际生成验证。" : "Saved for future tasks. Model compatibility still requires generation testing.");
            onSaved(); onClose();
        } catch (e) { if (request.current === serial && currentId.current === id) setError(e instanceof Error ? e.message : String(e)); }
        finally { if (request.current === serial && currentId.current === id) setSaving(false); }
    };
    return <Modal open={Boolean(workflow)} width={860} title={`${zh ? "配置模型" : "Configure models"} · ${workflow?.label || ""}`} onCancel={() => { if (!saving) onClose(); }} maskClosable={!saving} closable={!saving} destroyOnHidden
        footer={<div className="flex flex-wrap justify-between gap-2">
            <Button disabled={!data || loading || saving || data.offline} onClick={() => setDraft(Object.fromEntries(data!.fields.map(f => [keyFor(f), f.defaultValue])))}>{zh ? "恢复全部默认" : "Restore all defaults"}</Button>
            <div className="flex gap-2"><Button disabled={saving} onClick={onClose}>{zh ? "取消" : "Cancel"}</Button><Button type="primary" loading={saving} disabled={!data || loading || data.offline || invalid || !changes.length} onClick={() => void save()}>{zh ? "保存模型配置" : "Save model settings"}</Button></div>
        </div>}>
        <p className="mb-3 text-xs leading-5 text-stone-600 dark:text-stone-300">{zh ? "仅影响当前工作流的后续任务，不修改或下载权重文件。默认不自动替换相似模型；候选来自对应加载器，可选不等于兼容。恢复默认也需点击保存。" : "Applies only to future tasks of this workflow. No weights are modified or downloaded. Options come from each loader; availability does not guarantee compatibility. Save to apply defaults."}</p>
        {error && <Alert type="error" showIcon className="mb-3" message={error} action={<Button size="small" disabled={saving} onClick={() => workflow && void load(workflow.id)}>{zh ? "重新读取" : "Reload"}</Button>} />}
        {data?.offline && <Alert type="warning" showIcon className="mb-3" message={zh ? "ComfyUI 离线，当前只读；连接后重新读取模型。" : "ComfyUI is offline. Read-only until reconnected."} action={<Button size="small" onClick={() => workflow && void load(workflow.id)}>{zh ? "重试" : "Retry"}</Button>} />}
        {loading ? <div className="p-10 text-center"><Spin /></div> : <div className="thin-scrollbar max-h-[58vh] space-y-3 overflow-y-auto pr-1">
            {data?.fields.map(f => {
                const key = keyFor(f), value = draft[key] ?? f.value;
                const options = [...new Set([f.defaultValue, f.value, ...f.options])].map(v => ({ value: v, label: v, disabled: v !== f.defaultValue && !f.options.includes(v) }));
                return <section key={key} data-model-field={`${f.nodeId}.${f.input}`} className="rounded-xl border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-700 dark:bg-stone-900">
                    <div className="mb-1 flex flex-wrap items-start justify-between gap-1"><span className="break-all text-xs font-semibold">{f.label}</span><Tag color={value !== f.defaultValue ? "blue" : f.available ? "green" : "orange"}>{value !== f.value ? (zh ? "待保存" : "Unsaved") : value !== f.defaultValue ? (zh ? "自定义" : "Custom") : f.available ? (zh ? "默认" : "Default") : (zh ? "缺模型 / 节点" : "Missing model / node")}</Tag></div>
                    <div className="mb-2 break-all text-[11px] text-stone-500">{f.nodeId} · {f.classType} · {f.input}<br />{zh ? "参考默认：" : "Reference default: "}{f.defaultValue}</div>
                    {f.compatibilityError && value === f.value && <Alert className="mb-2" type="error" showIcon message={f.compatibilityError} />}
                    {Boolean(f.rejectedOptions?.length) && <details className="mb-2 text-[11px] text-amber-700 dark:text-amber-300"><summary className="cursor-pointer">{zh ? `已排除 ${f.rejectedOptions!.length} 个已知不兼容候选` : `Excluded ${f.rejectedOptions!.length} incompatible options`}</summary>{f.rejectedOptions!.map(option => <p key={option.value} className="mt-1 break-all">{option.value}：{option.reason}</p>)}</details>}
                    <div className="flex items-start gap-2">
                        {f.optionKind === "repository" && !f.options.length ? <Input aria-label={`${f.nodeId}.${f.input}`} disabled={saving || data.offline || f.missingNode} value={value} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} /> : <Select aria-label={`${f.nodeId}.${f.input}`} showSearch optionFilterProp="label" className="min-w-0 flex-1" popupMatchSelectWidth={false} styles={{ popup: { root: { maxWidth: "85vw" } } }} disabled={saving || data.offline || f.missingNode || !f.options.length} value={value} options={options} onChange={v => setDraft(d => ({ ...d, [key]: v }))} />}
                        <Button size="small" disabled={saving || data.offline || value === f.defaultValue} onClick={() => setDraft(d => ({ ...d, [key]: f.defaultValue }))}>{zh ? "恢复默认" : "Default"}</Button>
                    </div>
                    {f.optionKind === "repository" && <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">{zh ? "仓库 ID 由节点解析；实际生成时节点可能下载尚未缓存的模型。保存本身不下载。" : "The node resolves repository IDs and may download uncached models during generation, not on save."}</div>}
                    {!f.options.length && f.optionKind === "files" && <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">{zh ? "无已识别候选，请让 ComfyUI 识别对应目录中的模型后重新读取。" : "No recognized options. Refresh after ComfyUI recognizes the models."}</div>}
                </section>;
            })}
        </div>}
    </Modal>;
}
