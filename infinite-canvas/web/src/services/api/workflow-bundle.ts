import axios from "axios";

import { localGatewayRoot } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";

/**
 * 搬家包：自由卡片和应用的导入导出。
 *
 * 一个包同时含工作流本体、卡片参数、应用编排和依赖清单，
 * 所以换台机器也能还原出可运行的一套，而不只是一份「看起来有但跑不了」的列表。
 */
export type BundleCardDependencyModel = {
    classType: string;
    input: string;
    value: string;
    dirs?: string[];
};

export type BundleCardDependencies = {
    present: Array<BundleCardDependencyModel & { matched?: string; kind?: string }>;
    replaceable: Array<BundleCardDependencyModel & { matched: string; score: number }>;
    missingModels: BundleCardDependencyModel[];
    missingNodes: Array<{ classType: string }>;
    ok: boolean;
};

export type BundlePreviewCard = {
    index: number;
    name: string;
    sourceFormat: "ui" | "api";
    archived: boolean;
    steps: number;
    duplicate: { id: string; name: string } | null;
    dependencies: BundleCardDependencies;
};

export type BundlePreview = {
    exportedAt: string;
    exportedBy: string;
    cards: BundlePreviewCard[];
    apps: Array<{ name: string; description?: string; steps: number; existing: string | null }>;
    problems: Array<{ index: number; name: string; message: string }>;
    install: {
        ids: string[];
        unmatched: Array<{ kind: string; classType?: string; input?: string; value?: string }>;
        totalSize: number;
    };
    summary: {
        cards: number;
        apps: number;
        duplicates: number;
        importable: number;
        missingModels: string[];
        missingNodes: string[];
        runnable: boolean;
    };
};

export type BundleImportResult = {
    cards: Array<{ name: string; status: "imported" | "skipped" | "failed"; id?: string; file?: string; message?: string }>;
    apps: Array<{ name: string; status: "imported" | "skipped" | "failed"; id?: string; steps?: number; message?: string }>;
    problems: Array<{ index: number; name: string; message: string }>;
    summary: { imported: number; skipped: number; failed: number; appsImported: number; appsSkipped: number };
};

function gatewayRoot(config: AiConfig) {
    const root = localGatewayRoot(config.baseUrl);
    if (!root) throw new Error("自由卡片与应用只支持本地网关");
    return root;
}

function readError(error: unknown, fallback: string) {
    if (axios.isAxiosError(error)) {
        const data = error.response?.data as { error?: { message?: string }; message?: string } | undefined;
        return data?.error?.message || data?.message || error.message || fallback;
    }
    return error instanceof Error ? error.message : fallback;
}

/**
 * 导出。
 *
 * 不传 ids 就是全部；传了应用会自动带上它引用的卡片——
 * 只给应用不给卡片的包，导入方永远跑不起来。
 */
export async function exportBundle(
    config: AiConfig,
    input: { cardIds?: string[]; appIds?: string[]; as?: string } = {},
): Promise<unknown> {
    const root = gatewayRoot(config);
    const params = new URLSearchParams();
    if (input.cardIds?.length) params.set("cards", input.cardIds.join(","));
    if (input.appIds?.length) params.set("apps", input.appIds.join(","));
    if (input.as) params.set("as", input.as);
    try {
        const response = await axios.get<{ bundle?: unknown }>(`${root}/api/bundles/export?${params.toString()}`, { timeout: 120000 });
        if (!response.data?.bundle) throw new Error("导出内容为空");
        return response.data.bundle;
    } catch (error) {
        throw new Error(readError(error, "导出失败"));
    }
}

export async function previewBundle(config: AiConfig, bundle: unknown): Promise<BundlePreview> {
    const root = gatewayRoot(config);
    try {
        const response = await axios.post<{ preview?: BundlePreview }>(`${root}/api/bundles/preview`, { bundle }, { timeout: 120000 });
        if (!response.data?.preview) throw new Error("预检结果为空");
        return response.data.preview;
    } catch (error) {
        throw new Error(readError(error, "预检失败"));
    }
}

export async function importBundle(config: AiConfig, bundle: unknown, options: { skipDuplicates?: boolean } = {}): Promise<BundleImportResult> {
    const root = gatewayRoot(config);
    try {
        const response = await axios.post<{ result?: BundleImportResult }>(
            `${root}/api/bundles/import`,
            { bundle, skipDuplicates: options.skipDuplicates !== false },
            { timeout: 300000 },
        );
        if (!response.data?.result) throw new Error("导入结果为空");
        return response.data.result;
    } catch (error) {
        throw new Error(readError(error, "导入失败"));
    }
}

/** 把包存成文件。带 BOM 之外的纯 UTF-8，文件名可读且带日期，便于用户归档。 */
export function downloadBundle(bundle: unknown, name = "画布资源包") {
    const text = JSON.stringify(bundle, null, 2);
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 60) || "画布资源包";
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safe}-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 立刻回收会让部分浏览器下载失败，留一拍。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
