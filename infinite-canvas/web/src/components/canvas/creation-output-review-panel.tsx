import { useEffect, useState } from "react";
import { App, Button, Empty, Input, Select, Tag } from "antd";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCreationAgentStore } from "@/stores/use-creation-agent-store";
import { acceptCreationRevision, discardCreationRevision, requestCreationRevision } from "@/lib/agent/creation-agent-runtime";
import { CREATION_STAGES, mediaReady } from "@/lib/agent/creation-pipeline";
import { creationPreviewText } from "@/lib/agent/creation-preview";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import type { CanvasNodeData } from "@/types/canvas";

function Preview({ node, label }: { node?: CanvasNodeData; label: string }) {
    const [url, setUrl] = useState("");
    const m = node?.metadata;
    useEffect(() => {
        let canceled = false;
        setUrl("");
        const primary = m?.images?.find(i => i.id === m.primaryImageId) || m?.images?.find(i => i.status === "success");
        const storageKey = m?.storageKey || primary?.storageKey;
        const fallback = m?.content || primary?.content || "";
        void (node?.type === "image" ? resolveImageUrl(storageKey, fallback) : resolveMediaUrl(storageKey, fallback)).then(value => { if (!canceled) setUrl(value); }).catch(() => {});
        return () => { canceled = true; };
    }, [node?.id, node?.type, m?.storageKey, m?.content, m?.images, m?.primaryImageId]);
    return <div className="min-w-0 rounded-lg border border-stone-200 p-2 dark:border-stone-700">
        <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium"><span>{label}</span><Tag>{m?.status === "loading" ? "生成中" : m?.status === "error" ? "失败" : m?.status === "success" ? "已生成" : "待提交"}</Tag></div>
        {url ? node?.type === "image" ? <img src={url} alt={label} className="h-40 w-full rounded object-contain" /> : node?.type === "video" ? <video src={url} controls preload="metadata" className="h-40 w-full rounded" /> : <audio src={url} controls preload="metadata" className="w-full" /> : <div className="flex h-20 items-center justify-center text-xs text-stone-500">暂无可预览结果</div>}
        {m?.errorDetails && <p className="mt-1 break-all text-xs text-red-500">{m.errorDetails}</p>}
    </div>;
}

