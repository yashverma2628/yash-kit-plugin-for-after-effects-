/**
 * ai-emoji.js — one tasteful emoji per caption, picked by the LLM.
 *
 * Short-form captions read better with the occasional emoji riding along with
 * the words that carry the meaning ("this changed everything 🤯"). The model
 * sees the caption texts and returns ONE emoji per caption — or an empty
 * string, which is the right answer most of the time. It never touches the
 * words, so timing and per-word animations stay exact (same philosophy as
 * ai-emphasis.js / ai-linebreak.js / llm-cleanup.js).
 *
 * Result lands on `cap.emoji` ('' when the caption gets none). The renderer
 * decides where to put it — host/index.jsx prepends it to the text layer.
 *
 * There is no offline fallback: a keyword table would guess badly across the
 * 30+ languages Yashkit transcribes. If the LLM is unreachable every caption
 * keeps emoji '' and placement carries on unchanged.
 *
 * Transport (curl via child_process.spawn) and the /api/llm proxy endpoint
 * are identical to ai-emphasis.js so this works inside CEP.
 */

'use strict';

var AIEmoji = (function () {

  function _cfg() {
    return (typeof YASHKIT_CONFIG !== 'undefined') ? YASHKIT_CONFIG
         : { PROXY_BASE_URL: 'http://localhost:8787', APP_TOKEN: '' };
  }
  function _llmEndpoint() { return (_cfg().PROXY_BASE_URL || '').replace(/\/+$/, '') + '/api/llm'; }
  var MODEL = 'openai/gpt-oss-120b';
  var BATCH = 40;   // captions per LLM request

  var SYSTEM_PROMPT = [
    'You add emoji to short video captions (TikTok / Reels / Shorts style).',
    '',
    'You receive a JSON array of caption strings. For EACH caption return ONE',
    'emoji that matches what it says, or an empty string "" when no emoji fits.',
    'Rules:',
    '- return EXACTLY one emoji character per caption, never two, never text;',
    '- be sparing: most captions should get "". Only mark the ones with a clear',
    '  concrete hook — money, fire/heat, growth, time, an emotion, an object;',
    '- never put an emoji on filler, connectives or half-finished phrases;',
    '- never repeat the same emoji on two neighbouring captions;',
    '- no flags, no skin-tone modifiers, no country or religious symbols.',
    '',
    'Return ONLY a JSON object {"emojis":[...]} with exactly one string per',
    'caption, in the same order.'
  ].join('\n');

  /* An emoji and nothing else. ES5-safe validation — no \p{...} classes, so we
     check code points by hand:
       - reject anything containing ASCII (a word, a sentence, punctuation, or
         the model apologising). Costs us keycaps like 1️⃣, which is fine.
       - reject long strings (a ZWJ family sequence is ~8 UTF-16 units;
         anything past 12 is prose)
       - require the first code point to sit in emoji territory (>= U+203C),
         which also covers surrogate pairs (U+D800–U+DBFF) */
  var ZERO_WIDTH_SPACE = String.fromCharCode(0x200B);

  function _cleanEmoji(v) {
    if (typeof v !== 'string') return '';
    var s = v.replace(/\s+/g, '').split(ZERO_WIDTH_SPACE).join('');
    if (!s) return '';
    if (s.length > 12) return '';
    if (/[\x00-\x7F]/.test(s)) return '';          // any ASCII -> not a bare emoji
    if (s.charCodeAt(0) < 0x203C) return '';       // not an emoji code point
    return s;
  }

  // ── annotate ──────────────────────────────────────────────────────
  /**
   * Attaches `emoji` (one emoji, or '') to every caption object.
   * @param {Array<{text:string}>} captions   mutated in place
   * @param {Function} onDone      (captions, aiSucceeded)
   * @param {Function} onProgress  ({pct,label}) — optional
   */
  function annotate(captions, onDone, onProgress) {
    if (!captions || captions.length === 0) { onDone(captions, false); return; }

    // Start from "no emoji" everywhere so a partial/failed run always leaves
    // every caption in a valid state.
    captions.forEach(function (c) { c.emoji = ''; });

    var os, path, fs, spawn;
    try {
      os    = require('os');
      path  = require('path');
      fs    = require('fs');
      spawn = require('child_process').spawn;
    } catch (e) {
      onDone(captions, false);
      return;
    }

    var batches = [];
    for (var i = 0; i < captions.length; i += BATCH) {
      batches.push(captions.slice(i, i + BATCH));
    }
    var ctx = { os: os, path: path, fs: fs, spawn: spawn, anySucceeded: false };

    function next(idx) {
      if (idx >= batches.length) { onDone(captions, ctx.anySucceeded); return; }
      if (onProgress) {
        onProgress({
          pct:   Math.round((idx / batches.length) * 100),
          label: 'AI picking emoji… (' + (idx + 1) + '/' + batches.length + ')'
        });
      }
      annotateBatch(ctx, batches[idx], function () { next(idx + 1); });
    }
    next(0);
  }

  // ── annotateBatch ─────────────────────────────────────────────────
  // Asks the LLM for one batch. On ANY failure the captions in that batch keep
  // emoji '' — cb() always continues the chain.
  function annotateBatch(ctx, batch, cb) {
    var os = ctx.os, path = ctx.path, fs = ctx.fs, spawn = ctx.spawn;

    var texts = batch.map(function (c) { return String(c.text == null ? '' : c.text); });

    var tmpIn  = path.join(os.tmpdir(), '.pulse_aiemoji_in.json');
    var tmpOut = path.join(os.tmpdir(), '.pulse_aiemoji_out.json');

    var bodyObj = {
      model:           MODEL,
      response_format: { type: 'json_object' },
      temperature:     0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content:
          'Pick emoji for these ' + texts.length + ' captions. Return ' +
          '{"emojis":[...]} with one emoji or "" per caption, same order.\n' +
          'Captions: ' + JSON.stringify(texts) }
      ]
    };

    // Once only: a spawned process can emit BOTH 'error' and 'close', and every
    // failure branch routes through here — a second cb() would advance the batch
    // chain twice and finish the whole run early with the wrong result.
    var finished = false;
    function done(reason) {
      if (finished) return;
      finished = true;
      if (reason) console.warn('[AIEmoji] batch skipped:', reason);
      cb();
    }

    try { fs.writeFileSync(tmpIn, JSON.stringify(bodyObj), 'utf8'); }
    catch (e) { done('write temp: ' + e.message); return; }

    var curlPath = os.platform() === 'win32' ? 'curl' : '/usr/bin/curl';
    var curlArgs = [
      '-s', '-X', 'POST', _llmEndpoint(),
      '-H', 'Content-Type: application/json',
      '-d', '@' + tmpIn,
      '-o', tmpOut,
      '-w', '%{http_code}',
      '--max-time', '45',
      '--connect-timeout', '10'
    ];
    var _t = _cfg().APP_TOKEN;
    if (_t) curlArgs.push('-H', 'x-app-token: ' + _t);

    var proc;
    try { proc = spawn(curlPath, curlArgs); }
    catch (e) { done('spawn: ' + e.message); return; }

    var httpCode = '';
    proc.stdout.on('data', function (d) { httpCode += d.toString().trim(); });
    proc.on('error', function (e) {
      try { fs.unlinkSync(tmpIn); } catch (e2) {}
      done('curl error: ' + e.message);
    });

    proc.on('close', function (exitCode) {
      try { fs.unlinkSync(tmpIn); } catch (e) {}
      var status  = parseInt(httpCode, 10) || 0;
      var respStr = '';
      try { respStr = fs.readFileSync(tmpOut, 'utf8'); } catch (e2) {}
      try { fs.unlinkSync(tmpOut); } catch (e2) {}

      if (exitCode !== 0 || status === 0 || status >= 400) { done('http ' + status); return; }

      var content = null;
      try {
        var data = JSON.parse(respStr);
        content = data.choices && data.choices[0] &&
                  data.choices[0].message && data.choices[0].message.content;
      } catch (e) { done('parse response'); return; }
      if (!content || typeof content !== 'string') { done('empty content'); return; }

      var parsed;
      try { parsed = JSON.parse(content); }
      catch (e) { done('content not JSON'); return; }
      if (!parsed || !Array.isArray(parsed.emojis)) { done('no emojis array'); return; }

      // Apply only values that survive validation; the rest stay ''.
      // Also drop a repeat of the previous caption's emoji so runs of the same
      // glyph don't march down the timeline.
      var applied = 0;
      var prev = '';
      for (var i = 0; i < batch.length && i < parsed.emojis.length; i++) {
        var e = _cleanEmoji(parsed.emojis[i]);
        if (e && e === prev) e = '';
        batch[i].emoji = e;
        if (e) { applied++; prev = e; }
      }
      // A batch where the model correctly answered "no emoji" for everything is
      // still a success — it answered. Only a malformed reply is a failure.
      if (applied > 0 || parsed.emojis.length >= batch.length) ctx.anySucceeded = true;
      done(null);
    });
  }

  // ── renderAssets ──────────────────────────────────────────────────
  /**
   * Rasterise every emoji in use to a PNG on disk and return
   * { '🔥': '/path/emoji-1f525.png', … }.
   *
   * WHY: After Effects cannot draw colour-emoji fonts. Apple Color Emoji is an
   * sbix bitmap font and Segoe UI Emoji is COLR/CPAL; AE's text engine renders
   * neither, so an emoji typed into a text layer comes out blank or as a tofu
   * box — which is exactly what putting it in the caption string did. The panel,
   * on the other hand, is Chromium: canvas draws the real full-colour glyph. So
   * the emoji is rendered here and placed in the comp as footage instead.
   *
   * Files are written under ~/.yashkit/emoji/ and KEPT: After Effects references
   * imported footage by path, so deleting them would take the layers offline.
   * They're content-addressed by code point, so a second run reuses them.
   *
   * @param {Array} captions   read for their .emoji values
   * @param {Function} onDone  (assetMap) — always called, possibly with {}
   */
  function renderAssets(captions, onDone) {
    var map = {};
    if (!captions || captions.length === 0) { onDone(map); return; }

    // Unique, in first-seen order.
    var wanted = [], seen = {};
    captions.forEach(function (c) {
      var e = c && c.emoji;
      if (e && !seen[e]) { seen[e] = 1; wanted.push(e); }
    });
    if (wanted.length === 0) { onDone(map); return; }

    var os, path, fs;
    try { os = require('os'); path = require('path'); fs = require('fs'); }
    catch (e) { onDone(map); return; }

    var dir = path.join(os.homedir(), '.yashkit', 'emoji');
    try {
      // ES5-safe mkdir -p (two levels, so no recursion needed).
      var parent = path.join(os.homedir(), '.yashkit');
      if (!fs.existsSync(parent)) fs.mkdirSync(parent);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    } catch (e) { onDone(map); return; }

    var SIZE = 256;   // plenty for a caption-height glyph in a 4K comp

    wanted.forEach(function (emoji) {
      var file = path.join(dir, 'emoji-' + _codePointName(emoji) + '.png');
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 0) { map[emoji] = file; return; }
      } catch (e) { }

      var png = _emojiToPngBuffer(emoji, SIZE);
      if (!png) return;
      try {
        fs.writeFileSync(file, png);
        map[emoji] = file;
      } catch (e) { }
    });

    onDone(map);
  }

  /* Stable filename from the emoji's code points: 🔥 → "1f525",
     👨‍👩‍👧 → "1f468-200d-1f469-200d-1f467". */
  function _codePointName(str) {
    var parts = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      // Combine surrogate pairs into the real code point.
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
        var low = str.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          parts.push((((code - 0xD800) * 0x400) + (low - 0xDC00) + 0x10000).toString(16));
          i++;
          continue;
        }
      }
      parts.push(code.toString(16));
    }
    return parts.join('-');
  }

  /* Draw one emoji centred on a transparent square canvas and return the PNG
     bytes as a Buffer. Returns null if the glyph didn't render (no matching
     font on this machine) so the caller can skip it rather than place a blank. */
  function _emojiToPngBuffer(emoji, size) {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, size, size);
      ctx.font = Math.round(size * 0.76) + 'px "Apple Color Emoji","Segoe UI Emoji",' +
                 '"Noto Color Emoji","Twemoji Mozilla",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emoji, size / 2, size / 2 + Math.round(size * 0.03));

      // Reject a blank render — better no emoji than an empty layer.
      var data = ctx.getImageData(0, 0, size, size).data;
      var opaque = 0;
      for (var i = 3; i < data.length; i += 4) {
        if (data[i] > 8 && ++opaque > 64) break;
      }
      if (opaque <= 64) return null;

      var url = canvas.toDataURL('image/png');
      var b64 = url.substring(url.indexOf(',') + 1);
      // CEP ships an older Node on some hosts, where Buffer.from is absent.
      return (typeof Buffer.from === 'function')
        ? Buffer.from(b64, 'base64')
        : new Buffer(b64, 'base64');
    } catch (e) {
      console.warn('[AIEmoji] render failed for', emoji, e && e.message);
      return null;
    }
  }

  return {
    annotate:     annotate,
    renderAssets: renderAssets
  };

})();
