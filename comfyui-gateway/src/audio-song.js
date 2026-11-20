// 上游 v0.25.3 audio-engine.js 的纯函数部分（歌词行数/时长/风格拼装）。
// 本分支只取与 ComfyUI YuE2 写歌相关的校验逻辑，不含需要本地 Python venv 的
// runYue2Song / runSoulXVoice（那是上游另一套离线引擎，本分支不随包提供运行环境）。

export function countLyricLines(lyrics) {
  return String(lyrics || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[^\]]+\]$/.test(line)).length;
}

export function autoSongDuration(lyrics, { maxSeconds = 300, minSeconds = 10, secondsPerLine = 6, fallbackSeconds = 120 } = {}) {
  const lines = countLyricLines(lyrics);
  if (!lines) return fallbackSeconds;
  return Math.max(minSeconds, Math.min(maxSeconds, Math.round(lines * secondsPerLine)));
}

export function buildSongStyle({ tags = "", gender = "", bpm, language = "", keyscale = "", instrumental = false } = {}) {
  const rawStyle = String(tags || "").trim();
  const vocalTag = /(?:^|[^a-z])(vocal|vocals|voice|singer|singing|choir|chorus|rap|rapper)(?:[^a-z]|$)/i;
  const styleText = instrumental
    ? rawStyle.split(/[,，]/).map((tag) => tag.trim()).filter((tag) => tag && !vocalTag.test(tag)).join(", ")
    : rawStyle;
  const parts = [];
  if (instrumental) parts.push("Instrumental, no vocals, no singing, no choir, no spoken words");
  parts.push(styleText);
  if (!instrumental && gender) parts.push(`${gender} vocal`);
  const bpmValue = Number(bpm);
  if (Number.isFinite(bpmValue) && bpmValue > 0) parts.push(`${Math.trunc(bpmValue)} BPM`);
  if (!instrumental) {
    const languageLabel = { zh: "Chinese", en: "English", ja: "Japanese" }[String(language || "").trim().toLowerCase()] || String(language || "").trim();
    if (languageLabel) parts.push(languageLabel);
  }
  if (String(keyscale || "").trim()) parts.push(`key ${String(keyscale).trim()}`);
  if (!instrumental) parts.push("clear diction");
  return parts.filter(Boolean).join(", ");
}

export function lyricsDurationIssue(lyrics, duration) {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const actual = countLyricLines(lyrics);
  const expected = Math.max(4, Math.round(seconds / 6));
  const min = Math.max(3, Math.round(expected * 0.6));
  const max = Math.max(min + 1, Math.round(expected * 1.5));
  if (actual >= min && actual <= max) return null;
  return {
    actual,
    expected,
    min,
    max,
    seconds: Math.round(seconds),
    message: `歌词行数与目标时长不匹配：当前 ${actual} 行，目标 ${Math.round(seconds)} 秒建议约 ${expected} 行（可接受 ${min}–${max} 行，每行 8–14 字）。请先让 AI 优化歌词或调整目标时长。`,
  };
}
