// Final video results must never be confused with pending preview images.
export function isFinalVideoResult(status?: string) {
    return !status || ["completed", "succeeded", "success"].includes(status.toLowerCase());
}

export function isStillImageHeader(bytes: Uint8Array) {
    const ascii = (offset: number, text: string) => [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
    return (bytes[0] === 0x89 && ascii(1, "PNG\r\n\x1a\n")) ||
        (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
        ascii(0, "GIF87a") || ascii(0, "GIF89a") ||
        (ascii(0, "RIFF") && ascii(8, "WEBP"));
}

export function isStillImageUrl(url: string) {
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif)(?:[?#]|$)/i.test(url) || /^data:image\//i.test(url);
}

export async function rejectStillImageBlob(blob: Blob, errorMessage: string) {
    if (/^image\//i.test(blob.type) || isStillImageHeader(new Uint8Array(await blob.slice(0, 16).arrayBuffer()))) {
        throw new Error(errorMessage);
    }
}
