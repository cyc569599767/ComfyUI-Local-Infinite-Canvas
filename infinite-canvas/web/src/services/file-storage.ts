import localforage from "localforage";
import { nanoid } from "nanoid";

import { withLocalProxy } from "@/stores/use-config-store";
import { readMediaMetadata } from "@/lib/media-metadata";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(withLocalProxy(input), { signal: AbortSignal.timeout(120000) })).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([store.setItem(storageKey, blob), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("保存视频或音频超时，请检查本地存储后重试取回结果。")), 30000); })]);
    } finally { clearTimeout(timer); }
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = blob.type.startsWith("video/") ? await readMediaMetadata(url, "video") : blob.type.startsWith("audio/") ? await readMediaMetadata(url, "audio") : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

type CleanupUsedData = unknown | (() => unknown);

function currentCleanupData(usedData: CleanupUsedData) {
    return typeof usedData === "function" ? (usedData as () => unknown)() : usedData;
}

export async function cleanupUnusedMedia(usedData: CleanupUsedData) {
    const usedKeys = collectMediaStorageKeys(currentCleanupData(usedData));
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    // Recheck live references immediately before deletion so late additions survive GC.
    const latestUsedKeys = collectMediaStorageKeys(currentCleanupData(usedData));
    await deleteStoredMedia(unused.filter((key) => !latestUsedKeys.has(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}
