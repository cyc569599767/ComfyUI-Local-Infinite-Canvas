import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { mimeFromFilename } from "./util.js";

/** 单文件读取上限：视频动辄几十 MB，这里只挡明显的异常巨型文件，避免把内存吃满。 */
const MAX_LOCAL_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * 从本地 ComfyUI 输出目录直接读取已生成的文件。
 *
 * 为什么需要这条回退：ComfyUI 的 /view 偶尔会返回 200 却一个字节都不发
 * （HEAD 正常、Content-Length 正确，GET 直接挂住直到对端 terminated）。
 * 这时文件其实已经完整落在 output 目录里，任务却只能报「取回文件失败」，
 * 画布上就永远等不到结果。本机部署既然知道 comfyDir，就没有理由不去磁盘取。
 *
 * 安全边界：只允许 output 根目录内的常规文件，文件名必须是纯文件名，
 * subfolder 里的 .. 一律拒绝，避免把 ComfyUI 主机上的任意路径读进画布。
 * 读取用异步 API：几十 MB 的视频用 readFileSync 会卡住整个网关事件循环。
 */
export function createLocalOutputReader({ comfyDir } = {}) {
  const root = comfyDir ? path.resolve(comfyDir, "output") : "";
  if (!root) return null;

  /** 只做路径解析与安全校验，不读盘；读盘前调用方还能再检查取消状态。 */
  function resolveSafePath(file) {
    const filename = String(file?.filename || "").trim();
    if (!filename) return null;
    // 文件名必须是纯文件名：绝对路径或带分隔符的写法会绕过下面的根目录检查。
    if (path.isAbsolute(filename) || /[\\/]/.test(filename) || filename.includes("..")) return null;
    const type = String(file?.type || "output");
    // input/temp 不在这里处理：那是用户上传或临时预览，不属于「生成结果」。
    if (type !== "output") return null;
    const subfolder = String(file?.subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const target = path.resolve(root, subfolder, filename);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return target;
  }

  return async function readLocalOutput(file) {
    const target = resolveSafePath(file);
    if (!target) return null;
    try {
      const stat = await fsp.stat(target);
      if (!stat.isFile() || !stat.size || stat.size > MAX_LOCAL_OUTPUT_BYTES) return null;
      const buffer = await fsp.readFile(target);
      if (!buffer.length) return null;
      return { buffer, contentType: mimeFromFilename(path.basename(target)) };
    } catch {
      return null;
    }
  };
}
