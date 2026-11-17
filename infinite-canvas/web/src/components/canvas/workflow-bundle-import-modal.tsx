import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Checkbox, Modal, Spin, Tag } from "antd";
import { AlertTriangle, Boxes, CheckCircle2, CircleSlash, Download, PackageOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatBytes } from "@/services/api/resources";
import {
    importBundle,
    previewBundle,
    type BundleImportResult,
    type BundlePreview,
    type BundlePreviewCard,
} from "@/services/api/workflow-bundle";
import type { AiConfig } from "@/stores/use-config-store";

type Props = {
    open: boolean;
    onClose: () => void;
    config: AiConfig;
    /** 已解析的包内容；null 表示还没选文件。 */
    bundle: unknown | null;
    /** 包的显示名，用于弹窗标题。 */
    bundleName?: string;
    onImported?: (result: BundleImportResult) => void;
    /** 预检算出可安装的资源 id 时，交给上层去调安装接口并显示进度。 */
    onInstall?: (ids: string[]) => void;
};

/**
 * 导入预检弹窗。
 *
 * 设计取向：先把「会发生什么」摊开，再让用户点导入。
 *
 * 原因是导入不是纯粹的加法——它会往工作流目录写文件、往卡片库加条目、
 * 可能还要装几个 GB 的模型。如果只给一个「导入成功」的提示，
 * 用户既没法判断该不该装，也不知道装完能不能跑。
 *
 * 所以这里明确区分四件事：
 * 1. 重复（已有同样内容）→ 默认跳过，不覆盖用户的版本
 * 2. 缺依赖 → 分成「可一键安装」和「索引里没有」两类，后者不假装能装
 * 3. 格式问题 → 单独列出，不让坏数据混进卡片库
 * 4. 导入结果 → 逐条如实报告，不合并成一句「完成」
 */
