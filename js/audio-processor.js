/**
 * audio-processor.js — ffmpeg-based audio extractor
 *
 * Extracts PCM16LE 16kHz mono audio from any media file
 * and streams it as Node.js Buffers for the Pulse WebSocket.
 *
 * Depends on: ffmpeg-static (npm) or system ffmpeg fallback.
 */

'use strict';

var AudioProcessor = (function() {

  // ── Constructor ────────────────────────────────────────────────────
  function AudioProcessor() {
    this.process     = null;
    this.isCancelled = false;
  }

  // ── getFfmpegPath ─────────────────────────────────────────────────
  // Prefer the vendored binary that matches THIS machine's platform+arch
  // (shipped under ffmpeg-bin/<platform>-<arch>/), so one .zxp works on
  // Apple Silicon Mac, Intel Mac, and Windows. Falls back to ffmpeg-static,
  // then a system ffmpeg on PATH.
  AudioProcessor.prototype.getFfmpegPath = function() {
    var os = require('os');
    var platform = os.platform();              // 'darwin' | 'win32'
    var arch     = os.arch();                  // 'arm64' | 'x64'

    // 1. Vendored binary inside the extension
    try {
      var path = require('path');
      var fs   = require('fs');
      var extRoot = '';
      try { extRoot = csInterface.getSystemPath(SystemPath.EXTENSION); } catch (e) {}
      if (extRoot) {
        var exe  = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        var candidates = [platform + '-' + arch];
        // On Apple Silicon, fall back to the x64 build (runs via Rosetta) if
        // the arm64 one is somehow missing.
        if (platform === 'darwin' && arch === 'arm64') candidates.push('darwin-x64');
        for (var i = 0; i < candidates.length; i++) {
          var p = path.join(extRoot, 'ffmpeg-bin', candidates[i], exe);
          if (fs.existsSync(p)) {
            if (platform !== 'win32') { try { fs.chmodSync(p, 0o755); } catch (e) {} }
            if (platform === 'darwin') this.unquarantine(p);
            console.log('[Audio] Using vendored ffmpeg:', p);
            return p;
          }
        }
      }
    } catch (e) { /* fall through */ }

    // 2. ffmpeg-static (dev / npm-installed)
    try {
      var ffmpegStatic = require('ffmpeg-static');
      if (ffmpegStatic) {
        console.log('[Audio] Using ffmpeg-static:', ffmpegStatic);
        return ffmpegStatic;
      }
    } catch (e) { /* not installed */ }

    // 3. Fall back to system PATH
    var fallback = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    console.log('[Audio] Falling back to system ffmpeg:', fallback);
    return fallback;
  };

  // ── unquarantine ─────────────────────────────────────────────────
  /**
   * macOS Gatekeeper self-heal. When the .zxp is installed, the bundled
   * ffmpeg picks up a `com.apple.quarantine` xattr; because the binary
   * isn't Apple-notarised, the first spawn is blocked until the user
   * manually clicks "Open Anyway" in System Settings → Privacy & Security.
   *
   * Stripping the quarantine xattr (and applying an ad-hoc signature)
   * lets it run silently. The binary lives in the user's own extensions
   * folder, so no admin rights are needed. Runs at most once per binary.
   */
  AudioProcessor.prototype.unquarantine = function(binPath) {
    if (this._unquarantined && this._unquarantined[binPath]) return;
    if (!this._unquarantined) this._unquarantined = {};
    this._unquarantined[binPath] = true;
    try {
      var execSync = require('child_process').execSync;
      var q = '"' + binPath.replace(/"/g, '\\"') + '"';
      // Remove the quarantine flag (recursively, ignore "not found").
      try { execSync('xattr -d com.apple.quarantine ' + q + ' 2>/dev/null'); } catch (e) {}
      // Ad-hoc sign so Gatekeeper has a valid (if unidentified) signature.
      try { execSync('codesign --force --sign - ' + q + ' 2>/dev/null'); } catch (e) {}
      console.log('[Audio] Cleared quarantine on vendored ffmpeg:', binPath);
    } catch (e) {
      console.warn('[Audio] unquarantine skipped:', e.message);
    }
  };

  // ── extractAudio ─────────────────────────────────────────────────
  /**
   * Spawn ffmpeg to extract audio as PCM16LE 16kHz mono and stream it.
   *
   * @param {string}   inputFile  - Absolute path to media file
   * @param {number}   startTime  - Start offset in seconds (0 = beginning)
   * @param {number}   endTime    - End offset in seconds   (0 = full file)
   * @param {function} onChunk    - Called with each Buffer chunk
   * @param {function} onDone     - Called when extraction finishes cleanly
   * @param {function} onError    - Called with error message string
   */
  AudioProcessor.prototype.extractAudio = function(inputFile, startTime, endTime, onChunk, onDone, onError) {
    var self = this;
    self.isCancelled = false;

    var ffmpegPath = self.getFfmpegPath();
    var spawn;
    try {
      spawn = require('child_process').spawn;
    } catch (e) {
      onError('child_process unavailable. Enable Node.js in manifest.');
      return;
    }

    // Build argument list
    var args = [];

    // Seek BEFORE input for fast seeking (keyframe accuracy)
    if (startTime > 0) {
      args.push('-ss', String(startTime));
    }

    args.push('-i', inputFile);

    // Duration to extract
    if (endTime > 0 && endTime > startTime) {
      args.push('-t', String(endTime - startTime));
    }

    args.push(
      '-vn',              // No video
      '-ar', '16000',     // 16 kHz sample rate
      '-ac', '1',         // Mono
      '-acodec', 'pcm_s16le',
      '-f', 's16le',      // Raw signed 16-bit little-endian PCM
      'pipe:1'            // Pipe to stdout
    );

    console.log('[Audio] ffmpeg args:', args.join(' '));

    try {
      self.process = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      onError('Failed to spawn ffmpeg: ' + e.message + '. Install ffmpeg or run npm install in plugin folder.');
      return;
    }

    var totalBytes = 0;

    self.process.stdout.on('data', function(chunk) {
      if (self.isCancelled) return;
      totalBytes += chunk.length;
      onChunk(chunk);
    });

    self.process.stderr.on('data', function(data) {
      // ffmpeg uses stderr for progress/info — only log warnings
      var line = data.toString();
      if (line.indexOf('Error') >= 0 || line.indexOf('error') >= 0) {
        console.warn('[ffmpeg stderr]', line.substring(0, 200));
      }
    });

    self.process.on('close', function(code) {
      self.process = null;
      if (self.isCancelled) return;

      console.log('[Audio] ffmpeg exited with code', code, '| bytes streamed:', totalBytes);

      if (code === 0 || code === null) {
        onDone(totalBytes);
      } else if (code === 1 && totalBytes > 0) {
        // ffmpeg sometimes exits 1 but has already produced valid output
        console.warn('[Audio] ffmpeg non-zero exit but bytes were produced — treating as success');
        onDone(totalBytes);
      } else {
        onError('ffmpeg exited with code ' + code + '. File may be unsupported or path is incorrect.');
      }
    });

    self.process.on('error', function(err) {
      self.process = null;
      if (self.isCancelled) return;
      onError('ffmpeg process error: ' + err.message);
    });
  };

  // ── cancel ────────────────────────────────────────────────────────
  AudioProcessor.prototype.cancel = function() {
    this.isCancelled = true;
    if (this.process) {
      try { this.process.kill('SIGKILL'); } catch (e) {}
      this.process = null;
    }
  };

  // ── extractAudioToFile ────────────────────────────────────────────
  /**
   * Run ffmpeg and write raw PCM16LE 16 kHz mono to a file.
   * The output has NO WAV header — pure signed-16-bit little-endian samples.
   * This matches the Pulse batch API's expected encoding=linear16 format.
   *
   * @param {string}   inputFile   Media file to read
   * @param {number}   startTime   Clip start (seconds)
   * @param {number}   endTime     Clip end (seconds, 0 = full file)
   * @param {string}   outputFile  Destination path (e.g. ~/.pulse_captions_temp.pcm)
   * @param {function} onProgress  (pct: 0-100) — called periodically
   * @param {function} onDone      () — called on clean exit
   * @param {function} onError     (msg: string)
   */
  AudioProcessor.prototype.extractAudioToFile = function(
      inputFile, startTime, endTime, outputFile, onProgress, onDone, onError) {
    var self = this;
    self.isCancelled = false;

    var ffmpegPath = self.getFfmpegPath();
    var spawn;
    try { spawn = require('child_process').spawn; }
    catch (e) { onError('child_process unavailable.'); return; }

    var args = [];
    if (startTime > 0) args.push('-ss', String(startTime));
    args.push('-i', inputFile);
    if (endTime > 0 && endTime > startTime) args.push('-t', String(endTime - startTime));
    args.push(
      '-vn',                // strip video
      '-ar', '16000',       // 16 kHz
      '-ac', '1',           // mono
      '-acodec', 'pcm_s16le', // 16-bit PCM codec
      '-f', 'wav',          // WAV container (REST API requires header)
      '-y',                 // overwrite without prompting
      outputFile
    );

    console.log('[Audio→File] ffmpeg args:', args.join(' '));
    onProgress(5);

    try {
      self.process = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      onError('Failed to spawn ffmpeg: ' + e.message);
      return;
    }

    // Parse ffmpeg stderr for duration + time progress
    var totalDuration = endTime > startTime ? endTime - startTime : 0;

    self.process.stderr.on('data', function(data) {
      var line = data.toString();

      // Extract duration from "Duration: HH:MM:SS.xx"
      if (totalDuration === 0) {
        var dm = line.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        if (dm) {
          totalDuration = parseInt(dm[1]) * 3600 + parseInt(dm[2]) * 60 + parseFloat(dm[3]);
        }
      }

      // Extract current time from "time=HH:MM:SS.xx"
      var tm = line.match(/time=\s*(\d+):(\d+):([\d.]+)/);
      if (tm && totalDuration > 0) {
        var current = parseInt(tm[1]) * 3600 + parseInt(tm[2]) * 60 + parseFloat(tm[3]);
        var pct = Math.min(95, 5 + Math.round((current / totalDuration) * 90));
        onProgress(pct);
      }

      if (line.toLowerCase().indexOf('error') >= 0) {
        console.warn('[ffmpeg stderr]', line.substring(0, 200));
      }
    });

    self.process.on('close', function(code) {
      self.process = null;
      if (self.isCancelled) return;
      if (code === 0 || code === null) {
        onProgress(100);
        onDone();
      } else {
        onError('ffmpeg exited with code ' + code + '. File may be unsupported or path incorrect.');
      }
    });

    self.process.on('error', function(err) {
      self.process = null;
      if (self.isCancelled) return;
      onError('ffmpeg error: ' + err.message);
    });
  };

  // ── extractSequenceAudioToFile ────────────────────────────────────
  /**
   * Extracts audio from multiple source clips (each with its own source
   * in/out points) and concatenates them into a single WAV file.
   *
   * Uses ffmpeg's filter_complex concat — one process, no temp files.
   *
   * @param {Array}    clips        [{mediaPath, startTime, endTime, timelineStart}]
   * @param {string}   outputFile   Destination WAV path
   * @param {function} onProgress   (pct: 0-100)
   * @param {function} onDone       ()
   * @param {function} onError      (msg: string)
   */
  AudioProcessor.prototype.extractSequenceAudioToFile = function(
      clips, outputFile, onProgress, onDone, onError) {
    var self = this;
    self.isCancelled = false;

    if (!clips || clips.length === 0) {
      onError('No clips to extract.');
      return;
    }

    // Single clip — reuse existing method
    if (clips.length === 1) {
      return self.extractAudioToFile(
        clips[0].mediaPath, clips[0].startTime, clips[0].endTime,
        outputFile, onProgress, onDone, onError
      );
    }

    var ffmpegPath = self.getFfmpegPath();
    var spawn;
    try { spawn = require('child_process').spawn; }
    catch (e) { onError('child_process unavailable.'); return; }

    // ── Build args ─────────────────────────────────────────────────
    // For each clip:  -ss <sourceIn> -t <duration> -i <file>
    // Then filter_complex concat to stitch them seamlessly.
    var args = [];
    var totalExpectedDuration = 0;

    clips.forEach(function(clip) {
      var dur = (clip.endTime || 0) - (clip.startTime || 0);
      if (dur <= 0) dur = 0;
      totalExpectedDuration += dur;

      if (clip.startTime > 0) args.push('-ss', String(clip.startTime));
      if (dur > 0)            args.push('-t',  String(dur));
      args.push('-i', clip.mediaPath);
    });

    // filter_complex: [0:a:0][1:a:0]...concat=n=N:v=0:a=1[aout]
    var filterIn  = clips.map(function(_, idx) { return '[' + idx + ':a:0]'; }).join('');
    var filterStr = filterIn + 'concat=n=' + clips.length + ':v=0:a=1[aout]';
    args.push('-filter_complex', filterStr);
    args.push('-map', '[aout]');
    args.push('-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le', '-f', 'wav', '-y', outputFile);

    console.log('[Seq→File] ' + clips.length + ' clips | total ~' +
      totalExpectedDuration.toFixed(1) + 's | ffmpeg args:', args.slice(0, 14).join(' ') + '...');

    onProgress(5);

    try {
      self.process = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      onError('Failed to spawn ffmpeg: ' + e.message);
      return;
    }

    self.process.stderr.on('data', function(data) {
      var line = data.toString();
      var tm = line.match(/time=\s*(\d+):(\d+):([\d.]+)/);
      if (tm && totalExpectedDuration > 0) {
        var current = parseInt(tm[1]) * 3600 + parseInt(tm[2]) * 60 + parseFloat(tm[3]);
        var pct = Math.min(95, 5 + Math.round((current / totalExpectedDuration) * 90));
        onProgress(pct);
      }
      if (line.toLowerCase().indexOf('error') >= 0) {
        console.warn('[ffmpeg seq stderr]', line.substring(0, 200));
      }
    });

    self.process.on('close', function(code) {
      self.process = null;
      if (self.isCancelled) return;
      if (code === 0 || code === null) {
        onProgress(100);
        onDone();
      } else {
        onError('ffmpeg concat exited with code ' + code + '.');
      }
    });

    self.process.on('error', function(err) {
      self.process = null;
      if (self.isCancelled) return;
      onError('ffmpeg concat error: ' + err.message);
    });
  };

  // ── getFileDuration ───────────────────────────────────────────────
  /**
   * Use ffprobe to read the duration of a media file.
   * Calls back with (err, durationSeconds).
   */
  AudioProcessor.prototype.getFileDuration = function(filePath, callback) {
    var ffmpegPath = this.getFfmpegPath();
    // Derive ffprobe path from ffmpeg path
    var ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');

    var spawn = require('child_process').spawn;
    var proc;
    try {
      proc = spawn(ffprobePath, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        filePath
      ]);
    } catch (e) {
      callback(e, 0);
      return;
    }

    var out = '';
    proc.stdout.on('data', function(d) { out += d.toString(); });
    proc.on('close', function() {
      try {
        var info = JSON.parse(out);
        var dur  = parseFloat((info.format || {}).duration) || 0;
        callback(null, dur);
      } catch (e) {
        callback(e, 0);
      }
    });
    proc.on('error', function(e) { callback(e, 0); });
  };

  return AudioProcessor;
})();
