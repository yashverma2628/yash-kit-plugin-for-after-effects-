/**
 * ai-emphasis.js — AI-weighted line splits for the two-line caption looks
 * (Emphasis / Font Pair).
 *
 * A two-line caption reads best when the split follows meaning: a light
 * intro over the words that carry the weight — "completely | change your
 * life", not "completely change | your life". The LLM sees each caption and
 * returns ONLY the intro word-count per caption; we never let it touch the
 * words themselves, so timing stays exact (same philosophy as
 * ai-linebreak.js / llm-cleanup.js).
 *
 * Fallback (offline / LLM failure): a stopword-aware heuristic that starts
 * the payoff on the first content word near the 35% mark.
 *
 * Transport (curl via child_process.spawn) and the /api/llm proxy endpoint
 * are identical to ai-linebreak.js so this works inside CEP.
 */

'use strict';

var AIEmphasis = (function () {

  function _cfg() {
    return (typeof YASHKIT_CONFIG !== 'undefined') ? YASHKIT_CONFIG
         : { PROXY_BASE_URL: 'http://localhost:8787', APP_TOKEN: '' };
  }
  function _llmEndpoint() { return (_cfg().PROXY_BASE_URL || '').replace(/\/+$/, '') + '/api/llm'; }
  var MODEL = 'openai/gpt-oss-120b';
  var BATCH = 40;   // captions per LLM request

  var SYSTEM_PROMPT = [
    'You split short video captions into TWO lines: a small INTRO line and an',
    'emphasized PAYOFF line. The payoff is the part that carries the meaning —',
    'the key verb phrase, punchline, number or noun phrase. Example: for',
    '"completely change your life" the intro is "completely" (1 word) and the',
    'payoff is "change your life".',
    '',
    'You receive a JSON array of caption strings. For EACH caption return the',
    'number of words that belong to the INTRO line (the words BEFORE the',
    'payoff). Rules:',
    '- the count must be at least 1 and less than the caption word count,',
    '  so both lines always have at least one word;',
    '- keep the intro short — usually 1-2 words, never more than half;',
    '- never split inside a tight phrase (keep "your life" together).',
    '',
    'Return ONLY a JSON object {"splits":[...]} with exactly one integer per',
    'caption, in the same order.'
  ].join('\n');

  // ── Heuristic fallback ────────────────────────────────────────────
  var STOPWORDS = {};
  ('a an the and or but so to of in on at for with is are was were be been ' +
   'it its this that these those you your i we they he she my our me him her ' +
   'them as by from not do does did have has had will would can could just ' +
   'really very gonna wanna about if when then than there here').split(' ')
    .forEach(function (w) { STOPWORDS[w] = true; });

  function _isContent(word) {
    var w = String(word == null ? '' : word).toLowerCase().replace(/[^a-z']/g, '');
    return w.length > 0 && !STOPWORDS[w];
  }

  /* Pick the split closest to the 35% mark where the payoff starts on a
     content word (so the second line opens with weight, not "the"/"and"). */
  function _heuristicSplit(words) {
    var n = words.length;
    if (n < 3) return 1;
    var target = Math.max(1, Math.round(n * 0.35));
    var best = target, bestDist = Infinity;
    for (var j = 1; j < n; j++) {
      if (!_isContent(words[j])) continue;   // payoff must start on a content word
      var dist = Math.abs(j - target);
      if (dist < bestDist) { best = j; bestDist = dist; }
    }
    return Math.max(1, Math.min(n - 1, best));
  }

  // ── split ─────────────────────────────────────────────────────────
  /**
   * Attaches `splitIndex` (intro word count) to every caption object.
   * @param {Array<{text:string}>} captions   mutated in place
   * @param {Function} onDone      (captions, aiSucceeded)
   * @param {Function} onProgress  ({pct,label}) — optional
   */
  function split(captions, onDone, onProgress) {
    if (!captions || captions.length === 0) { onDone(captions, false); return; }

    // Heuristic first so every caption always has a valid split, then let
    // the LLM overwrite the ones it answers for.
    captions.forEach(function (c) {
      var words = String(c.text == null ? '' : c.text).replace(/\s+/g, ' ').split(' ');
      c.splitIndex = _heuristicSplit(words);
    });

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
          label: 'AI weighing emphasis… (' + (idx + 1) + '/' + batches.length + ')'
        });
      }
      splitBatch(ctx, batches[idx], function () { next(idx + 1); });
    }
    next(0);
  }

  // ── splitBatch ────────────────────────────────────────────────────
  // Asks the LLM for one batch. On ANY failure the heuristic values already
  // on the captions stand — cb() always continues the chain.
  function splitBatch(ctx, batch, cb) {
    var os = ctx.os, path = ctx.path, fs = ctx.fs, spawn = ctx.spawn;

    var texts = batch.map(function (c) { return String(c.text == null ? '' : c.text); });

    var tmpIn  = path.join(os.tmpdir(), '.pulse_aiem_in.json');
    var tmpOut = path.join(os.tmpdir(), '.pulse_aiem_out.json');

    var bodyObj = {
      model:           MODEL,
      response_format: { type: 'json_object' },
      temperature:     0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content:
          'Split these ' + texts.length + ' captions. Return {"splits":[...]} ' +
          'with one intro word-count per caption, same order.\nCaptions: ' +
          JSON.stringify(texts) }
      ]
    };

    function done(reason) {
      if (reason) console.warn('[AIEmphasis] batch fallback:', reason);
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
      if (!parsed || !Array.isArray(parsed.splits)) { done('no splits array'); return; }

      // Apply only VALID answers; anything else keeps its heuristic value.
      var applied = 0;
      for (var i = 0; i < batch.length && i < parsed.splits.length; i++) {
        var v = parsed.splits[i];
        var n = String(batch[i].text == null ? '' : batch[i].text)
                  .replace(/\s+/g, ' ').split(' ').length;
        if (typeof v === 'number' && isFinite(v)) {
          v = Math.floor(v);
          if (v >= 1 && v < n) { batch[i].splitIndex = v; applied++; }
        }
      }
      if (applied > 0) ctx.anySucceeded = true;
      done(null);
    });
  }

  return { split: split };

})();
