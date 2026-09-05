/**
 * pulse-batch-api.js — Smallest AI Pulse Batch Transcription
 *
 * Uses curl via child_process.spawn for robust raw-byte uploads.
 * This bypasses CEP Chromium's XHR quirks that silently ignore
 * language parameters on non-English transcriptions.
 *
 * Request (raw bytes, NOT multipart):
 * ───────────────────────────────────
 *   POST https://api.smallest.ai/waves/v1/stt/?model=pulse&language=hi&word_timestamps=true
 *   --data-binary @/path/to/audio.wav
 *   -H "Authorization: Bearer <key>"
 *   -H "Content-Type: application/octet-stream"
 *
 * Response shapes handled:
 *   { words: [{word,start,end}] }
 *   { segments: [{start,end,text,words?}] }
 *   { word_timestamps: [{word,start,end}] }
 *   { job_id: "…" }  → polls automatically
 */

'use strict';

var PulseBatchAPI = (function() {

  var POLL_MS     = 2500;
  var POLL_MAX    = 240;               // 240 × 2.5 s = 10 min
  var MAX_BUSY_RETRIES = 5;            // 429 (shared-key concurrency) backoff

  // ── Model selection ─────────────────────────────────────────────────
  // pulse-pro is ENGLISH-ONLY (returns 503 for hi, 400 for other langs).
  // pulse is the multilingual model (hi, es, fr, de, ja, zh, ko, ru, it, pt,
  // and the multi-* auto-detect scopes). So: pro for English, pulse for all
  // other languages.
  function modelForLanguage(language) {
    return (language === 'en') ? 'pulse-pro' : 'pulse';
  }

  // ── Constructor ────────────────────────────────────────────────────
  // Takes the runtime config { PROXY_BASE_URL, APP_TOKEN }. All requests go
  // through the proxy server, which attaches the real Pulse key server-side.
  function PulseBatchAPI(config) {
    config = config || {};
    this.baseUrl    = (config.PROXY_BASE_URL || '').replace(/\/+$/, '');
    this.appToken   = config.APP_TOKEN || '';
    this._cancelled = false;
    this._curlProc  = null;
    this._pollTimer = null;
    this._retryTimer = null;
  }

  // ── transcribe ─────────────────────────────────────────────────────
  // _attempt tracks 429 back-off retries (internal; callers omit it).
  PulseBatchAPI.prototype.transcribe = function(audioFilePath, language, callbacks, _modelOverride, _attempt) {
    var self = this;
    self._cancelled = false;
    var attempt = _attempt || 0;

    // pulse-pro for English, pulse for everything else. _modelOverride lets
    // the 503 fallback below force 'pulse' on a retry.
    var model = _modelOverride || modelForLanguage(language);

    var onProgress = callbacks.onProgress || function() {};
    var onFinal    = callbacks.onFinal    || function() {};
    var onError    = callbacks.onError    || function() {};

    // ── 1. Verify audio file exists ─────────────────────────────────
    var fs, os, path, spawn;
    try {
      fs    = require('fs');
      os    = require('os');
      path  = require('path');
      spawn = require('child_process').spawn;
    } catch (e) {
      onError('Node modules unavailable: ' + e.message);
      return;
    }

    if (!fs.existsSync(audioFilePath)) {
      onError('Audio file not found: ' + audioFilePath);
      return;
    }

    var sizeMB = (fs.statSync(audioFilePath).size / 1048576).toFixed(2);
    console.log('[BatchAPI] Audio file:', audioFilePath, '(' + sizeMB + ' MB)');

    onProgress({ pct: 2, label: 'Starting upload (' + sizeMB + ' MB)…' });

    // ── 2. Resolve curl path ────────────────────────────────────────
    var platform = os.platform();
    var curlPath = platform === 'win32' ? 'curl' : '/usr/bin/curl';

    // ── 3. Temp file for response ───────────────────────────────────
    var tmpOut = path.join(os.tmpdir(), '.pulse_stt_response.json');

    // ── 4. Build URL with query parameters ──────────────────────────
    // The Pulse STT REST API takes model, language and word_timestamps
    // as query string parameters; the audio is the raw request body.
    var qs = '?model=' + encodeURIComponent(model) +
             '&language=' + encodeURIComponent(language) +
             '&word_timestamps=true';
    var url = self.baseUrl + '/api/stt' + qs;

    console.log('[BatchAPI] model=' + model + ' language=' + language);

    // ── 5. Build curl args ──────────────────────────────────────────
    // Uploads the WAV as raw bytes (--data-binary) with
    // Content-Type: application/octet-stream — the documented Smallest AI
    // pre-recorded format. (Multipart/form-data is NOT accepted and the
    // server silently returns {"status":"success"} with no words.)
    var curlArgs = [
      '-s',                                        // silent (no progress meter)
      '-X', 'POST',
      url,
      '-H', 'Content-Type: application/octet-stream',
      '--data-binary', '@' + audioFilePath,         // raw audio bytes from disk
      '-o', tmpOut,                                 // write response body to file
      '-w', '%{http_code}',                         // print HTTP status to stdout
      '--max-time', '600',                          // 10-minute timeout
      '--connect-timeout', '15'
    ];
    if (self.appToken) curlArgs.push('-H', 'x-app-token: ' + self.appToken);

    console.log('[BatchAPI] curl', curlPath,
      '| url=' + url,
      '| file=' + audioFilePath);

    // ── 5. Spawn curl ───────────────────────────────────────────────
    try {
      self._curlProc = spawn(curlPath, curlArgs);
    } catch (e) {
      onError('Failed to spawn curl: ' + e.message);
      return;
    }

    var httpCode = '';
    var curlStderr = '';

    // Show upload progress (curl -s doesn't give granular upload %, so estimate)
    var progressTimer = setInterval(function() {
      if (self._cancelled) { clearInterval(progressTimer); return; }
      // Simple time-based progress estimate
      var currentPct = parseInt(onProgress._lastPct || '5', 10);
      if (currentPct < 55) {
        currentPct += 3;
        onProgress._lastPct = currentPct;
        onProgress({ pct: currentPct, label: 'Uploading audio…' });
      }
    }, 800);
    onProgress._lastPct = 5;

    self._curlProc.stdout.on('data', function(d) {
      httpCode += d.toString().trim();
    });
    self._curlProc.stderr.on('data', function(d) {
      curlStderr += d.toString();
    });

    self._curlProc.on('error', function(e) {
      clearInterval(progressTimer);
      self._curlProc = null;
      if (!self._cancelled) {
        onError('curl process error: ' + e.message +
          '. Make sure curl is installed.');
      }
    });

    self._curlProc.on('close', function(exitCode) {
      clearInterval(progressTimer);
      self._curlProc = null;
      if (self._cancelled) return;

      var status = parseInt(httpCode, 10) || 0;
      console.log('[BatchAPI] curl exit=' + exitCode +
        ', HTTP=' + status +
        ', stderr=' + (curlStderr || '(none)').substring(0, 100));

      // ── Write debug file to Desktop ─────────────────────────────
      try {
        var respBody = '';
        try { respBody = fs.readFileSync(tmpOut, 'utf8'); } catch (e2) {}
        var debugLines = [
          '=== Pulse Captions STT Debug ===',
          'Time    : ' + new Date().toISOString(),
          'curl    : ' + curlPath,
          'exitCode: ' + exitCode,
          'HTTP    : ' + status,
          'language: ' + language,
          'file    : ' + audioFilePath,
          'stderr  : ' + (curlStderr || '(none)'),
          'body    : ' + (respBody || '(empty)').substring(0, 1000),
          '================================'
        ].join('\n');
        fs.writeFileSync(
          path.join(os.homedir(), 'Desktop', 'pulse_stt_debug.txt'),
          debugLines, 'utf8'
        );
      } catch (logErr) {}

      // ── Handle curl/network errors ──────────────────────────────
      if (exitCode !== 0 && status === 0) {
        try { fs.unlinkSync(tmpOut); } catch (e) {}
        onError('Network error (curl exit ' + exitCode + '). ' +
          'Check internet connection.');
        return;
      }

      // ── Read response ───────────────────────────────────────────
      var respStr;
      try {
        respStr = fs.readFileSync(tmpOut, 'utf8');
        fs.unlinkSync(tmpOut);
      } catch (e) {
        onError('Could not read API response file: ' + e.message);
        return;
      }

      // ── Handle HTTP errors ──────────────────────────────────────
      if (status === 401 || status === 403) {
        onError('Authentication failed (HTTP ' + status + '). Check the app token / proxy configuration.');
        return;
      }
      if (status === 413) {
        onError('File too large (HTTP 413). Try a shorter clip.');
        return;
      }
      // pulse-pro is English-only and 503s on other languages. If we somehow
      // hit a 503 on pulse-pro, retry once with the multilingual pulse model.
      if (status === 503 && model === 'pulse-pro') {
        console.warn('[BatchAPI] pulse-pro 503 — retrying with pulse');
        onProgress({ pct: 30, label: 'Retrying with standard model…' });
        self.transcribe(audioFilePath, language, callbacks, 'pulse', attempt);
        return;
      }
      // Concurrency / rate limit (429): the shared proxy key is busy — likely
      // another user is transcribing. Back off and retry a few times before
      // surfacing an error, with exponential delay (2s, 4s, 8s, 16s, 20s).
      if (status === 429) {
        if (attempt < MAX_BUSY_RETRIES) {
          var waitMs = Math.min(2000 * Math.pow(2, attempt), 20000);
          var waitS  = Math.round(waitMs / 1000);
          console.warn('[BatchAPI] 429 busy — retry ' + (attempt + 1) + '/' + MAX_BUSY_RETRIES + ' in ' + waitS + 's');
          onProgress({ pct: 10, label: 'Server busy — retrying in ' + waitS + 's…' });
          self._retryTimer = setTimeout(function() {
            self._retryTimer = null;
            if (self._cancelled) return;
            self.transcribe(audioFilePath, language, callbacks, _modelOverride, attempt + 1);
          }, waitMs);
          return;
        }
        onError('Server is busy (too many transcriptions at once). Please try again in a minute.');
        return;
      }
      if (status >= 400) {
        onError('API error HTTP ' + status + ': ' +
          respStr.substring(0, 200));
        return;
      }

      // ── Parse JSON ──────────────────────────────────────────────
      var data;
      try {
        data = JSON.parse(respStr);
      } catch (e) {
        onError('Could not parse API response: ' +
          respStr.substring(0, 150));
        return;
      }

      onProgress({ pct: 88, label: 'Parsing timestamps…' });
      self._handleResponse(data, onProgress, onFinal, onError);
    });
  };

  // ── _handleResponse ────────────────────────────────────────────────
  PulseBatchAPI.prototype._handleResponse = function(data, onProgress, onFinal, onError) {
    var self = this;

    // Full debug dump — check DevTools console after first run
    console.log('[BatchAPI] ══════════ RESPONSE ══════════');
    console.log('[BatchAPI] Keys:', Object.keys(data).join(', '));
    console.log('[BatchAPI] JSON (first 2000):', JSON.stringify(data).substring(0, 2000));
    if (Array.isArray(data.words)           && data.words.length)
      console.log('[BatchAPI] words[0]:', JSON.stringify(data.words[0]));
    if (Array.isArray(data.segments)        && data.segments.length)
      console.log('[BatchAPI] segments[0]:', JSON.stringify(data.segments[0]));
    if (Array.isArray(data.word_timestamps) && data.word_timestamps.length)
      console.log('[BatchAPI] word_timestamps[0]:', JSON.stringify(data.word_timestamps[0]));
    console.log('[BatchAPI] ════════════════════════════════');

    // Async job → poll (only if there's a job_id to track)
    var jobId = data.job_id || data.id || data.request_id;
    if (jobId && !data.words && !data.segments && !data.word_timestamps) {
      console.log('[BatchAPI] Async job:', jobId);
      onProgress({ pct: 65, label: 'Job queued — processing on server…' });
      self._pollJob(jobId, onProgress, onFinal, onError);
      return;
    }

    // status:success but no transcript data at all
    if (data.status === 'success' && !data.words && !data.segments && !data.word_timestamps) {
      var hint = data.transcription ? ' (transcription: "' + data.transcription.substring(0, 80) + '")' : '';
      onError('API returned success but no word timestamps.' + hint +
        ' Check audio format or language setting.');
      return;
    }

    self._deliverResult(data, onFinal, onError);
  };

  // ── _pollJob ────────────────────────────────────────────────────────
  PulseBatchAPI.prototype._pollJob = function(jobId, onProgress, onFinal, onError) {
    var self  = this;
    var tries = 0;

    // Poll through the proxy
    var pollUrl = self.baseUrl + '/api/stt/jobs/' + jobId;

    self._pollTimer = setInterval(function() {
      if (self._cancelled) { clearInterval(self._pollTimer); return; }
      if (++tries > POLL_MAX) {
        clearInterval(self._pollTimer);
        onError('Transcription timed out (10 min). Try a shorter clip.');
        return;
      }

      var elapsed = Math.round(tries * POLL_MS / 1000);
      var pct     = Math.min(87, 65 + tries);
      onProgress({ pct: pct, label: 'Processing on server… (' + elapsed + 's)' });

      var px = new XMLHttpRequest();
      px.open('GET', pollUrl, true);
      if (self.appToken) px.setRequestHeader('x-app-token', self.appToken);
      px.responseType = 'text';
      px.onload = function() {
        if (self._cancelled) return;
        try {
          var d      = JSON.parse(px.responseText);
          var status = (d.status || d.state || '').toLowerCase();
          if (status === 'completed' || status === 'done' || status === 'finished' ||
              d.words || d.segments || d.word_timestamps) {
            clearInterval(self._pollTimer);
            self._deliverResult(d, onFinal, onError);
          } else if (status === 'failed' || status === 'error') {
            clearInterval(self._pollTimer);
            onError('Job failed: ' + (d.error || d.message || status));
          }
        } catch (e) { /* transient parse error — retry */ }
      };
      px.onerror = function() {};
      px.send();

    }, POLL_MS);
  };

  // ── _deliverResult ──────────────────────────────────────────────────
  PulseBatchAPI.prototype._deliverResult = function(data, onFinal, onError) {
    var words = [];

    // Shape A (Pulse REST API): { status:"success", transcription:"…", words:[{word,start,end}] }
    // Also handles plain { words: [...] } without status field
    if (Array.isArray(data.words)) {
      if (data.words.length > 0 && typeof data.words[0] === 'object') {
        data.words.forEach(function(w) {
          words.push({
            word:  w.word  || w.text  || '',
            start: w.start !== undefined ? w.start : (w.start_time || 0),
            end:   w.end   !== undefined ? w.end   : (w.end_time   || 0)
          });
        });
      }

    // Shape B: { segments: [{start,end,text,words?}] }
    } else if (Array.isArray(data.segments)) {
      if (data.segments.length > 0) {
        data.segments.forEach(function(seg) {
          if (Array.isArray(seg.words) && seg.words.length > 0) {
            seg.words.forEach(function(w) {
              words.push({
                word:  w.word  || w.text  || '',
                start: w.start !== undefined ? w.start : (w.start_time || seg.start || 0),
                end:   w.end   !== undefined ? w.end   : (w.end_time   || seg.end   || 0)
              });
            });
          } else {
            // Segment only — distribute evenly
            var raw  = (seg.text || '').trim().split(/\s+/).filter(Boolean);
            if (!raw.length) return;
            var step = ((seg.end || 0) - (seg.start || 0)) / raw.length;
            raw.forEach(function(word, i) {
              words.push({
                word:  word,
                start: (seg.start || 0) + i * step,
                end:   (seg.start || 0) + (i + 1) * step
              });
            });
          }
        });
      }

    // Shape C: { word_timestamps: [{word,start,end}] }
    } else if (Array.isArray(data.word_timestamps)) {
      if (data.word_timestamps.length > 0) {
        data.word_timestamps.forEach(function(w) {
          words.push({
            word:  w.word  || w.text  || '',
            start: w.start !== undefined ? w.start : (w.start_time || 0),
            end:   w.end   !== undefined ? w.end   : (w.end_time   || 0)
          });
        });
      }

    } else {
      var raw = JSON.stringify(data);
      console.error('[BatchAPI] Unknown shape. Keys:', Object.keys(data).join(', '));
      console.error('[BatchAPI] Full raw response:', raw);
      // Show the raw JSON directly in the panel so no DevTools needed
      onError('Unknown format. Keys: [' + Object.keys(data).join(', ') + '] — Raw: ' + raw.substring(0, 300));
      return;
    }

    if (words.length === 0) {
      onError('No words in transcript. Check language setting or audio content.');
      return;
    }

    var transcript = data.transcription || data.transcript || data.text ||
      words.map(function(w) { return w.word; }).join(' ');

    // Which language Pulse decided on. Only present when it tells us — the
    // auto-detect scopes (multi-indic / multi-eu / multi-asian) are the case
    // that matters, since there the caller doesn't know either. Field name
    // varies by response shape, so check the plausible spots.
    var detected = data.language || data.detected_language ||
      (data.metadata && (data.metadata.language || data.metadata.detected_language)) || '';

    console.log('[BatchAPI] ✓', words.length, 'words,',
      words[words.length - 1].end.toFixed(2) + 's duration',
      detected ? ('| detected=' + detected) : '');

    onFinal({ transcript: transcript, words: words, language: detected });
  };

  // ── cancel ──────────────────────────────────────────────────────────
  PulseBatchAPI.prototype.cancel = function() {
    this._cancelled = true;
    if (this._pollTimer)  { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._curlProc)   { try { this._curlProc.kill('SIGKILL'); } catch (e) {} this._curlProc = null; }
  };

  return PulseBatchAPI;
})();
