'use strict';

// Runs only from runSmokeTest against its isolated renderer and in-memory logs.
async function verifyServiceLogView(contents, manager) {
  const saved = { logs: manager.snapshot().logs, logsVersion: manager.state.logsVersion };
  const run = code => contents.executeJavaScript(`(async () => {
    const pane = document.getElementById('logs');
    const follow = document.getElementById('logs-follow');
    const details = document.getElementById('logs-panel');
    const wait = async (predicate, label) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) { if (Date.now() > deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 25)); }
    };
    const bottom = () => Math.abs(pane.scrollHeight - pane.clientHeight - pane.scrollTop) < 5;
    ${code}
  })()`);
  contents.setBackgroundThrottling(false);
  try {
    for (let i = 0; i < 100; i++) manager.log(`Log smoke ${i}: local timestamp / scroll fixture`);
    await run(`await wait(() => pane.textContent.includes('Log smoke 99') && bottom(), 'Logs did not follow initial batch');
      if (!follow.checked || pane.scrollHeight <= pane.clientHeight) throw new Error('Log pane not scrollable or following');
      const lines = pane.textContent.split('\\n');
      if (!lines.every(line => /^\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3}\\]/.test(line))) throw new Error('Missing timestamp on service logs');
      pane.dispatchEvent(new WheelEvent('wheel', {deltaY:-100})); pane.scrollTop = 0; pane.dispatchEvent(new Event('scroll'));
      await wait(() => !follow.checked, 'Manual history scrolling did not pause');`);
    manager.log('Paused update marker');
    await run(`await wait(() => pane.textContent.includes('Paused update marker'), 'Paused log not rendered');
      if (pane.scrollTop !== 0 || follow.checked) throw new Error('Paused logs jumped to bottom');
      const pageY = window.scrollY;
      document.getElementById('logs-latest').click();
      await wait(() => follow.checked && bottom(), 'Latest button did not resume follow');
      if (window.scrollY !== pageY) throw new Error('Following log pane scrolled whole page');
      details.open = false;`);
    manager.log('Collapsed update marker');
    await run(`await wait(() => pane.textContent.includes('Collapsed update marker'), 'Collapsed log not recorded');
      details.open = true;
      await wait(bottom, 'Reopened logs did not follow');`);
    manager.log('Final live log marker');
    await run(`await wait(() => pane.textContent.includes('Final live log marker') && bottom(), 'New log did not follow');
      follow.checked = false; follow.dispatchEvent(new Event('change')); pane.scrollTop = 0;`);
    manager.update({ ...saved });
    return { timestamps: true, autoFollow: true, manualPause: true, resumeLatest: true, reopenFollow: true, pageScrollUnchanged: true };
  } finally {
    manager.update(saved);
    await run(`details.open = true; document.getElementById('logs-latest').click();`);
  }
}
module.exports = { verifyServiceLogView };
