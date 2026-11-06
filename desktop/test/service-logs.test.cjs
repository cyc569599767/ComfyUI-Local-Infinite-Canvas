'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDesktopTimestamp, timestampDesktopLog } = require('../src/renderer/log-utils.cjs');
const { ServiceManager } = require('../src/main/services.cjs');
const { createLogView } = require('../src/renderer/log-view.js');

test('log timestamps use local calendar fields and padded milliseconds', () => {
  const date = new Date(2026, 0, 2, 3, 4, 5, 6);
  assert.equal(formatDesktopTimestamp(date), '2026-01-02 03:04:05.006');
  assert.equal(timestampDesktopLog('first\r\nsecond', date), '[2026-01-02 03:04:05.006] first\n[2026-01-02 03:04:05.006] second');
  assert.equal(timestampDesktopLog('', date), '[2026-01-02 03:04:05.006]');
});
test('timestamps are recorded once, multiline logs are stamped, ANSI stripped, history bounded', () => {
  const manager = new ServiceManager();
  let notifications = 0;
  manager.on('change', () => notifications++);
  manager.log('\u001b[32mline one\u001b[0m\r\nline two');
  const first = manager.snapshot().logs[0];
  assert.match(first, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] line one\n\[.*\] line two$/);
  assert.equal(first.includes('\u001b'), false);
  manager.update({ phase: 'connecting' });
  assert.equal(manager.snapshot().logs[0], first);
  for (let i = 0; i < 110; i++) manager.log(`entry ${i}`);
  const snapshot = manager.snapshot();
  assert.equal(snapshot.logs.length, 100);
  assert.equal(snapshot.logsVersion, 111);
  assert.equal(notifications, 112);
  assert.match(snapshot.logs[0], /entry 10$/);
  assert.match(snapshot.logs.at(-1), /entry 109$/);
  snapshot.logs.pop();
  assert.equal(manager.snapshot().logs.length, 100);
});

function fixture() {
  function element() {
    const handlers = new Map();
    return { textContent: '', scrollTop: 0, scrollHeight: 1000, clientHeight: 200, checked: false, open: true,
      addEventListener(type, cb) { handlers.set(type, cb); },
      removeEventListener(type) { handlers.delete(type); },
      fire(type, event = {}) { handlers.get(type)?.({ preventDefault() {}, ...event }); },
      handlers,
    };
  }
  const el = element(), follow = element(), latest = element(), status = element(), details = element();
  const frames = new Map(); let id = 0;
  const view = createLogView({ element: el, followToggle: follow, latestButton: latest, status, details,
    schedule: cb => { frames.set(++id, cb); return id; }, cancel: id => frames.delete(id) });
  return { el, follow, latest, status, details, view, frames, flush() { const batch = [...frames.values()]; frames.clear(); batch.forEach(cb => cb()); } };
}

test('new logs follow by default and multiple updates coalesce into one layout frame', () => {
  const f = fixture(); assert.equal(f.follow.checked, true);
  f.view.update(['first'], 1); f.view.update(['first','last'], 2);
  assert.equal(f.frames.size, 1); assert.equal(f.el.textContent, 'first\nlast');
  f.flush(); assert.equal(f.el.scrollTop, 1000);
  f.view.update(['first','last'], 2); assert.equal(f.frames.size, 0);
});
test('reading history pauses follow and latest button restores it', () => {
  const f = fixture(); f.view.update(['old'], 1); f.flush();
  f.el.scrollTop = 100; f.el.fire('scroll');
  assert.equal(f.follow.checked, false); assert.match(f.status.textContent, /暂停/);
  f.view.update(['old','new'], 2); f.flush(); assert.equal(f.el.scrollTop, 100);
  f.latest.fire('click'); f.flush(); assert.equal(f.follow.checked, true); assert.equal(f.el.scrollTop, 1000);
});
test('upward wheel/keyboard or selection cancels a pending auto-scroll', () => {
  for (const [type, args] of [['wheel',{deltaY:-10}],['keydown',{key:'Home'}],['keydown',{key:'PageUp'}],['keydown',{key:' ',shiftKey:true}],['pointerdown',{}]]) {
    const f = fixture(); f.view.update(['new'],1); f.el.fire(type,args); f.flush();
    assert.equal(f.follow.checked,false,type); assert.equal(f.el.scrollTop,0,type);
  }
});
test('follow toggle is honored and scrolling back to bottom resumes following', () => {
  const f = fixture(); f.follow.checked=false; f.follow.fire('change');
  f.view.update(['new'],1); f.flush(); assert.equal(f.el.scrollTop,0);
  f.el.scrollTop=800; f.el.fire('scroll'); assert.equal(f.follow.checked,true);
  f.flush(); assert.equal(f.el.scrollTop,1000);
});
test('collapsed and hidden panes defer following until toggled open or refreshed', () => {
  const f = fixture(); f.details.open=false; f.view.update(['first'],1); f.flush(); assert.equal(f.el.scrollTop,0);
  f.details.open=true; f.details.fire('toggle'); f.flush(); assert.equal(f.el.scrollTop,1000);
  f.el.scrollTop=0; f.el.clientHeight=0; f.view.update(['second'],2); f.flush(); assert.equal(f.el.scrollTop,0);
  f.el.clientHeight=200; f.view.refresh(); f.flush(); assert.equal(f.el.scrollTop,1000);
});
test('identical bounded logs with a new version still follow; placeholder is plain text', () => {
  const f = fixture(); f.view.update([],0); f.flush(); assert.match(f.el.textContent,/暂无/);
  f.view.update(['<img onerror=evil()>'],1); f.flush(); assert.equal(f.el.textContent,'<img onerror=evil()>');
  f.view.update(['<img onerror=evil()>'],2); assert.equal(f.frames.size,1);
});
test('layout-induced scroll before the follow frame does not disable following; disposal removes handlers', () => {
  const f = fixture(); f.view.update(['first'],1); f.el.fire('scroll'); assert.equal(f.follow.checked,true);
  f.view.dispose(); f.flush(); assert.equal(f.el.scrollTop,0); assert.equal(f.frames.size,0);
  assert.equal(f.el.handlers.size,0); assert.equal(f.details.handlers.size,0);
});
