export type MediaMetadata = { width?: number; height?: number; durationMs?: number };

// Metadata is optional enrichment, not evidence that generation is still running.
// Some Chromium/codec combinations emit neither loadedmetadata nor error.
export function readMediaMetadata(url: string, kind: "video" | "audio", timeoutMs = 5000): Promise<MediaMetadata> {
    const fallback = kind === "video" ? { width: 1280, height: 720 } : {};
    if (typeof document === "undefined") return Promise.resolve(fallback);
    return new Promise((resolve) => {
        const media = document.createElement(kind);
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const video = media as HTMLVideoElement;
            const meta: MediaMetadata = {
                ...(kind === "video" ? { width: video.videoWidth || 1280, height: video.videoHeight || 720 } : {}),
                ...(Number.isFinite(media.duration) && media.duration >= 0 ? { durationMs: Math.round(media.duration * 1000) } : {}),
            };
            media.onloadedmetadata = null;
            media.onerror = null;
            media.onabort = null;
            try { media.pause(); media.removeAttribute("src"); media.load(); } catch { /* detached codec cleanup is best effort */ }
            resolve(meta);
        };
        const timer = setTimeout(finish, timeoutMs);
        media.preload = "metadata";
        media.onloadedmetadata = finish;
        media.onerror = finish;
        media.onabort = finish;
        try { media.src = url; } catch { finish(); }
    });
}
