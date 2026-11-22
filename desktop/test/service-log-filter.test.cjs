'use strict';
// 服务面板日志分级：扫描/心跳/轮询之类的例行噪音不显示，
// 只留异常报错、提醒、重要信息和过程日志。
//
// 这个测试的核心任务是守住一条底线：**过滤不能把真错误吞掉**。
// 所以除了「噪音被挡」，还必须验证「疑似噪音但带错误的行仍然显示」。
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyDesktopLog, filterDesktopLogs } = require('../src/renderer/log-utils.cjs');

const shows = (line) => classifyDesktopLog(line).show;
const level = (line) => classifyDesktopLog(line).level;

test('扫描类例行日志被过滤', () => {
  const noise = [
    '[2026-11-22 10:00:00.000] setup scan ready: 42/58 workflows, 3 UI workflow(s) skipped, 1832ms',
    '[2026-11-22 10:00:00.000] auto-imported workflows: gateway=2, comfy=0, removed drafts=1',
    '[2026-11-22 10:00:00.000] 模型别名跨节点匹配：CLIPLoader.clip_name foo → bar',
    '[2026-11-22 10:00:00.000] 模型相似匹配：qwen3vl → qwen3vl_32b（92%）',
    '[2026-11-22 10:00:00.000] free workflow auto-synced 我的工作流',
    '[2026-11-22 10:00:00.000] 已自动识别 ComfyUI 工作流目录：D:/ComfyUI/workflows',
    '[2026-11-22 10:00:00.000] 已放置 3 个随包节点，重启 ComfyUI 后生效',
  ];
  for (const line of noise) {
    assert.equal(shows(line), false, `应被过滤：${line}`);
    assert.equal(level(line), 'noise');
  }
});

test('心跳与轮询端点日志被过滤', () => {
  const noise = [
    'GET /api/system/stats 200 3ms req-1',
    'GET /api/models/events 200 120ms req-2',
    'GET /api/progress/abc 200 1ms req-3',
    'GET /api/session/status 200 2ms req-4',
  ];
  for (const line of noise) assert.equal(shows(line), false, `应被过滤：${line}`);
});

test('异常报错一定显示，且不会被噪音规则吞掉', () => {
  const errors = [
    '服务启动失败：端口 8190 被占用',
    'ComfyUI 连接错误：ECONNREFUSED 127.0.0.1:8188',
    'Unhandled rejection in gateway',
    'native crash detected',
    '网关请求超时',
    'Traceback (most recent call last):',
  ];
  for (const line of errors) {
    assert.equal(shows(line), true, `必须显示：${line}`);
    assert.equal(level(line), 'error', `应判为 error：${line}`);
  }
});

test('扫描日志里夹带的错误仍然显示（噪音规则不能误杀）', () => {
  // 这两行既像扫描日志又带错误特征，必须留下来
  const mustShow = [
    'setup scan failed: EACCES permission denied',
    'free workflow auto-synced 失败：文件被占用',
    '已自动识别 ComfyUI 工作流目录 失败',
  ];
  for (const line of mustShow) {
    assert.equal(shows(line), true, `不能因为像扫描日志就吞掉：${line}`);
    assert.equal(level(line), 'error');
  }
});

test('警告与降级提示显示', () => {
  const warns = [
    'setup scan degraded: 模型目录不可读',
    '模型别名跨节点存在多个候选，已跳过：CLIPLoader.clip_name',
    'port 8190 unavailable, fallback to 8191',
    'retry attempt 2/3',
    '缺少模型 oldx-qwen2.1人物替换.safetensors',
  ];
  for (const line of warns) {
    assert.equal(shows(line), true, `必须显示：${line}`);
    assert.equal(level(line), 'warn', `应判为 warn：${line}`);
  }
});

test('重要信息显示：启动、端口、就绪、任务产出', () => {
  const notices = [
    '本地网关已就绪 http://127.0.0.1:8190',
    'listening on 8190',
    '画布服务已启动',
    'video task queued abc-123',
    '已生成 3 张图片',
  ];
  for (const line of notices) {
    assert.equal(shows(line), true, `必须显示：${line}`);
    assert.equal(level(line), 'notice', `应判为 notice：${line}`);
  }
});

test('过程日志显示', () => {
  const progress = [
    '正在加载模型 qwen_image_2.1_bf16',
    'loading model weights...',
    'processing request req-9',
    '上传参考图 2/4',
  ];
  for (const line of progress) {
    assert.equal(shows(line), true, `必须显示：${line}`);
    assert.equal(level(line), 'progress', `应判为 progress：${line}`);
  }
});

