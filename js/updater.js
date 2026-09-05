'use strict';

/**
 * updater.js — in-app update checker and installer
 *
 * Flow:
 *   1. check()   → GET /api/version from the proxy → compare semver
 *   2. install() → curl download ZIP → unzip → rsync/robocopy over extension dir
 *
 * The update ZIP contains only code files (no ffmpeg-bin / node_modules),
 * so downloads are small (~2 MB). Existing ffmpeg-bin is left in place.
 * Users close and reopen the panel (no full Adobe restart needed).
 */

var Updater = (function() {

  var CURRENT_VERSION = '1.3.1';

  function _cfg() {
    return typeof YASHKIT_CONFIG !== 'undefined' ? YASHKIT_CONFIG
         : { PROXY_BASE_URL: 'http://localhost:8787' };
  }

  function _endpoint() {
    return (_cfg().PROXY_BASE_URL || '').replace(/\/+$/, '') + '/api/version';
  }

  // Returns true if semver string a is strictly greater than b.
  function _gt(a, b) {
    var av = String(a || '0').split('.').map(Number);
    var bv = String(b || '0').split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      var x = av[i] || 0, y = bv[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }

  /**
   * Updates are permanently disabled.
   */
  function check(onResult) {
    if (typeof onResult === 'function') onResult(null);
  }

  /**
   * Download and apply an update ZIP.
   * @param {string}   downloadUrl
   * @param {function} onProgress  (pct: 0-100, label: string)
   * @param {function} onDone
   * @param {function} onError     (msg: string)
   */
  function install(downloadUrl, onProgress, onDone, onError) {
    if (typeof onError === 'function') onError('Updates are disabled.');
  }

  return { check: check, install: install, currentVersion: CURRENT_VERSION };
})();
