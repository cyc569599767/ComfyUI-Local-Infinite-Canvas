'use strict';

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function formatDesktopTimestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function timestampDesktopLog(message, now = new Date()) {
  const text = String(message ?? '');
  if (!text) return `[${formatDesktopTimestamp(now)}]`;
  const stamp = `[${formatDesktopTimestamp(now)}]`;
  return text.split(/\r\n|[\r\n]/).map(line => line ? `${stamp} ${line}` : stamp).join('\n');
}

// ── 服务面板的日志分级 ────────────────────────────────────────────────
//
// 面板的 100 行缓冲很宝贵：网关每次扫描模型/工作流都会打几条 info，文件监听
// 周期打 auto-synced，启动时还有目录识别与节点放置。全塞进去的话，真正有用的
// 报错十几秒就被顶掉了。
//
// 这里按「值不值得给人看」分级，而不是照搬 logger 的原始级别：
//   error    异常报错 —— 一定显示
//   warn     提醒（降级/回退/重试/缺失）—— 一定显示
//   notice   重要信息（启动、端口、就绪、任务产出）—— 显示
//   progress 过程日志（正在加载/生成/上传）—— 显示
//   noise    扫描/心跳/轮询/文件监听等例行噪音 —— 不显示
//
// 核心取舍：**宁可多显示，也不能把真错误过滤掉**。所以噪音模式刻意写窄，
// 且错误/警告判定永远先于噪音判定。

/** 异常关键词。命中即判 error，不参与噪音过滤。 */
const ERROR_PATTERN = /\b(error|failed|failure|fatal|exception|traceback|unhandled|rejection|crash|econnrefused|econnreset|etimedout|enotfound|panic)\b|错误|失败|异常|崩溃|超时|拒绝连接/i;

/** 提醒：能跑但有风险或降级。 */
// 注意不含 skipped：扫描摘要里的 "N UI workflow(s) skipped" 是正常统计，
// 把它当警告会让每次扫描都冒一条黄字。真正的跳过提示用中文「已跳过」单独匹配。
const WARN_PATTERN = /\b(warn|warning|degraded|deprecated|fallback|retry|retrying|unavailable)\b|警告|降级|回退|重试|已跳过|缺失|缺少|未找到|不可用|无法/i;

/**
 * 噪音：例行扫描 / 心跳 / 轮询 / 文件监听。
 * 只匹配确实高频且几乎不含信息价值的行。
 */
const NOISE_PATTERNS = [
  // 扫描结果摘要：每次扫描一条
  /setup scan ready:/i,
  /auto-imported workflows:/i,
  // 扫描过程中的模型名映射（一次扫描可能几十条）
  /模型别名跨节点匹配/,
  /模型相似匹配/,
  /模型别名跨节点存在多个候选/,
  // 文件监听自动同步
  /free workflow auto-synced/i,
  // 每次启动都打、且没有变化信息
  /已自动识别 ComfyUI 工作流目录/,
  /已放置 \d+ 个随包节点/,
  // 高频轮询端点（网关侧也静默，这里兜住历史日志与子进程输出）
  /\/api\/system\/stats/i,
  /\/api\/models\/events/i,
  /\/api\/progress\//i,
  /\/api\/session\/status/i,
];

/** 扫描结果摘要：统计数字里常含 skipped/missing，不该被当成警告。 */
const SCAN_SUMMARY_PATTERN = /setup scan ready:|auto-imported workflows:/i;

/** 重要信息：启动、端口、就绪、任务产出。 */
const NOTICE_PATTERNS = [
  /listening|listen on|127\.0\.0\.1|localhost/i,
  /\bready\b|已就绪|启动完成|已启动|服务已/i,
  /\bqueued\b|\bcompleted\b|\bsaved\b|已生成|已保存|已导出/i,
];

/** 过程日志：进行时描述。 */
const PROGRESS_PATTERN = /\b(starting|loading|running|processing|uploading|downloading|extracting|rendering|generating|applying|scanning)\b|正在|加载|处理中|上传|下载|抽取|渲染|生成中|扫描中/i;

/**
 * 判断一行日志该不该显示、属于哪一级。
 *
 * 判定顺序很关键：error → warn → noise → notice → progress → 默认显示。
 * 把 noise 放在 warn 之后，是为了「带警告的扫描行」仍然显示；
 * 放在 error 之后，是为了扫描中途出错不会被当成例行日志吞掉。
 *
 * @param {string} line 单行日志（可含时间戳前缀）
 * @returns {{ show: boolean, level: 'error'|'warn'|'notice'|'progress'|'noise' }}
 */
function classifyDesktopLog(line) {
  const text = String(line ?? '');
  if (!text.trim()) return { show: false, level: 'noise' };
  if (ERROR_PATTERN.test(text)) return { show: true, level: 'error' };
  // 例行摘要先于 warn 判定：像 "42/58 workflows, 3 skipped" 这种统计里的
  // skipped/missing 是正常数字，不是警告。真错误已被上面的 error 分支拦走。
  if (SCAN_SUMMARY_PATTERN.test(text)) return { show: false, level: 'noise' };
  if (WARN_PATTERN.test(text)) return { show: true, level: 'warn' };
  if (NOISE_PATTERNS.some(pattern => pattern.test(text))) return { show: false, level: 'noise' };
  if (NOTICE_PATTERNS.some(pattern => pattern.test(text))) return { show: true, level: 'notice' };
  if (PROGRESS_PATTERN.test(text)) return { show: true, level: 'progress' };
  // 认不出来的默认显示：宁可多条，也不要静默吞掉未知但可能重要的信息
  return { show: true, level: 'notice' };
}

/**
 * 过滤一串日志行，只保留值得看的。
 *
 * 多行日志按行拆分后逐行判定：一整块里混着噪音和错误时，
 * 既不整体丢弃，也不整体保留。
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function filterDesktopLogs(lines) {
  const out = [];
  for (const raw of lines || []) {
    for (const line of String(raw ?? '').split(/\r\n|[\r\n]/)) {
      if (!line.trim()) continue;
      if (classifyDesktopLog(line).show) out.push(line);
    }
  }
  return out;
}

module.exports = { classifyDesktopLog, filterDesktopLogs, formatDesktopTimestamp, timestampDesktopLog };
