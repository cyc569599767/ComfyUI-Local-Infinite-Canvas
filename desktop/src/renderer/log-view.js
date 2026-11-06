'use strict';

// Browser controller with an injectable frame scheduler for deterministic tests.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DesktopLogView = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  function createLogView({ element, followToggle, latestButton, status, details,
    schedule = callback => requestAnimationFrame(callback), cancel = handle => cancelAnimationFrame(handle) }) {
    let following = true;
    let frame = null;
    let lastText = null;
    let lastVersion;
    let disposed = false;
    const listeners = [];
    function listen(target, name, callback) {
      target.addEventListener(name, callback);
      listeners.push(() => target.removeEventListener(name, callback));
    }
    const atBottom = () => element.scrollHeight - element.clientHeight - element.scrollTop <= 4;
    function showFollowing() {
      followToggle.checked = following;
      status.textContent = following ? '自动跟随最新日志' : '已暂停跟随，可查看历史';
    }
    function scrollLatest() {
      if (frame !== null || disposed || !following) return;
      frame = schedule(() => {
        frame = null;
        if (disposed || !following || !details.open || element.clientHeight === 0) return;
        // Never call scrollIntoView: only the log pane should move, not the page.
        element.scrollTop = element.scrollHeight;
      });
    }
    function setFollowing(value) {
      following = Boolean(value);
      if (!following && frame !== null) { cancel(frame); frame = null; }
      showFollowing();
      if (following) scrollLatest();
    }
    listen(followToggle, 'change', () => setFollowing(followToggle.checked));
    listen(latestButton, 'click', event => {
      event.preventDefault();
      details.open = true;
      setFollowing(true);
    });
    listen(element, 'scroll', () => {
      // A text update can cause a layout scroll before its queued follow frame.
      if (following && frame !== null) return;
      setFollowing(atBottom());
    });
    listen(element, 'wheel', event => { if (event.deltaY < 0) setFollowing(false); });
    listen(element, 'keydown', event => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) setFollowing(false);
    });
    // Selecting text or grabbing the scrollbar intentionally pauses following.
    listen(element, 'pointerdown', () => setFollowing(false));
    listen(details, 'toggle', () => { if (details.open) scrollLatest(); });
    showFollowing();
    return {
      update(lines, version) {
        const text = lines.length ? lines.join('\n') : '暂无启动日志；已就绪服务直接复用。';
        if (text === lastText && version === lastVersion) return;
        const oldTop = element.scrollTop;
        if (text !== lastText) element.textContent = text;
        lastText = text;
        lastVersion = version;
        if (following) scrollLatest();
        else element.scrollTop = Math.min(oldTop, Math.max(0, element.scrollHeight - element.clientHeight));
      },
      refresh: scrollLatest,
      dispose() {
        disposed = true;
        if (frame !== null) cancel(frame);
        frame = null;
        listeners.forEach(remove => remove());
      },
    };
  }
  return { createLogView };
});
