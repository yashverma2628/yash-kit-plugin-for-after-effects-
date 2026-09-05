/**
 * ai-translate.js — translate finished captions without touching their timing.
 *
 * The transcript is already cut into timed captions when this runs, so the one
 * thing translation must not do is renegotiate the timeline. The model gets the
 * caption strings and returns exactly one translated string per caption, in the
 * same order — never merged, never split, never reordered. Each caption keeps
 * its own startTime/endTime, so a translated caption sits exactly where the
 * original sat (same philosophy as ai-linebreak.js / ai-emphasis.js).
 *
 * Word timing: cap.words holds the ORIGINAL words with real speech timestamps.
 * A translation has a different word count and a different word order, so those
 * stamps can't survive honestly. Rather than fake them, translate() spreads the
 * caption's own [start, end] span across the translated words proportionally to
 * their length and marks the caption `wordsEstimated = true`. Renderers that
 * care (karaoke, spotlight — anything keyed to a specific word being spoken)
 * check that flag and fall back to caption-level animation. The original words
 * are kept on cap.wordsOriginal so switching back to the source language is
 * lossless.
 *
 * Transport (curl via child_process.spawn) and the /api/llm proxy endpoint
 * are identical to ai-emphasis.js so this works inside CEP.
 */

'use strict';

