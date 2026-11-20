import { Alert, App, Button, Switch, Tag } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchRegisteredWorkflows, setWorkflowVisibility, type RegisteredWorkflow } from "@/services/api/resources";
import { WorkflowModelConfigDialog } from "./workflow-model-config-dialog";

export const CREATION_WORKFLOW_IDS = [
    "creation-image-krea2", "creation-image-qwen21-edit", "creation-video-h3-768", "creation-video-h3-1080",
    "creation-audio-voice-design", "creation-audio-voice-clone", "creation-audio-music",
];
export function CreationWorkflowSection() {
    const { i18n } = useTranslation();
    const zh = i18n.language.startsWith("zh");
    const { message } = App.useApp();
    const [workflows, setWorkflows] = useState<RegisteredWorkflow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [editing, setEditing] = useState<RegisteredWorkflow | null>(null);
    const [busy, setBusy] = useState("");
    const serial = useRef(0);
    const load = useCallback(async () => {
        const id = ++serial.current;
        setLoading(true); setError("");
        try {
            const all = await fetchRegisteredWorkflows();
            if (serial.current === id) setWorkflows(CREATION_WORKFLOW_IDS.flatMap(key => all.filter(w => w.id === key)));
        } catch (e) { if (serial.current === id) setError(e instanceof Error ? e.message : String(e)); }
        finally { if (serial.current === id) setLoading(false); }
    }, []);
    useEffect(() => {
        void load();
        const refresh = () => void load();
        window.addEventListener("local-gateway-refresh-resources", refresh);
        return () => { serial.current += 1; window.removeEventListener("local-gateway-refresh-resources", refresh); };
    }, [load]);
    const toggle = async (id: string, enabled: boolean) => {
        if (busy) return;
        setBusy(id);
        try {
            await setWorkflowVisibility(id, enabled);
            setWorkflows(items => items.map(w => w.id === id ? { ...w, enabled } : w));
            window.dispatchEvent(new Event("local-gateway-refresh-models"));
        } catch (e) { message.error(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(""); }
    };
    return <section data-creation-workflows className="rounded-xl border border-sky-200 bg-sky-50/40 p-3 dark:border-sky-900 dark:bg-sky-950/20">
        <div className="mb-1 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{zh ? "无限创作专用工作流" : "Creation workflows"} <span className="text-xs font-normal text-stone-500">{workflows.length}/7</span></h3><Button size="small" loading={loading} onClick={() => void load()}>{zh ? "刷新工作流" : "Refresh workflows"}</Button></div>
        <p className="mb-3 text-xs text-stone-600 dark:text-stone-300">{zh ? "包含未就绪的图像、视频与音频工作流。可独立配置主模型、文本编码器、VAE、LoRA 与音频模型；不会自动选择替代权重。" : "Includes unavailable image, video and audio workflows. Configure each model, encoder, VAE or LoRA independently; no automatic substitutions."}</p>
        {error && <Alert className="mb-2" type="error" showIcon message={error} />}
        {!loading && !error && workflows.length < 7 && <Alert className="mb-2" type="warning" showIcon message={zh ? "部分专用工作流尚未加载，请更新桌面运行时及网关后刷新。" : "Some creation workflows are not loaded. Update the desktop runtime and gateway, then refresh."} />}
        <div className="grid gap-2 md:grid-cols-2">
            {workflows.map(w => <article data-creation-workflow={w.id} key={w.id} className="min-w-0 rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-700 dark:bg-stone-900">
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="text-xs font-semibold">{w.label}</div><div className="mt-1 break-all text-[10px] text-stone-500">{w.id}</div></div><Tag color={w.availability?.available ? "green" : "orange"}>{w.availability?.available ? (zh ? "就绪" : "Ready") : (zh ? "缺依赖 / 待检测" : "Not ready")}</Tag></div>
                <div className="mt-2 flex items-center justify-between gap-2"><span className="text-[11px] text-stone-500">{({image: zh ? "图像" : "Image", video: zh ? "视频" : "Video", audio: zh ? "音频" : "Audio"} as Record<string, string>)[w.type] || w.type}</span><div className="flex items-center gap-2"><Switch size="small" aria-label={`${zh ? "启用" : "Enable"} ${w.id}`} checked={w.enabled !== false} disabled={Boolean(busy)} loading={busy === w.id} onChange={v => void toggle(w.id, v)} /><Button size="small" aria-label={`${zh ? "配置模型" : "Configure models"} ${w.id}`} onClick={() => setEditing(w)}>{zh ? "配置模型" : "Configure models"}</Button></div></div>
                {Boolean(w.availability?.problems?.length) && <details className="mt-2 text-[11px] text-amber-700 dark:text-amber-300"><summary className="cursor-pointer">{zh ? "查看缺失依赖" : "Missing dependencies"} ({w.availability!.problems!.length})</summary><div className="mt-1 space-y-1 break-all">{w.availability!.problems!.map((p, i) => <p key={i}>{p.message}</p>)}</div></details>}
            </article>)}
        </div>
        <WorkflowModelConfigDialog workflow={editing} onClose={() => setEditing(null)} onSaved={() => {
            window.dispatchEvent(new Event("local-gateway-refresh-resources"));
            window.dispatchEvent(new Event("local-gateway-refresh-models"));
        }} />
    </section>;
}
