// ffmpeg 参数兼容层。
//
// ffmpeg 5.1 起用 `-fps_mode` 取代 `-vsync`，9.x（本机 9.0.2）已把 `-vsync` 整个删掉：
//
//   $ ffmpeg -y -i in.mp4 -vf "select=..." -vsync 0 out-%03d.png
//   Unrecognized option 'vsync'.
//   Error splitting the argument list: Option not found
//
// 而这个 fork 要支持随包分发的旧版 ffmpeg（<5.1 不认 `-fps_mode`），
// 所以不能简单替换，要按版本选参数。
//
// 本文件只放纯函数，便于单测；版本探测由调用方注入。

/** 从 `ffmpeg -version` 的首行取主次版本号；取不到返回 null。 */
export function parseFfmpegVersion(versionOutput) {
    const text = String(versionOutput || "");
    // 形如 "ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright ..."
    // 也兼容 "ffmpeg version n6.1.1" / "ffmpeg version 4.4.2-0ubuntu"
    const match = text.match(/ffmpeg\s+version\s+n?(\d+)\.(\d+)/i);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * 选「不做帧率同步」的参数。
 *
 * 抽指定帧号时，默认帧率同步会重复/丢帧，必须关掉。
 * - ffmpeg >= 5.1：`-fps_mode passthrough`
 * - 更早：`-vsync 0`
 * - 版本未知：优先新参数（现代发行版居多），失败由调用方兜底重试。
 */
export function passthroughFrameArgs(version) {
    if (version && (version.major < 5 || (version.major === 5 && version.minor < 1))) {
        return ["-vsync", "0"];
    }
    return ["-fps_mode", "passthrough"];
}

/** 判断一次失败是否因为参数不被识别 —— 用于自动换另一套参数重试。 */
export function isUnrecognizedOptionError(stderr, option = "vsync") {
    const text = String(stderr || "");
    // 必须同时看到「Unrecognized option '<该参数>'」这个结构，
    // 不能只凭出现 Option not found（可能是别的原因导致参数列表解析失败）。
    return new RegExp(`Unrecognized option '${option}'`, "i").test(text);
}

/**
 * 抽指定帧号的完整参数。
 *
 * 抽帧号时不能开默认帧率同步（会把 select 出来的帧再重复/丢弃），
 * 而关它的参数名在 ffmpeg 5.1 变了、9.x 删了旧名，所以按版本选。
 *
 * @param {string} input 输入文件
 * @param {string} filter -vf 表达式
 * @param {string} output 输出模板（如 cand-%03d.png）
 * @param {{major:number,minor:number}|null} version ffmpeg 版本
 */
export function frameExtractArgs(input, filter, output, version) {
    return ["-y", "-i", input, "-vf", filter, ...passthroughFrameArgs(version), output];
}