var AITranslate = (function () {

  function _cfg() {
    return (typeof YASHKIT_CONFIG !== 'undefined') ? YASHKIT_CONFIG
         : { PROXY_BASE_URL: 'http://localhost:8787', APP_TOKEN: '' };
  }
  function _llmEndpoint() { return (_cfg().PROXY_BASE_URL || '').replace(/\/+$/, '') + '/api/llm'; }
  var MODEL = 'openai/gpt-oss-120b';
  var BATCH = 25;   // captions per LLM request (smaller than the other modules:
                    // translations are much longer than an integer or an emoji)

  /* Languages offered in the "Translate to…" picker. Deliberately independent
     of the STT language list: translation runs on text through the LLM, so it
     isn't limited to what the transcriber supports. */
  var TARGETS = [
    ['en',  'English',    'English',    '🇺🇸'],
    ['hi',  'Hindi',      'हिन्दी',      '🇮🇳'],
    ['es',  'Spanish',    'Español',    '🇪🇸'],
    ['fr',  'French',     'Français',   '🇫🇷'],
    ['de',  'German',     'Deutsch',    '🇩🇪'],
    ['pt',  'Portuguese', 'Português',  '🇵🇹'],
    ['it',  'Italian',    'Italiano',   '🇮🇹'],
    ['nl',  'Dutch',      'Nederlands', '🇳🇱'],
    ['ru',  'Russian',    'Русский',    '🇷🇺'],
    ['uk',  'Ukrainian',  'Українська', '🇺🇦'],
    ['pl',  'Polish',     'Polski',     '🇵🇱'],
    ['tr',  'Turkish',    'Türkçe',     '🇹🇷'],
    ['ar',  'Arabic',     'العربية',     '🇸🇦'],
    ['ja',  'Japanese',   '日本語',       '🇯🇵'],
    ['ko',  'Korean',     '한국어',       '🇰🇷'],
    ['zh',  'Chinese',    '中文',         '🇨🇳'],
    ['id',  'Indonesian', 'Bahasa',     '🇮🇩'],
    ['vi',  'Vietnamese', 'Tiếng Việt', '🇻🇳'],
    ['th',  'Thai',       'ไทย',         '🇹🇭'],
    ['bn',  'Bengali',    'বাংলা',        '🇮🇳'],
    ['ta',  'Tamil',      'தமிழ்',        '🇮🇳'],
    ['te',  'Telugu',     'తెలుగు',       '🇮🇳'],
    ['mr',  'Marathi',    'मराठी',        '🇮🇳'],
    ['gu',  'Gujarati',   'ગુજરાતી',      '🇮🇳']
  ];

  function targetName(code) {
    for (var i = 0; i < TARGETS.length; i++) if (TARGETS[i][0] === code) return TARGETS[i][1];
    return code;
  }

  function _systemPrompt(langName) {
    return [
      'You translate short video captions into ' + langName + '.',
      '',
      'You receive a JSON array of caption strings, in timeline order. They are',
      'consecutive fragments of ONE continuous piece of speech, so a caption may',
      'start or end mid-sentence. Use the neighbouring captions for context, but',
      'translate them one-for-one.',
      '',
      'Rules:',
      '- return EXACTLY one translated string per input caption, same order;',
      '- never merge two captions, never split one, never reorder, never drop',
      '  one and never add one — the count must match exactly;',
      '- keep each translation close in length to its source: these are on-screen',
      '  captions with a fixed time slot;',
      '- keep a fragment a fragment. Do not complete a sentence that the source',
      '  caption leaves unfinished;',
      '- preserve numbers, names, @handles, #hashtags and URLs as-is;',
      '- if a caption is already in ' + langName + ', return it unchanged;',
      '- return the translation only — no quotes, no notes, no transliteration.',
      '',
      'Return ONLY a JSON object {"translations":[...]} of strings.'
    ].join('\n');
  }

  /* Re-time a translated caption's words. Speech timestamps can't be carried
     across a translation, so the caption's own span is divided among the new
     words in proportion to their length — a readable approximation, flagged as
     an approximation so per-word renderers can opt out. */
  function _estimateWords(cap) {
    var text = String(cap.text == null ? '' : cap.text).replace(/\s+/g, ' ');
    text = text.replace(/^\s+|\s+$/g, '');
    var parts = text.length ? text.split(' ') : [];
    var start = cap.startTime;
    var span  = Math.max(0.01, cap.endTime - cap.startTime);

    if (parts.length === 0) return [];

    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += Math.max(1, parts[i].length);

    var out = [], t = start;
    for (i = 0; i < parts.length; i++) {
      var share = (Math.max(1, parts[i].length) / total) * span;
      out.push({ word: parts[i], start: t, end: t + share });
      t += share;
    }
    // Absorb rounding into the last word so the caption's end is exact.
    out[out.length - 1].end = cap.endTime;
    return out;
  }

  /* Put a caption back the way it was before translation. */
  function restore(captions) {
    if (!captions) return captions;
    captions.forEach(function (c) {
      if (c.textOriginal != null) c.text = c.textOriginal;
      if (c.wordsOriginal) c.words = c.wordsOriginal;
      delete c.wordsEstimated;
      delete c.translatedTo;
    });
    return captions;
  }

  // ── translate ─────────────────────────────────────────────────────
  /**
   * Replaces cap.text with its translation, keeping cap.startTime/endTime exact.
   * @param {Array} captions      mutated in place
   * @param {String} targetCode   e.g. 'es'
   * @param {Function} onDone     (captions, translatedCount, lastError)
   * @param {Function} onProgress ({pct,label}) — optional
   */
  function translate(captions, targetCode, onDone, onProgress) {
    if (!captions || captions.length === 0) { onDone(captions, 0); return; }

    var langName = targetName(targetCode);

    // Stash the source text/words once, so re-translating (or switching back to
    // the original) always starts from the real transcript rather than from a
    // previous translation.
    captions.forEach(function (c) {
      if (c.textOriginal == null) c.textOriginal = c.text;
      if (!c.wordsOriginal && c.words) c.wordsOriginal = c.words;
    });

    var os, path, fs, spawn;
    try {
      os    = require('os');
      path  = require('path');
      fs    = require('fs');
      spawn = require('child_process').spawn;
    } catch (e) {
      onDone(captions, 0, 'node modules unavailable');
      return;
    }

    var batches = [];
    for (var i = 0; i < captions.length; i += BATCH) {
      batches.push(captions.slice(i, i + BATCH));
    }
    var ctx = {
      os: os, path: path, fs: fs, spawn: spawn,
      langName: langName, targetCode: targetCode, translated: 0,
      lastError: ''
    };

    function next(idx) {
      if (idx >= batches.length) { onDone(captions, ctx.translated, ctx.lastError); return; }
      if (onProgress) {
        onProgress({
          pct:   Math.round((idx / batches.length) * 100),
          label: 'Translating to ' + langName + '… (' + (idx + 1) + '/' + batches.length + ')'
        });
      }
      translateBatch(ctx, batches[idx], function () { next(idx + 1); });
    }
    next(0);
  }

  // ── translateBatch ────────────────────────────────────────────────
  // One LLM round trip. A batch that fails leaves its captions in the source
  // language — partial translation is visible and recoverable, whereas throwing
  // away the whole transcript is not.
  function translateBatch(ctx, batch, cb) {
    var os = ctx.os, path = ctx.path, fs = ctx.fs, spawn = ctx.spawn;

    var texts = batch.map(function (c) {
      return String(c.textOriginal == null ? c.text : c.textOriginal);
    });

    var tmpIn  = path.join(os.tmpdir(), '.pulse_aitrans_in.json');
    var tmpOut = path.join(os.tmpdir(), '.pulse_aitrans_out.json');

    var bodyObj = {
      model:           MODEL,
      response_format: { type: 'json_object' },
      temperature:     0,
      messages: [
        { role: 'system', content: _systemPrompt(ctx.langName) },
        { role: 'user',   content:
          'Translate these ' + texts.length + ' captions into ' + ctx.langName +
          '. Return {"translations":[...]} with exactly ' + texts.length +
          ' strings, same order.\nCaptions: ' + JSON.stringify(texts) }
      ]
    };

    // A spawned process can emit BOTH 'error' and 'close', and every failure
    // branch below routes through here — so without this guard one batch could
    // advance the chain twice, calling onDone twice with different counts. That
    // showed up as a caption set that translated correctly AND an "it failed"
    // toast from the same click.
    var finished = false;
    function done(reason) {
      if (finished) return;
      finished = true;
      if (reason) {
        ctx.lastError = reason;
        console.warn('[AITranslate] batch kept source language:', reason);
      }
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
      '--max-time', '90',
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
      if (!parsed || !Array.isArray(parsed.translations)) { done('no translations array'); return; }

      // A count mismatch means the model merged or split captions — applying it
      // positionally would slide every later caption onto the wrong timecode,
      // so the whole batch is rejected instead.
      if (parsed.translations.length !== batch.length) {
        done('count mismatch: got ' + parsed.translations.length + ' for ' + batch.length);
        return;
      }

      for (var i = 0; i < batch.length; i++) {
        var v = parsed.translations[i];
        if (typeof v !== 'string') continue;
        v = v.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
        if (!v) continue;

        batch[i].text           = v;
        batch[i].words          = _estimateWords(batch[i]);
        batch[i].wordsEstimated = true;
        batch[i].translatedTo   = ctx.targetCode;
        ctx.translated++;
      }
      done(null);
    });
  }

  return {
    translate: translate,
    restore:   restore,
    targets:   TARGETS,
    targetName: targetName
  };

})();
