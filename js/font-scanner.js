/**
 * font-scanner.js — enumerate the fonts installed on this machine.
 *
 * CEP panels run on Node, so we read the OS font folders directly and parse
 * each font file's OpenType `name` table for its Family / Style / PostScript
 * name. This works on every After Effects version (unlike app.fonts, which is
 * 2022+), and the PostScript name is what we hand to AE to set the layer font.
 *
 * Exposes a global: FontScanner.list() → [{ ps, fam, st }, ...] (sorted, deduped).
 */
var FontScanner = (function () {
  'use strict';

  function _utf16be(buf, start, len) {
    var s = '';
    for (var i = 0; i + 1 < len; i += 2) s += String.fromCharCode((buf[start + i] << 8) | buf[start + i + 1]);
    return s;
  }

  // Parse one sfnt font living at `base` inside buf → {ps, fam, st} | null
  function _parseFont(buf, base) {
    try {
      var numTables = buf.readUInt16BE(base + 4);
      var nameOff = 0;
      for (var t = 0; t < numTables; t++) {
        var rec = base + 12 + t * 16;
        if (buf.toString('latin1', rec, rec + 4) === 'name') { nameOff = buf.readUInt32BE(rec + 8); break; }
      }
      if (!nameOff) return null;

      var count = buf.readUInt16BE(nameOff + 2);
      var storage = nameOff + buf.readUInt16BE(nameOff + 4);
      var famMac = '', famWin = '', subMac = '', subWin = '', ps = '';

      for (var i = 0; i < count; i++) {
        var r = nameOff + 6 + i * 12;
        var platformID = buf.readUInt16BE(r);
        var nameID = buf.readUInt16BE(r + 6);
        var len = buf.readUInt16BE(r + 8);
        var off = buf.readUInt16BE(r + 10);
        var start = storage + off;
        if (start + len > buf.length) continue;
        var str = (platformID === 1) ? buf.toString('latin1', start, start + len) : _utf16be(buf, start, len);
        if (nameID === 1) { if (platformID === 3) famWin = str; else if (!famMac) famMac = str; }
        else if (nameID === 2) { if (platformID === 3) subWin = str; else if (!subMac) subMac = str; }
        else if (nameID === 6 && !ps) ps = str;
      }

      var fam = famWin || famMac;
      var sub = subWin || subMac;
      if (!ps && fam) ps = (fam + (sub && sub !== 'Regular' ? '-' + sub : '')).replace(/\s+/g, '');
      if (!ps && !fam) return null;
      return { ps: ps, fam: fam || ps, st: sub || '' };
    } catch (e) { return null; }
  }

  // Read a font file (handles .ttc/.otc collections) → array of fonts
  function _parseFile(fs, file) {
    var out = [];
    var buf;
    try { buf = fs.readFileSync(file); } catch (e) { return out; }
    if (!buf || buf.length < 12) return out;
    try {
      if (buf.toString('latin1', 0, 4) === 'ttcf') {     // collection
        var n = buf.readUInt32BE(8);
        for (var i = 0; i < n; i++) {
          var f = _parseFont(buf, buf.readUInt32BE(12 + i * 4));
          if (f) out.push(f);
        }
      } else {                                            // single font
        var one = _parseFont(buf, 0);
        if (one) out.push(one);
      }
    } catch (e) {}
    return out;
  }

  function _dirs(os, path) {
    var home = '';
    try { home = os.homedir(); } catch (e) {}
    if (process.platform === 'win32') {
      var win = process.env.WINDIR || 'C:\\Windows';
      var local = process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '');
      var list = [path.join(win, 'Fonts')];
      if (local) list.push(path.join(local, 'Microsoft', 'Windows', 'Fonts'));
      return list;
    }
    // macOS
    var dirs = ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts'];
    if (home) dirs.push(path.join(home, 'Library', 'Fonts'));
    return dirs;
  }

  function list() {
    var fs, path, os;
    try { fs = require('fs'); path = require('path'); os = require('os'); }
    catch (e) { return []; }

    var seen = {}, all = [];
    var dirs = _dirs(os, path);
    for (var d = 0; d < dirs.length; d++) {
      var files;
      try { files = fs.readdirSync(dirs[d]); } catch (e) { continue; }
      for (var i = 0; i < files.length; i++) {
        var fn = files[i];
        if (!/\.(ttf|otf|ttc|otc)$/i.test(fn)) continue;
        var fonts = _parseFile(fs, path.join(dirs[d], fn));
        for (var k = 0; k < fonts.length; k++) {
          var f = fonts[k];
          if (!f.ps) continue;
          // Skip hidden/system faces (AE hides names starting with ".")
          if (f.ps.charAt(0) === '.' || (f.fam && f.fam.charAt(0) === '.')) continue;
          if (seen[f.ps]) continue;
          seen[f.ps] = 1;
          all.push(f);
        }
      }
    }
    all.sort(function (a, b) {
      var x = (a.fam + ' ' + a.st).toLowerCase(), y = (b.fam + ' ' + b.st).toLowerCase();
      return x < y ? -1 : (x > y ? 1 : 0);
    });
    return all;
  }

  return { list: list };
})();

// Node-require compatibility (harmless in the browser/CEP global context)
try { if (typeof module !== 'undefined' && module.exports) module.exports = FontScanner; } catch (e) {}
