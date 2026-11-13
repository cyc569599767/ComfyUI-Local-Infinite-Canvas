import { expect, test } from 'bun:test';
import { encodeWav, findSpeechOnset, trimLeadingSilence } from '../src/lib/audio-trim';

const sampleRate = 24000;

/** 造一段音频：前面 silenceMs 毫秒静音，之后是 sine 波当作语音。 */
function buildSamples(silenceMs: number, totalMs: number, amplitude = 0.3) {
    const total = Math.round((totalMs / 1000) * sampleRate);
    const onset = Math.round((silenceMs / 1000) * sampleRate);
    const samples = new Float32Array(total);
    for (let i = onset; i < total; i += 1) {
        samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude;
    }
    return samples;
}

test('findSpeechOnset 定位静音后的语音起点', () => {
    const samples = buildSamples(250, 1000);
    const onset = findSpeechOnset(samples, sampleRate, -50);
    // 允许一个 10ms 窗口的误差
    expect(onset).toBeGreaterThanOrEqual(Math.round(sampleRate * 0.24));
    expect(onset).toBeLessThanOrEqual(Math.round(sampleRate * 0.26));
});

test('findSpeechOnset 对纯静音返回 0（不做裁剪）', () => {
    const silence = new Float32Array(sampleRate);
    expect(findSpeechOnset(silence, sampleRate, -50)).toBe(0);
});

test('findSpeechOnset 对一开头就有声的音频返回 0', () => {
    const samples = buildSamples(0, 500);
    expect(findSpeechOnset(samples, sampleRate, -50)).toBe(0);
});

test('encodeWav 产出合法 WAV 头与正确数据长度', async () => {
    const samples = buildSamples(0, 100);
    const blob = encodeWav([samples], sampleRate);
    expect(blob.type).toBe('audio/wav');
    const view = new DataView(await blob.arrayBuffer());
    const ascii = (offset: number, length: number) =>
        String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // 单声道
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint16(34, true)).toBe(16); // 16 bit
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(blob.size).toBe(44 + samples.length * 2);
});

test('无 AudioContext 环境下裁剪原样返回，不影响克隆流程', async () => {
    // bun 测试环境没有 Web Audio，必须优雅降级而不是抛错。
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/flac' });
    const result = await trimLeadingSilence(blob);
    expect(result.trimmedMs).toBe(0);
    expect(result.blob).toBe(blob);
});
