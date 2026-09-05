/**
 * ai-linebreak.js — "Smart" caption mode: AI-decided line breaks
 *
 * Phrase mode cuts blindly every N words, so "i'm not your hero. you got this"
 * with N=3 becomes the awkward "i'm not your / hero. you got / this". Smart mode
 * sends the words to the LLM and lets it decide WHERE to break, so you get the
 * natural "i'm not your hero / you got this" instead.
 *
 * ── Timing guarantee ─────────────────────────────────────────────────
 * Same philosophy as llm-cleanup.js: we NEVER let the model touch the words
 * themselves. It only returns a "sizes" array — how many consecutive words go
 * on each line — which we validate sums to exactly the input length. We then
 * slice the ORIGINAL word objects by those sizes, so every word keeps its
 * original start/end timestamp. If a batch comes back invalid we fall back to
 * a fixed grouping for that batch only, which is also timing-safe.
 *
 * Transport (curl via child_process.spawn) and proxy endpoint are identical to
 * llm-cleanup.js so this works inside CEP where XHR/https are unreliable.
 */

'use strict';

var AILineBreak = (function() {

  // ── Config ────────────────────────────────────────────────────────
  function _cfg() {
    return (typeof YASHKIT_CONFIG !== 'undefined') ? YASHKIT_CONFIG
         : { PROXY_BASE_URL: 'http://localhost:8787', APP_TOKEN: '' };
  }
  function _llmEndpoint() { return (_cfg().PROXY_BASE_URL || '').replace(/\/+$/, '') + '/api/llm'; }
  var MODEL    = 'openai/gpt-oss-120b';
  var BATCH    = 60;   // words per LLM request — keeps the model's counting reliable
  var MAX_LINE = 5;    // max words per line for the deterministic fallback grouping

  var SYSTEM_PROMPT = [
    'You are a caption line-break engine for short-form vertical video',
    '(Reels / TikTok / Shorts).',
    '',
    'You receive a JSON array of words in spoken order. Group them into short',
    'on-screen caption lines that read naturally and land like spoken beats.',
    '',
    'You return ONLY a JSON object {"lines":[...]} where "lines" is an ARRAY OF',
    'STRINGS — each string is ONE caption line, made of the next few words joined',
    'by single spaces, in the SAME order they were given. Concatenating all the',
    'lines back together (in order) MUST reproduce the input word sequence',
    'exactly. You decide ONLY where the line breaks go — you must NOT reorder,',
    'add, drop, merge or change any word.',
    '',
    'Line rules:',
    '- Break at natural phrase / clause / grammar boundaries. Never split a',
    '  phrase mid-thought (e.g. keep "not your hero" together, not "not your" +',
    '  "hero").',
    '- A sentence-ending word (ends with . ? !) should end its line.',
    '- Aim for 2-5 words per line; punchy beats can be shorter, never longer',
    '  than 6. Produce MANY short lines, never one long line.',
    '- Prefer breaking so each line is a complete idea a viewer can read at a',
    '  glance.',
    '',
    'Example — input',
    '  ["i\'m","not","your","hero.","you","got","this"]',
    'good output',
    '  {"lines":["i\'m not your hero.","you got this"]}'
  ].join('\n');

  // ── group ─────────────────────────────────────────────────────────
  /**
   * @param {Array<{word,start,end}>} words      STT words (kept verbatim)
   * @param {Function}                onDone      (captionGroups) — Array<Array<word>>
   * @param {Function}                onProgress  ({pct,label}) — optional
   */
  function group(words, onDone, onProgress) {
    if (!words || words.length === 0) { onDone([]); return; }

    if (onProgress) onProgress({ pct: 3, label: 'AI grouping captions…' });

    var os, path, fs, spawn;
    try {
      os    = require('os');
      path  = require('path');
      fs    = require('fs');
      spawn = require('child_process').spawn;
    } catch (e) {
      console.warn('[AILineBreak] Node modules unavailable:', e.message);
      onDone(_enforceSentenceBreaks(_naturalGroups(words, MAX_LINE)));
      return;
    }

    var batches = [];
    for (var i = 0; i < words.length; i += BATCH) {
      batches.push(words.slice(i, i + BATCH));
    }

    var ctx = { os: os, path: path, fs: fs, spawn: spawn, anySucceeded: false };
    var groups = [];

    function next(idx) {
      if (idx >= batches.length) {
        if (onProgress) {
          onProgress({ pct: 100, label: ctx.anySucceeded ? 'Captions phrased' : 'Phrased (fallback)' });
        }
        // Hard guarantees on the final grouping, no matter what the LLM returned
        // (or if we fell back): (1) no line longer than the cap — a giant
        // "whole transcript" line gets split sensibly; (2) a sentence-ending
        // word always ends its line.
        onDone(_enforceSentenceBreaks(_enforceMaxLen(groups)), ctx.anySucceeded);
        return;
      }

      if (onProgress) {
        onProgress({
          pct:   5 + Math.round((idx / batches.length) * 90),
          label: 'AI phrasing… (' + (idx + 1) + '/' + batches.length + ')'
        });
      }

      groupBatch(ctx, batches[idx], idx === 0, function(batchGroups) {
        for (var k = 0; k < batchGroups.length; k++) groups.push(batchGroups[k]);
        next(idx + 1);
      });
    }

    next(0);
  }

  // ── _endsSentence / _endsClause ─────────────────────────────────────
  // True when a word token ends a sentence (. ? !) or a clause (, ; : —),
  // allowing for trailing quotes/brackets like 'trade."' or 'day,)'.
  function _endsSentence(token) {
    return /[.?!]+["'’”»)\]]*$/.test(String(token == null ? '' : token).trim());
  }
  function _endsClause(token) {
    return /[,;:—–]+["'’”»)\]]*$/.test(String(token == null ? '' : token).trim());
  }

  // ── _naturalGroups ──────────────────────────────────────────────────
  // Timing-safe deterministic fallback (used when the LLM is unreachable or
  // returns garbage). Breaks at sentence ends ALWAYS, at clause boundaries once
  // a line has some heft, and at maxLen so no line runs too long. This alone
  // fixes the "...day. The..." gluing without any LLM call.
  function _naturalGroups(words, maxLen) {
    maxLen = maxLen || MAX_LINE;
    var out = [], cur = [];
    for (var i = 0; i < words.length; i++) {
      cur.push(words[i]);
      var tok = words[i].word;
      if (_endsSentence(tok) || cur.length >= maxLen ||
          (_endsClause(tok) && cur.length >= 3)) {
        out.push(cur);
        cur = [];
      }
    }
    if (cur.length) out.push(cur);
    return out;
  }

  // ── _enforceSentenceBreaks ──────────────────────────────────────────
  // Safety net applied to EVERY grouping (LLM or fallback): split any line at
  // an internal sentence-ending word so the next sentence always starts on a
  // fresh line. Timing-safe — only re-slices existing word objects.
  function _enforceSentenceBreaks(groups) {
    var out = [];
    (groups || []).forEach(function(chunk) {
      if (!chunk || chunk.length === 0) return;
      var cur = [];
      for (var i = 0; i < chunk.length; i++) {
        cur.push(chunk[i]);
        // Break after a sentence-ending word unless it's the last word in the
        // chunk (which is already a line end).
        if (_endsSentence(chunk[i].word) && i < chunk.length - 1) {
          out.push(cur);
          cur = [];
        }
      }
      if (cur.length) out.push(cur);
    });
    return out;
  }

  // ── _enforceMaxLen ──────────────────────────────────────────────────
  // Safety net: any group longer than the cap is re-split with the
  // sentence/clause-aware grouper. This is what prevents the "whole transcript
  // on one line" failure if the model returns a single huge group. A cap of
  // MAX_LINE+2 leaves the model's own short lines untouched. Timing-safe.
  function _enforceMaxLen(groups) {
    var cap = MAX_LINE + 2, out = [];
    (groups || []).forEach(function(chunk) {
      if (!chunk || chunk.length === 0) return;
      if (chunk.length <= cap) { out.push(chunk); return; }
      var split = _naturalGroups(chunk, MAX_LINE);
      for (var i = 0; i < split.length; i++) out.push(split[i]);
    });
    return out;
  }

  // ── _groupsFromSizes ─────────────────────────────────────────────────
  // Slice ORIGINAL word objects by the model's sizes array — TOLERANTLY.
  // gpt-oss is a reasoning model and is poor at making a list of counts sum to
  // exactly N, so we never reject a batch for an off-by-some sum. Instead we
  // follow the grouping intent and guarantee full word coverage:
  //   • each positive integer size consumes that many of the remaining words
  //     (clamped so we never overrun);
  //   • non-positive / non-integer sizes are skipped;
  //   • any words left over after the sizes run out are appended via the
  //     sentence-aware fallback so nothing is dropped.
  // The result always covers every word exactly once (1:1, timing kept).
  function _groupsFromSizes(batchWords, sizes) {
    var out = [], cursor = 0, n = batchWords.length;
    for (var i = 0; i < sizes.length && cursor < n; i++) {
      var sz = sizes[i];
      if (typeof sz !== 'number' || sz < 1) continue;
      sz = Math.min(Math.floor(sz), n - cursor);
      out.push(batchWords.slice(cursor, cursor + sz));
      cursor += sz;
    }
    // Leftover words (model under-counted) → group them naturally rather than
    // dumping them all on one line.
    if (cursor < n) {
      var rest = _naturalGroups(batchWords.slice(cursor), MAX_LINE);
      for (var k = 0; k < rest.length; k++) out.push(rest[k]);
    }
    return out;
  }

  // ── groupBatch ──────────────────────────────────────────────────────
  // Sends one batch and calls cb(groups). groups always covers every word in
  // the batch exactly once (1:1, timing kept) — LLM result or fallback.
  function groupBatch(ctx, batchWords, writeDebug, cb) {
    var os = ctx.os, path = ctx.path, fs = ctx.fs, spawn = ctx.spawn;

    var inputArr = batchWords.map(function(w) { return w.word; });

    var tmpIn  = path.join(os.tmpdir(), '.pulse_ailb_in.json');
    var tmpOut = path.join(os.tmpdir(), '.pulse_ailb_out.json');

    var bodyObj = {
      model:           MODEL,
      response_format: { type: 'json_object' },
      temperature:     0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content:
          'Group these ' + inputArr.length + ' words into many short, natural ' +
          'caption lines (2-5 words each). Return a JSON object {"lines":[...]} ' +
          'where each element is one line as a string of words.\nWords: ' +
          JSON.stringify(inputArr) }
      ]
    };

    // On any failure, group this batch with the deterministic sentence-aware
    // fallback (still 1:1, timing-safe).
    function fail(reason) {
      console.warn('[AILineBreak] batch fallback:', reason);
      cb(_naturalGroups(batchWords, MAX_LINE));
    }

    try { fs.writeFileSync(tmpIn, JSON.stringify(bodyObj), 'utf8'); }
    catch (e) { fail('write temp: ' + e.message); return; }

    var platform = os.platform();
    var curlPath = platform === 'win32' ? 'curl' : '/usr/bin/curl';

    var curlArgs = [
      '-s', '-X', 'POST', _llmEndpoint(),
      '-H', 'Content-Type: application/json',
      '-d', '@' + tmpIn,
      '-o', tmpOut,
      '-w', '%{http_code}',
      '--max-time', '60',
      '--connect-timeout', '10'
    ];
    var _t = _cfg().APP_TOKEN;
    if (_t) curlArgs.push('-H', 'x-app-token: ' + _t);

    var curlProc;
    try { curlProc = spawn(curlPath, curlArgs); }
    catch (e) { fail('spawn: ' + e.message); return; }

    var httpCode = '';
    var curlStderr = '';
    curlProc.stdout.on('data', function(d) { httpCode += d.toString().trim(); });
    curlProc.stderr.on('data', function(d) { curlStderr += d.toString(); });

    curlProc.on('error', function(e) {
      try { fs.unlinkSync(tmpIn); } catch (e2) {}
      fail('curl error: ' + e.message);
    });

    curlProc.on('close', function(exitCode) {
      try { fs.unlinkSync(tmpIn); } catch (e) {}

      var status  = parseInt(httpCode, 10) || 0;
      var respStr = '';
      try { respStr = fs.readFileSync(tmpOut, 'utf8'); } catch (e2) {}
      try { fs.unlinkSync(tmpOut); } catch (e2) {}

      if (writeDebug) {
        try {
          fs.writeFileSync(
            path.join(os.homedir(), 'Desktop', 'pulse_ailb_debug.txt'),
            [
              '=== Pulse Captions AI Line-Break Debug ===',
              'Time    : ' + new Date().toISOString(),
              'model   : ' + MODEL,
              'curl    : ' + curlPath,
              'exitCode: ' + exitCode,
              'HTTP    : ' + status,
              'stderr  : ' + (curlStderr || '(none)'),
              'body    : ' + (respStr || '(empty)').substring(0, 600),
              '==========================================='
            ].join('\n'), 'utf8');
        } catch (logErr) {}
      }

      if (exitCode !== 0 || status === 0 || status >= 400) {
        fail('http ' + status + ' exit ' + exitCode); return;
      }

      var data;
      try { data = JSON.parse(respStr); }
      catch (e) { fail('parse response: ' + respStr.substring(0, 120)); return; }

      var content = data.choices && data.choices[0] &&
                    data.choices[0].message && data.choices[0].message.content;
      if (!content || typeof content !== 'string') { fail('empty content'); return; }

      var parsed;
      try { parsed = JSON.parse(content); }
      catch (e) { fail('content not JSON: ' + content.substring(0, 120)); return; }

      // Preferred format: {"lines":["line one","line two",...]} — derive the
      // per-line word COUNTS from the strings (we never trust the words back,
      // only the counts, then slice the ORIGINAL words by them). This avoids the
      // gpt-oss quirk of collapsing a numeric {"sizes":[5,3]} into one int 53.
      var sizes = null;
      if (parsed && Array.isArray(parsed.lines)) {
        sizes = [];
        for (var i = 0; i < parsed.lines.length; i++) {
          var line = parsed.lines[i];
          if (typeof line !== 'string') continue;
          var toks = line.replace(/^\s+|\s+$/g, '').split(/\s+/);
          var c = 0;
          for (var t = 0; t < toks.length; t++) { if (toks[t]) c++; }
          if (c > 0) sizes.push(c);
        }
      } else if (parsed && Array.isArray(parsed.sizes)) {
        // Back-compat: accept a real numeric breakdown if the model sends one.
        sizes = parsed.sizes;
      }

      // A usable result needs MORE THAN ONE line — a single line means the model
      // failed to break it (or collapsed the array), so treat that as a failure
      // and let the deterministic fallback split it sensibly.
      var usableCount = 0;
      if (sizes) {
        for (var s = 0; s < sizes.length; s++) {
          if (typeof sizes[s] === 'number' && sizes[s] >= 1) usableCount++;
        }
      }
      if (usableCount < 2) { fail('model did not break into multiple lines'); return; }

      ctx.anySucceeded = true;
      cb(_groupsFromSizes(batchWords, sizes));
    });
  }

  return { group: group };

})();
