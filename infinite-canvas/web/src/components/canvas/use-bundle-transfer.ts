import { useCallback, useRef, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { downloadBundle, exportBundle } from "@/services/api/workflow-bundle";
import { installResources } from "@/services/api/resources";
import type { AiConfig } from "@/stores/use-config-store";

/**
 * 自由卡片和应用的共用导入导出逻辑。
 *
 * 抽出来只为一件事：两个标签页的行为必须一致。分别写一份的话，
 * 迟早会出现「卡片导出带依赖、应用导出忘了带」这种不对称。
 */
export function useBundleTransfer({ config, onChanged }: { config: AiConfig; onChanged?: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [exporting, setExporting] = useState(false);
    const [bundle, setBundle] = useState<unknown | null>(null);
    const [bundleName, setBundleName] = useState("");
    const [importOpen, setImportOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const exportNow = useCallback(
        async (input: { cardIds?: string[]; appIds?: string[]; name: string }) => {
            setExporting(true);
            try {
                const data = await exportBundle(config, { cardIds: input.cardIds, appIds: input.appIds, as: input.name });
                downloadBundle(data, input.name);
                message.success(t("canvas.bundle.exported"));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("canvas.bundle.exportFailed"));
            } finally {
                setExporting(false);
            }
        },
        [config, message, t],
    );

    const pickFile = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const readFile = useCallback(
        async (file: File) => {
            try {
                const text = await file.text();
                // 先只解析一次看形状：预检还要走网关再校验一遍，
                // 但本地这一层能立刻挡住「选错文件」，不用等一次往返。
                const parsed = JSON.parse(text) as { kind?: string };
                if (parsed?.kind !== "comfyui-canvas-bundle") {
                    message.error(t("canvas.bundle.notABundle"));
                    return;
                }
                setBundle(parsed);
                setBundleName(file.name.replace(/\.json$/i, ""));
                setImportOpen(true);
            } catch {
                message.error(t("canvas.bundle.notABundle"));
            }
        },
        [message, t],
    );

    const onFileChange = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            // 清掉 value：同一个文件连续选两次也要能触发 change。
            event.target.value = "";
            if (file) void readFile(file);
        },
        [readFile],
    );

    /** 装依赖。失败不抛出——导入本身还是要继续，用户至少拿到编排。 */
    const install = useCallback(
        async (ids: string[]) => {
            if (!ids.length) return;
            try {
                await installResources({ ids });
                message.success(t("canvas.bundle.installStarted", { count: ids.length }));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("canvas.bundle.installFailed"));
            }
        },
        [message, t],
    );

    const closeImport = useCallback(() => {
        setImportOpen(false);
        setBundle(null);
        setBundleName("");
    }, []);

    return {
        exporting,
        exportingAny: exporting,
        exportNow,
        importOpen,
        bundleName,
        bundle,
        pickFile,
        onFileChange,
        fileInputRef,
        install,
        closeImport,
        onImported: () => onChanged?.(),
    };
}
