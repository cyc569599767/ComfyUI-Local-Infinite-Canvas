/**
 * 裁掉音频开头的静音/低电平前导。
 *
 * 为什么需要：音色克隆会把参考音频开头的前导静音一起复刻，
 * 表现为生成音频在正式台词前多出「嗯」这类气口（实测 5/6 触发，
 * 裁掉参考前导后降到 0/6）。
 *
 * 用 Web Audio 解码，因此 FLAC / MP3 / WAV / OGG 都能处理；
 * 输出统一重编码为 16-bit PCM WAV，避免再挑容器。
 */

export type TrimOptions = {
    /** 低于此电平视为静音，单位 dBFS。 */
    thresholdDb?: number;
    /** 起点前额外保留的毫秒数，避免削掉字头爆破音。 */
    padMs?: number;
    /** 未裁剪时的最小收益：小于该毫秒数就原样返回，避免无谓重编码。 */
    minTrimMs?: number;
};

export type TrimResult = {
    blob: Blob;
    /** 实际裁掉的毫秒数；0 表示未裁剪。 */
    trimmedMs: number;
};

const DEFAULTS: Required<TrimOptions> = {
    thresholdDb: -50,
    padMs: 30,
    minTrimMs: 20,
};

function audioContextCtor(): typeof AudioContext | null {
    if (typeof window === "undefined") return null;
    const ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return ctor || null;
}

/** 找到第一个超过阈值的采样点下标；整段都静音则返回 0（不裁剪）。 */
export function findSpeechOnset(samples: Float32Array, sampleRate: number, thresholdDb: number): number {
    const threshold = Math.pow(10, thresholdDb / 20);
    // 用 10ms 窗口的平均能量判断，避免单个毛刺被当成语音起点。
    const windowSize = Math.max(1, Math.round(sampleRate * 0.01));
    for (let offset = 0; offset + windowSize <= samples.length; offset += windowSize) {
        let sum = 0;
        for (let i = offset; i < offset + windowSize; i += 1) sum += samples[i] * samples[i];
        if (Math.sqrt(sum / windowSize) >= threshold) return offset;
    }
    return 0;
}

/** Float32 单/多声道 → 16-bit PCM WAV。 */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
    const channelCount = Math.max(1, channels.length);
    const frameCount = channels[0]?.length ?? 0;
    const bytesPerSample = 2;
    const blockAlign = channelCount * bytesPerSample;
    const dataSize = frameCount * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeAscii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channelCount, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 8 * bytesPerSample, true);
    writeAscii(36, "data");
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let frame = 0; frame < frameCount; frame += 1) {
        for (let channel = 0; channel < channelCount; channel += 1) {
            const raw = channels[channel]?.[frame] ?? 0;
            const clamped = Math.max(-1, Math.min(1, raw));
            view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
            offset += bytesPerSample;
        }
    }
    return new Blob([buffer], { type: "audio/wav" });
}

/**
 * 裁掉开头静音。解析失败（例如浏览器不支持该编码）时原样返回，
 * 绝不因此让克隆失败——裁剪只是提升质量，不是必需步骤。
 */
export async function trimLeadingSilence(blob: Blob, options: TrimOptions = {}): Promise<TrimResult> {
    const { thresholdDb, padMs, minTrimMs } = { ...DEFAULTS, ...options };
    const Ctor = audioContextCtor();
    if (!Ctor) return { blob, trimmedMs: 0 };

    let context: AudioContext | null = null;
    try {
        context = new Ctor();
        const decoded = await context.decodeAudioData(await blob.arrayBuffer());
        const channels: Float32Array[] = [];
        for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
            channels.push(decoded.getChannelData(channel));
        }
        const onset = findSpeechOnset(channels[0], decoded.sampleRate, thresholdDb);
        const padSamples = Math.round((padMs / 1000) * decoded.sampleRate);
        const cutSamples = Math.max(0, onset - padSamples);
        const trimmedMs = Math.round((cutSamples / decoded.sampleRate) * 1000);
        if (trimmedMs < minTrimMs) return { blob, trimmedMs: 0 };

        const kept = channels.map((channel) => channel.subarray(cutSamples));
        return { blob: encodeWav(kept, decoded.sampleRate), trimmedMs };
    } catch {
        return { blob, trimmedMs: 0 };
    } finally {
        // 关掉临时 AudioContext，避免浏览器限制同时存在的实例数。
        try {
            await context?.close();
        } catch {
            /* 关闭失败不影响结果 */
        }
    }
}
