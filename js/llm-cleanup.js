/**
 * llm-cleanup.js — AI Devanagari → Hinglish Roman conversion
 *
 * Uses curl via child_process.spawn — same pattern as ffmpeg in
 * audio-processor.js. This completely bypasses CEP's browser CORS
 * and Node.js TLS issues that silently kill XHR/https requests.
 *
 * ── Alignment guarantee ──────────────────────────────────────────────
 * The previous version asked the LLM to rewrite the whole transcript as
 * free text, then GUESSED how to map the new word count back onto the
 * original timestamps. Any merge/split/added word made the timing drift.
 *
 * This version sends the STT words as a JSON ARRAY and requires the model
 * to return a JSON array of the SAME LENGTH — one romanized token per
 * input word. That gives an exact 1:1 mapping, so every word keeps its
 * original start/end timestamp. If a batch comes back the wrong length we
 * fall back to per-word phonetic romanization for that batch only, which
 * is also 1:1 and timing-safe.
 *
 * Long transcripts are processed in sequential batches for reliability.
 */

'use strict';

var LLMCleanup = (function() {

  // ── Config ────────────────────────────────────────────────────────
  // Calls go through the proxy server (it holds the Groq key server-side).
  function _cfg() {
    return (typeof YASHKIT_CONFIG !== 'undefined') ? YASHKIT_CONFIG
         : { PROXY_BASE_URL: 'http://localhost:8787', APP_TOKEN: '' };
  }
  function _llmEndpoint() { return (_cfg().PROXY_BASE_URL || '').replace(/\/+$/, '') + '/api/llm'; }
  var MODEL       = 'openai/gpt-oss-120b';   // strongest Groq model for Hindi→Hinglish
  var BATCH       = 50;                       // words per LLM request (keeps count exact)

  var SYSTEM_PROMPT = [
    'You are a Hindi-to-Hinglish romanizer for Indian content creators.',
    '',
    'You receive a JSON array of Devanagari words in spoken order. Return ONLY',
    'a JSON object {"words":[...]} whose "words" array has EXACTLY the same',
    'length as the input, where element i is the Roman-script Hinglish form of',
    'the input word at index i.',
    '',
    'Rules:',
    '- One output token per input token. NEVER merge, split, reorder, add or',
    '  drop an element. Length in === length out.',
    '- English words borrowed into Hindi use correct English spelling:',
    '  माइंड→mind  वर्थ→worth  सैक्रिफाइस→sacrifice  ऑफिस→office  टाइम→time',
    '  फ़ोन→phone  वीडियो→video  लाइफ→life  लव→love',
    '- Hindi words use casual Hinglish spellings the way creators type on',
    '  Instagram/WhatsApp: मैं→main  यार→yaar  हूँ→hoon  क्या→kya  नहीं→nahi',
    '  भाई→bhai  बहुत→bahut  ठीक→theek  अच्छा→achha  करना→karna',
    '- Preserve any punctuation attached to a word (e.g. "पाया।"→"paya.").',
    '- Output must contain NO Devanagari characters.'
  ].join('\n');

  // ── clean ─────────────────────────────────────────────────────────
  /**
   * @param {Array<{word,start,end}>} words      Raw Devanagari STT words
   * @param {Function}                onDone     (cleanedWords) — always called
   * @param {Function}                onProgress ({pct,label}) — optional
   * @param {Function}                fallbackFn (words)→words — on any failure
   */
  function clean(words, onDone, onProgress, fallbackFn) {
    var fallback = fallbackFn || function(w) { return w; };

    if (!words || words.length === 0) { onDone(words); return; }

    if (onProgress) onProgress({ pct: 3, label: 'AI converting to Hinglish…' });

    // ── Node modules (always available in CEP with --enable-nodejs) ──
    var os, path, fs, spawn;
    try {
      os    = require('os');
      path  = require('path');
      fs    = require('fs');
      spawn = require('child_process').spawn;
    } catch (e) {
      console.warn('[LLM] Node modules unavailable:', e.message);
      onDone(fallback(words));
      return;
    }

    // ── Split into batches ───────────────────────────────────────────
    var batches = [];
    for (var i = 0; i < words.length; i += BATCH) {
      batches.push(words.slice(i, i + BATCH));
    }

    var ctx = {
      os: os, path: path, fs: fs, spawn: spawn,
      onProgress: onProgress, fallback: fallback,
      anySucceeded: false
    };

    var result = [];

    // Process batches sequentially so we keep memory + curl usage low and
    // can report smooth progress. Each batch is timing-safe on its own.
    function next(idx) {
      if (idx >= batches.length) {
        // If not a single batch went through the LLM, treat as failure so the
        // caller shows the "phonetic mode" notice instead of a false success.
        if (!ctx.anySucceeded) { onDone(fallback(words)); return; }
        if (onProgress) onProgress({ pct: 100, label: 'Hinglish ready' });
        onDone(result);
        return;
      }

      if (onProgress) {
        onProgress({
          pct:   5 + Math.round((idx / batches.length) * 90),
          label: 'AI Hinglish… (' + (idx + 1) + '/' + batches.length + ')'
        });
      }

      romanizeBatch(ctx, batches[idx], idx === 0, function(batchResult) {
        for (var k = 0; k < batchResult.length; k++) result.push(batchResult[k]);
        next(idx + 1);
      });
    }

    next(0);
  }

  // ── romanizeBatch ───────────────────────────────────────────────────
  // Sends one batch of words to the LLM and calls cb(alignedWords).
  // alignedWords is ALWAYS the same length as `batchWords` (1:1, timing kept).
  function romanizeBatch(ctx, batchWords, writeDebug, cb) {
    var os = ctx.os, path = ctx.path, fs = ctx.fs, spawn = ctx.spawn;

    var inputArr = batchWords.map(function(w) { return w.word; });

    var tmpIn  = path.join(os.tmpdir(), '.pulse_llm_in.json');
    var tmpOut = path.join(os.tmpdir(), '.pulse_llm_out.json');

    var bodyObj = {
      model:           MODEL,
      response_format: { type: 'json_object' },
      temperature:     0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content:
          'Romanize these ' + inputArr.length + ' words to Hinglish. Return a ' +
          'JSON object {"words":[...]} with EXACTLY ' + inputArr.length +
          ' elements, one per input word, same order.\nInput words: ' +
          JSON.stringify(inputArr) }
      ]
    };

    // On any failure, hand this batch to the phonetic fallback (still 1:1).
    function fail(reason) {
      console.warn('[LLM] batch fallback:', reason);
      cb(ctx.fallback(batchWords));
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

      // ── Debug dump (first batch only) ──────────────────────────────
      if (writeDebug) {
        try {
          fs.writeFileSync(
            path.join(os.homedir(), 'Desktop', 'pulse_llm_debug.txt'),
            [
              '=== Pulse Captions LLM Debug ===',
              'Time    : ' + new Date().toISOString(),
              'model   : ' + MODEL,
              'curl    : ' + curlPath,
              'exitCode: ' + exitCode,
              'HTTP    : ' + status,
              'stderr  : ' + (curlStderr || '(none)'),
              'body    : ' + (respStr || '(empty)').substring(0, 600),
              '================================'
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

      var outWords = parsed && Array.isArray(parsed.words) ? parsed.words : null;
      if (!outWords) { fail('no words array in content'); return; }

      // ── Exact 1:1 mapping required ─────────────────────────────────
      if (outWords.length !== batchWords.length) {
        fail('length mismatch ' + outWords.length + ' vs ' + batchWords.length);
        return;
      }

      var aligned = batchWords.map(function(w, i) {
        var tok = String(outWords[i] == null ? '' : outWords[i]).trim();
        return { word: tok || w.word, start: w.start, end: w.end };
      });

      ctx.anySucceeded = true;
      cb(aligned);
    });
  }

  return { clean: clean };

})();