export function WorkflowBundleImportModal({ open, onClose, config, bundle, bundleName, onImported, onInstall }: Props) {
    const { t } = useTranslation();
    const [preview, setPreview] = useState<BundlePreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [importing, setImporting] = useState(false);
    const [result, setResult] = useState<BundleImportResult | null>(null);
    const [skipDuplicates, setSkipDuplicates] = useState(true);
    const [installSelected, setInstallSelected] = useState(false);

    useEffect(() => {
        if (!open) return;
        setPreview(null);
        setError("");
        setResult(null);
        setImporting(false);
        setInstallSelected(false);
        if (!bundle) return;
        let cancelled = false;
        setLoading(true);
        previewBundle(config, bundle)
            .then((data) => {
                if (!cancelled) setPreview(data);
            })
            .catch((reason: unknown) => {
                if (!cancelled) setError(reason instanceof Error ? reason.message : t("canvas.bundle.previewFailed"));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [bundle, config, open, t]);

    const installable = useMemo(() => preview?.install.ids || [], [preview]);
    const actionable = preview ? preview.summary.importable > 0 : false;

    const runImport = async () => {
        if (!bundle || !preview) return;
        setImporting(true);
        setError("");
        try {
            // 先装依赖再导入：装了但导入失败，用户至少拿到了资源；
            // 反过来则是一堆指向空模型的卡片，更难受。
            if (installSelected && installable.length) onInstall?.(installable);
            const imported = await importBundle(config, bundle, { skipDuplicates });
            setResult(imported);
            onImported?.(imported);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("canvas.bundle.importFailed"));
        } finally {
            setImporting(false);
        }
    };

    const title = bundleName ? t("canvas.bundle.importTitleWithName", { name: bundleName }) : t("canvas.bundle.importTitle");

    return (
        <Modal open={open} onCancel={onClose} title={title} width={640} footer={null} destroyOnClose>
            {loading ? (
                <div className="grid h-40 place-items-center">
                    <Spin tip={t("canvas.bundle.previewing")} />
                </div>
            ) : error ? (
                <Alert type="error" showIcon message={error} className="mb-3" />
            ) : result ? (
                <ImportResultView result={result} onClose={onClose} />
            ) : preview ? (
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs opacity-70">
                        <Tag>{t("canvas.bundle.cardCount", { count: preview.summary.cards })}</Tag>
                        <Tag>{t("canvas.bundle.appCount", { count: preview.summary.apps })}</Tag>
                        {preview.exportedBy ? <span className="opacity-60">{t("canvas.bundle.exportedBy", { name: preview.exportedBy })}</span> : null}
                        {preview.exportedAt ? <span className="opacity-50">{preview.exportedAt.slice(0, 10)}</span> : null}
                    </div>

                    {preview.problems.length ? (
                        <Alert
                            type="warning"
                            showIcon
                            icon={<AlertTriangle className="size-4" />}
                            message={t("canvas.bundle.problemsTitle", { count: preview.problems.length })}
                            description={
                                <ul className="list-disc space-y-0.5 pl-4 text-xs">
                                    {preview.problems.slice(0, 4).map((item, index) => (
                                        <li key={`${item.index}-${index}`}>
                                            <span className="font-medium">{item.name}</span>：{item.message}
                                        </li>
                                    ))}
                                </ul>
                            }
                        />
                    ) : null}

                    <CardList cards={preview.cards} />

                    {preview.summary.runnable ? (
                        <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-2.5 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="size-4 shrink-0" />
                            {t("canvas.bundle.depsReady")}
                        </div>
                    ) : (
                        <div className="space-y-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-400">
                            <div className="flex items-center gap-2">
                                <AlertTriangle className="size-4 shrink-0" />
                                {t("canvas.bundle.depsMissing", {
                                    models: preview.summary.missingModels.length,
                                    nodes: preview.summary.missingNodes.length,
                                })}
                            </div>
                            {preview.summary.missingModels.length ? (
                                <ul className="list-disc space-y-0.5 pl-6 opacity-90">
                                    {preview.summary.missingModels.slice(0, 6).map((item) => (
                                        <li key={item} className="break-all">{item}</li>
                                    ))}
                                    {preview.summary.missingModels.length > 6 ? <li>…</li> : null}
                                </ul>
                            ) : null}
                            {preview.summary.missingNodes.length ? (
                                <div className="pl-6 opacity-90">
                                    {t("canvas.bundle.missingNodes", { nodes: preview.summary.missingNodes.slice(0, 6).join("、") })}
                                </div>
                            ) : null}
                        </div>
                    )}

                    {installable.length ? (
                        <div className="rounded-md border border-black/10 p-2.5 dark:border-white/10">
                            <Checkbox checked={installSelected} onChange={(event) => setInstallSelected(event.target.checked)}>
                                <span className="text-xs">
                                    {t("canvas.bundle.installAvailable", { count: installable.length, size: formatBytes(preview.install.totalSize) })}
                                </span>
                            </Checkbox>
                            {preview.install.unmatched.length ? (
                                <div className="mt-1 pl-6 text-[11px] text-amber-600 dark:text-amber-400">
                                    {t("canvas.bundle.installUnmatched", { count: preview.install.unmatched.length })}
                                </div>
                            ) : null}
                        </div>
                    ) : preview.summary.missingModels.length || preview.summary.missingNodes.length ? (
                        <div className="text-[11px] opacity-60">{t("canvas.bundle.installNone")}</div>
                    ) : null}

                    <label className="flex items-center gap-2 text-xs opacity-75">
                        <Checkbox checked={skipDuplicates} onChange={(event) => setSkipDuplicates(event.target.checked)} />
                        {t("canvas.bundle.skipDuplicates", { count: preview.summary.duplicates })}
                    </label>

                    <div className="flex items-center justify-end gap-2 pt-1">
                        <Button onClick={onClose}>{t("common.cancel")}</Button>
                        <Button type="primary" loading={importing} disabled={!actionable} onClick={() => void runImport()} icon={<Download className="size-3.5" />}>
                            {actionable ? t("canvas.bundle.importAction", { count: preview.summary.importable }) : t("canvas.bundle.nothingToImport")}
                        </Button>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}

function CardList({ cards }: { cards: BundlePreviewCard[] }) {
    const { t } = useTranslation();
    if (!cards.length) return null;
    return (
        <div className="thin-scrollbar max-h-52 space-y-1 overflow-y-auto rounded-md border border-black/10 p-1.5 dark:border-white/10">
            {cards.map((card) => {
                const missing = card.dependencies.missingModels.length + card.dependencies.missingNodes.length;
                const replaceable = card.dependencies.replaceable.length;
                return (
                    <div key={card.index} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs">
                        {card.duplicate ? (
                            <CircleSlash className="size-3.5 shrink-0 opacity-40" />
                        ) : missing ? (
                            <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
                        ) : replaceable ? (
                            <Boxes className="size-3.5 shrink-0 text-sky-500" />
                        ) : (
                            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{card.name}</span>
                        <span className="shrink-0 opacity-45">{card.sourceFormat.toUpperCase()}</span>
                        {card.archived ? <span className="shrink-0 rounded bg-black/5 px-1 text-[10px] opacity-60 dark:bg-white/10">{t("canvas.bundle.archivedTag")}</span> : null}
                        {card.duplicate ? (
                            <span className="shrink-0 text-[10px] opacity-50">{t("canvas.bundle.duplicateTag")}</span>
                        ) : missing ? (
                            <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">{t("canvas.bundle.missingTag", { count: missing })}</span>
                        ) : replaceable ? (
                            <span className="shrink-0 text-[10px] text-sky-600 dark:text-sky-400">{t("canvas.bundle.replaceableTag", { count: replaceable })}</span>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

function ImportResultView({ result, onClose }: { result: BundleImportResult; onClose: () => void }) {
    const { t } = useTranslation();
    const failed = [...result.cards.filter((item) => item.status === "failed"), ...result.apps.filter((item) => item.status === "failed")];
    // 卡片和应用混在一张表里，得标出类型，否则「跳过」的那一行是卡片还是应用看不出来。
    const rows = [
        ...result.cards.map((item) => ({ ...item, kind: "card" as const })),
        ...result.apps.map((item) => ({ ...item, kind: "app" as const })),
    ];
    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
                <PackageOpen className="size-4" />
                {t("canvas.bundle.importedSummary", {
                    imported: result.summary.imported,
                    skipped: result.summary.skipped,
                    apps: result.summary.appsImported,
                    appsSkipped: result.summary.appsSkipped ?? 0,
                })}
            </div>
            <div className="thin-scrollbar max-h-56 space-y-1 overflow-y-auto rounded-md border border-black/10 p-1.5 dark:border-white/10">
                {rows.map((item, index) => (
                    <div key={`${item.kind}-${item.name}-${index}`} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs">
                        {item.status === "failed" ? (
                            <AlertTriangle className="size-3.5 shrink-0 text-red-500" />
                        ) : item.status === "skipped" ? (
                            <CircleSlash className="size-3.5 shrink-0 opacity-40" />
                        ) : (
                            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{item.name}</span>
                        {item.kind === "app" ? (
                            <span className="shrink-0 rounded bg-black/5 px-1 text-[10px] opacity-50 dark:bg-white/10">{t("canvas.bundle.kindApp")}</span>
                        ) : null}
                        <span className="shrink-0 text-[10px] opacity-50">
                            {item.status === "failed" ? (item.message || t("canvas.bundle.status.failed")) : t(`canvas.bundle.status.${item.status}`)}
                        </span>
                    </div>
                ))}
            </div>
            {failed.length ? <Alert type="warning" showIcon message={t("canvas.bundle.partialFailed", { count: failed.length })} /> : null}
            <div className="flex justify-end">
                <Button type="primary" onClick={onClose}>{t("common.done")}</Button>
            </div>
        </div>
    );
}
