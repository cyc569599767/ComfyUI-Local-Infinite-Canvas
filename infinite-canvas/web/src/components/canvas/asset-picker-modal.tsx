import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Empty, Input, Modal, Pagination, Tag } from "antd";
import { Music2, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatBytes, formatDuration } from "@/lib/image-utils";
import { cn } from "@/lib/utils";
import { getImagePreviewRevision, subscribeImagePreviews } from "@/services/image-storage";
import { assetCoverUrl, useAssetStore, type Asset } from "@/stores/use-asset-store";

export type InsertAssetPayload = { kind: "text"; content: string; title: string } | { kind: "image"; dataUrl: string; title: string; storageKey?: string } | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number } | { kind: "audio"; url: string; title: string; storageKey?: string };

type Props = {
    open: boolean;
    defaultTab?: string;
    onInsert: (payload: InsertAssetPayload) => void;
    onClose: () => void;
    /** 调用方只接受部分类型时传进来，避免出现「选了却插不进去」的资产。 */
    kinds?: readonly Asset["kind"][];
};

export function AssetPickerModal({ open, onInsert, onClose, kinds }: Props) {
    const { t } = useTranslation();
    return (
        <Modal title={t("canvas.assetPicker.title")} open={open} onCancel={onClose} footer={null} width={860} destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: 480 } }}>
            <MyAssetsTab onInsert={onInsert} kinds={kinds} />
        </Modal>
    );
}

const PAGE_SIZE = 8;

const allKindOptions = ["all", "text", "image", "video", "audio"] as const;

function PickerCard({ title, kind, cover, meta, onClick }: { title: string; kind: string; cover: string; meta?: string; onClick: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            className="group relative cursor-pointer overflow-hidden rounded-lg border border-stone-200 bg-white text-left transition hover:border-stone-400 hover:shadow-md dark:border-stone-700 dark:bg-stone-900 dark:hover:border-stone-500"
            onClick={onClick}
        >
            {cover ? (
                <img src={cover} alt={title} className="aspect-[4/3] w-full object-cover" />
            ) : kind === "audio" ? (
                <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 bg-gradient-to-br from-stone-100 to-stone-200 dark:from-stone-800 dark:to-stone-900">
                    <Music2 className="size-6 text-stone-400" />
                    <span className="text-[11px] text-stone-500 dark:text-stone-400">{meta || t(`assets.kinds.${kind}`)}</span>
                </div>
            ) : (
                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs leading-5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">{title}</div>
            )}
            <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-xs font-medium text-stone-800 dark:text-stone-200">{title}</span>
                    <Tag className="m-0 shrink-0 text-[10px]">{t(`assets.kinds.${kind}`)}</Tag>
                </div>
            </div>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-stone-950/0 text-sm font-medium text-white opacity-0 transition group-hover:bg-stone-950/55 group-hover:opacity-100">{t("canvas.assetPicker.insert")}</div>
        </button>
    );
}

function MyAssetsTab({ onInsert, kinds }: { onInsert: (payload: InsertAssetPayload) => void; kinds?: readonly Asset["kind"][] }) {
    const { t } = useTranslation();
    const kindOptions = kinds ? allKindOptions.filter((option) => option === "all" || kinds.includes(option as Asset["kind"])) : allKindOptions;
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const assets = useAssetStore((state) => state.assets);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("all");
    const [page, setPage] = useState(1);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => (kinds ? kinds.includes(a.kind) : a.kind === "text" || a.kind === "image" || a.kind === "video" || a.kind === "audio"))
            .filter((a) => kindFilter === "all" || a.kind === kindFilter)
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter, kinds]);

    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length]);

    const handleInsert = (asset: Asset) => {
        if (asset.kind === "text") {
            onInsert({ kind: "text", content: asset.data.content, title: asset.title });
        } else if (asset.kind === "audio") {
            onInsert({ kind: "audio", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title });
        } else if (asset.kind === "video") {
            onInsert({ kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height });
        } else {
            onInsert({ kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title });
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder={t("canvas.assetPicker.search")}
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex gap-1.5">
                    {kindOptions.map((option) => (
                        <Tag.CheckableTag
                            key={option}
                            checked={kindFilter === option}
                            className={cn("prompt-filter-tag", kindFilter === option && "is-active")}
                            onChange={() => {
                                setPage(1);
                                setKindFilter(option);
                            }}
                        >
                            {option === "all" ? t("common.all") : t(`assets.kinds.${option}`)}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>

            {visible.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {visible.map((asset) => (
                        <PickerCard
                            key={asset.id}
                            title={asset.title}
                            kind={asset.kind}
                            cover={assetCoverUrl(asset)}
                            meta={asset.kind === "audio" ? [asset.data.durationMs ? formatDuration(asset.data.durationMs) : "", formatBytes(asset.data.bytes)].filter(Boolean).join(" · ") : undefined}
                            onClick={() => handleInsert(asset)}
                        />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.assetPicker.empty")} className="py-12" />
            )}

            {filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
        </div>
    );
}
