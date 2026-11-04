'use strict';

function getRuntimeInfo(app, versions = process.versions, platform = process.platform) {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: versions.electron,
    node: versions.node,
    chrome: versions.chrome,
    platform,
  };
}

// Only the main frame of our local window can invoke privileged handlers.
function isTrustedSender(event, window, rendererUrl) {
  if (!window || window.isDestroyed()) return false;
  return event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame?.url === rendererUrl;
}

module.exports = { getRuntimeInfo, isTrustedSender };