export function CreationOutputReviewPanel({ nodeId }: { nodeId: string }) {
    const nodes = useAgentStore(s => s.canvasContext?.snapshot.nodes);
    const running = useCreationAgentStore(s => Boolean(s.runs[nodeId]));
    const hydrated = useCreationAgentStore(s => s.hydrated);
    const { message } = App.useApp();
    const theme = useCanvasTheme();
    const [selected, setSelected] = useState("");
    const [feedback, setFeedback] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => { setSelected(""); setFeedback(""); }, [nodeId]);
    const own = (nodes || []).filter(n => n.metadata?.creationOutput?.projectNodeId === nodeId && ["image", "video", "audio"].includes(n.type));
    const canonical = own.filter(n => !n.metadata?.creationOutput?.revisionKind);
    const host = nodes?.find(n => n.id === nodeId);
    const review = host?.metadata?.creationPipeline?.review;
    const source = own.find(n => n.id === review?.sourceNodeId);
    const candidate = own.find(n => n.id === review?.candidateNodeId);
    const target = canonical.find(n => n.id === selected) || canonical[0];
    const previewText = creationPreviewText(target, nodes);
    const history = own.filter(n => ["history", "discarded"].includes(n.metadata?.creationOutput?.revisionKind || ""));
    const mediaLoading = own.some(n => n.metadata?.status === "loading" || n.metadata?.images?.some(i => i.status === "loading"));
    const act = async (operation: () => void | Promise<void>, text: string) => {
        if (busy) return;
        setBusy(true);
        try { await operation(); message.success(text); }
        catch (e) { message.error(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
    };
    return <section data-creation-review className="space-y-2 rounded-xl border p-3" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">素材检查与重生成</h3><Tag>{canonical.length} 个素材</Tag></div>
        <p className="text-[11px] leading-5" style={{color:theme.node.muted}}>不满意时填写修改要求，仅重做选中的素材。原版保留，新版需手动采用；待确认期间不会推进流水线。使用已保存的项目分辨率、工作流及模型配置。</p>
        {!canonical.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="生成图片、视频或音频后，可在这里检查与重做。" /> : review ? <>
            <div className="rounded bg-amber-500/10 p-2 text-xs">等待确认：{source?.title || review.sourceNodeId}<p className="mt-1 whitespace-pre-wrap">修改要求：{review.feedback}</p></div>
            <div className="grid gap-2 sm:grid-cols-2"><Preview node={source} label="原版（尚未替换）" /><Preview node={candidate} label="重生成候选" /></div>
            <div className="flex flex-wrap justify-end gap-2"><Button disabled={busy || running || mediaLoading} onClick={() => void act(() => discardCreationRevision(nodeId), "已取消重做，原版保持不变。")}>取消本次重做</Button><Button type="primary" disabled={busy || running || mediaLoading || !mediaReady(candidate)} onClick={() => void act(() => acceptCreationRevision(nodeId), "已采用新版；受影响下游已标记需重做，检查后继续项目。")}>采用新版</Button></div>
            <p className="text-[11px]" style={{color:theme.node.muted}}>失败或仍不满意：取消本次重做后修改要求再试。已提交媒体需等待返回；采用不会自动继续项目。</p>
        </> : <>
            <Select aria-label="选择重做素材" className="w-full" showSearch optionFilterProp="label" value={target?.id} onChange={setSelected} options={CREATION_STAGES.flatMap(stage => {
                const items = canonical.filter(n => n.metadata?.creationOutput?.stage === stage.id);
                return items.length ? [{label:stage.label,options:items.map(n=>({value:n.id,label:`${n.title}${n.metadata?.creationOutput?.needsRevision ? " · 下游需重做" : n.metadata?.status === "error" ? " · 生成失败" : ""}`}))}] : [];
            })} />
            {target?.metadata?.creationOutput?.needsRevision && <p className="text-xs text-amber-600">{target.metadata.creationOutput.revisionReason}</p>}
            <details>
                <summary className="cursor-pointer text-xs">预览选中素材</summary>
                <div data-creation-selected-preview className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div data-creation-preview-media className="min-w-0"><Preview node={target} label={target?.title || "素材"} /></div>
                    <div data-creation-preview-prompt data-prompt-source={previewText.source} className="min-w-0 rounded-lg border p-2" style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}>
                        <h4 className="mb-2 text-xs font-medium">{previewText.label}</h4>
                        <div role="region" aria-label={previewText.label} tabIndex={0} className="thin-scrollbar max-h-64 select-text space-y-3 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 [overflow-wrap:anywhere]">
                            {previewText.prompt ? <p>{previewText.prompt}</p> : <p style={{ color: theme.node.muted }}>未保存原提示词记录。</p>}
                            {previewText.details.map(detail => <div key={detail.label}><h5 className="mb-1 font-medium">{detail.label}</h5><p>{detail.text}</p></div>)}
                        </div>
                    </div>
                </div>
            </details>
            <Input.TextArea aria-label="素材修改要求" value={feedback} maxLength={4000} autoSize={{minRows:2,maxRows:5}} placeholder="例如：外套改为蓝色，面容与构图不变；或声音更低沉、语速放慢。" onChange={e=>setFeedback(e.target.value)} />
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="max-w-lg text-[11px]" style={{color:theme.node.muted}}>暂停只停止 Agent，不中断已提交媒体。本项目媒体生成中请等待；可先使用下方“停止”。</p><Button aria-label="按要求重新生成" type="primary" loading={busy} disabled={!hydrated || !target || !feedback.trim() || mediaLoading} onClick={() => target && void act(() => requestCreationRevision(nodeId,target.id,feedback), "已提交单素材重生成，请检查候选后采用。")}>{running ? "暂停并重新生成" : "按要求重新生成"}</Button></div>
        </>}
        {history.length ? <details className="pt-1"><summary className="cursor-pointer text-xs">历史及未采用版本（{history.length}）</summary><div className="mt-2 grid gap-2 sm:grid-cols-2">{history.slice(-5).map(n=><Preview key={n.id} node={n} label={n.title} />)}</div><p className="mt-1 text-[11px]" style={{color:theme.node.muted}}>此处显示最近 5 项，全部历史保留在画布，不作为自动生成参考或剪辑来源。</p></details> : null}
    </section>;
}