test('认不出的日志默认显示，不静默吞掉', () => {
  assert.equal(shows('some unknown but possibly important line'), true);
  assert.equal(level('some unknown but possibly important line'), 'notice');
});

test('空行与纯空白不显示', () => {
  assert.equal(shows(''), false);
  assert.equal(shows('   '), false);
  assert.equal(shows('\n'), false);
});

test('filterDesktopLogs 混流时逐行处理，噪音去掉、错误保留', () => {
  const input = [
    '[10:00:00] setup scan ready: 42/58 workflows',
    '正在加载模型',
    '[10:00:01] 服务启动失败：端口被占用',
    'free workflow auto-synced w1',
    '[10:00:02] 已就绪 http://127.0.0.1:8190',
    '',
    '   ',
  ];
  const out = filterDesktopLogs(input);
  assert.deepEqual(out, [
    '正在加载模型',
    '[10:00:01] 服务启动失败：端口被占用',
    '[10:00:02] 已就绪 http://127.0.0.1:8190',
  ]);
});

test('filterDesktopLogs 处理一次写入含多行的日志块', () => {
  // 子进程一次 chunk 可能含多行，其中夹杂噪音与错误
  const block = 'setup scan ready: 1/2 workflows\n正在加载模型\nERROR: CUDA out of memory';
  const out = filterDesktopLogs([block]);
  assert.deepEqual(out, ['正在加载模型', 'ERROR: CUDA out of memory']);
  assert.equal(level(out[1]), 'error');
});

test('filterDesktopLogs 对空输入安全', () => {
  assert.deepEqual(filterDesktopLogs([]), []);
  assert.deepEqual(filterDesktopLogs(null), []);
  assert.deepEqual(filterDesktopLogs(undefined), []);
});

test('ComfyUI 资产库扫描日志（[comfy] 前缀）全部过滤', () => {
  // 现场：这组日志每轮扫描成组出现，字段全是计数与耗时，
  // 正常时 created=0 / skipped≈全部，没有任何可操作信息。
  const noise = [
    '[comfy] [INFO] Fast scan complete: 0.130s total (created=0, skipped=951, total_paths=966)',
    "[comfy] [INFO] Scan(('models', 'input', 'output'), full) done 0.322s: created=0 enriched=0 skipped=951",
    '[comfy] [INFO] [assets-event] seeder.scan_completed cpu_ms=297 created=0 dirs_listed_count=45 elapsed_ms=322 enrich_failed=0 enriched=0 files_statted_count=950',
    "[comfy] [INFO] Seeder start (roots=('models', 'input', 'output'), phase=full)",
    '[comfy] [INFO] [assets-event] seeder.scan_started phase=full',
    '[comfy] [INFO] Asset scan [models] directory: D:////software////ComfyUI_windows_portable////ComfyUI////models',
    "[comfy] [INFO] Asset scan [input] directories: ['D:////////software////////ComfyUI////////input']",
    "[comfy] [INFO] Asset scan [output] directories: ['D:////////software////////ComfyUI////////output']",
  ];
  for (const line of noise) {
    assert.equal(shows(line), false, `应被过滤：${line}`);
    assert.equal(level(line), 'noise');
  }
});

test('ComfyUI 扫描相关的真实错误不会被误杀', () => {
  // 这些行同样带扫描字样，但含错误/警告特征，必须留下
  const mustShow = [
    '[comfy] [INFO] Seeder scan failed: permission denied',
    '[comfy] [ERROR] Asset scan [models] directory: not found',
    '[comfy] [INFO] Scan models done 0.3s: skipped=0 error=2',
    '[comfy] [ERROR] Prompt outputs failed validation',
    '[comfy] [WARN] CUDA out of memory',
  ];
  for (const line of mustShow) assert.equal(shows(line), true, `不能误杀：${line}`);
});

test('ComfyUI 启动与运行的重要信息仍然显示', () => {
  const kept = [
    '[comfy] Starting server',
    '[comfy] To see the GUI go to: http://127.0.0.1:8188',
    '[comfy] Import times for custom nodes:',
    '[comfy] [INFO] Total VRAM 24564 MB, total RAM 65536 MB',
  ];
  for (const line of kept) assert.equal(shows(line), true, `必须保留：${line}`);
});
