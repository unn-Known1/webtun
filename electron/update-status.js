'use strict';
function updateStatus(result) {
  if (!result) return 'update check unavailable in this build';
  if (result.isUpdateAvailable === true && result.updateInfo?.version) return 'update available: ' + result.updateInfo.version;
  if (result.isUpdateAvailable === false) return 'up to date';
  return 'update status unavailable; try again';
}
module.exports = { updateStatus };
