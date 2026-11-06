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

module.exports = { formatDesktopTimestamp, timestampDesktopLog };
