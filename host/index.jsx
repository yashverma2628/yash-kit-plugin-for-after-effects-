/**
 * host/index.jsx  —  ExtendScript entry point
 * Supports Premiere Pro (PPRO) and After Effects (AEFT)
 *
 * NOTE: ExtendScript is ES3 — no arrow functions, const/let, template literals,
 *       or Array methods beyond basic ones. Use var and for-loops throughout.
 */

// ═══════════════════════════════════════════════════════════════════
//  JSON POLYFILL
//  After Effects' ExtendScript has a native JSON object; Premiere Pro's
//  does NOT. Every host response is built with JSON.stringify, so without
//  this the first call throws "ReferenceError: JSON is undefined" and CEP
//  returns the generic "EvalScript error." string. Guarded so AE keeps its
//  native implementation untouched.
// ═══════════════════════════════════════════════════════════════════
if (typeof JSON !== 'object') { JSON = {}; }
(function () {
    var escapable = /[\u0000-\u001f\u007f-\u009f"\\]/g;
    var meta = {
        '\b': '\\b', '\t': '\\t', '\n': '\\n',
        '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\'
    };
    function quote(string) {
        escapable.lastIndex = 0;
        return '"' + String(string).replace(escapable, function (a) {
            var c = meta[a];
            return typeof c === 'string'
                ? c
                : '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
    }
    function str(value) {
        if (value === null || value === undefined) { return 'null'; }
        var t = typeof value, i, partial, k, v;
        if (t === 'number')  { return isFinite(value) ? String(value) : 'null'; }
        if (t === 'boolean') { return String(value); }
        if (t === 'string')  { return quote(value); }
        if (t === 'object') {
            partial = [];
            if (Object.prototype.toString.call(value) === '[object Array]') {
                for (i = 0; i < value.length; i += 1) { partial[i] = str(value[i]) || 'null'; }
                return '[' + partial.join(',') + ']';
            }
            for (k in value) {
                if (value.hasOwnProperty(k)) {
                    v = str(value[k]);
                    if (v) { partial.push(quote(k) + ':' + v); }
                }
            }
            return '{' + partial.join(',') + '}';
        }
        return undefined;
    }
    if (typeof JSON.stringify !== 'function') {
        JSON.stringify = function (value) { return str(value); };
    }
    if (typeof JSON.parse !== 'function') {
        JSON.parse = function (text) { return eval('(' + String(text) + ')'); };
    }
}());

// ═══════════════════════════════════════════════════════════════════
//  PRIVATE JSON  (do not use the ambient JSON object for output!)
//  BOTH hosts run CEP panels and user scripts in a shared ExtendScript
//  world. Even in After Effects — where a native JSON exists — a third-
//  party script/extension can replace JSON with a broken shim or add a
//  global Object.prototype.toJSON, after which the ambient JSON.stringify
//  emits garbage like "{:;;;;;;;}" (structure kept, keys/values dropped)
//  and the panel fails with "Unexpected clip-info response". Seen in the
//  wild in AE with other script panels installed. These private functions
//  never consult toJSON, use hasOwnProperty, and are ours alone — no
//  third-party code can poison our serialization.
// ═══════════════════════════════════════════════════════════════════
function _ckStringify(value) {
    var escapable = /[\u0000-\u001f\u007f-\u009f"\\]/g;
    var meta = {
        '\b': '\\b', '\t': '\\t', '\n': '\\n',
        '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\'
    };
    function quote(string) {
        escapable.lastIndex = 0;
        return '"' + String(string).replace(escapable, function (a) {
            var c = meta[a];
            return typeof c === 'string'
                ? c
                : '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
    }
    function str(v) {
        if (v === null || v === undefined) { return 'null'; }
        var t = typeof v, i, partial, k, s;
        if (t === 'number')  { return isFinite(v) ? String(v) : 'null'; }
        if (t === 'boolean') { return String(v); }
        if (t === 'string')  { return quote(v); }
        if (t === 'object') {
            partial = [];
            if (Object.prototype.toString.call(v) === '[object Array]') {
                for (i = 0; i < v.length; i += 1) { partial[i] = str(v[i]) || 'null'; }
                return '[' + partial.join(',') + ']';
            }
            for (k in v) {
                if (v.hasOwnProperty(k)) {
                    s = str(v[k]);
                    if (s) { partial.push(quote(k) + ':' + s); }
                }
            }
            return '{' + partial.join(',') + '}';
        }
        return undefined;
    }
    return str(value);
}

// Parse is only ever fed files this panel wrote itself, so an eval-based
// parser is safe here and immune to shim breakage.
function _ckParse(text) {
    return eval('(' + String(text) + ')');
}


// ═══════════════════════════════════════════════════════════════════
//  HOST DETECTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Reliably detect which Adobe app we're running inside.
 * app.appId is NOT a valid ExtendScript property — we use
 * BridgeTalk.appName and fallback object-existence checks instead.
 */
function _getAppId() {
    // 1. BridgeTalk — most reliable across all CC versions
    try {
        if (typeof BridgeTalk !== 'undefined' && BridgeTalk.appName) {
            var bt = BridgeTalk.appName.toLowerCase();
            if (bt.indexOf('premiere') >= 0) return 'PPRO';
            if (bt.indexOf('aftereffects') >= 0 || bt.indexOf('after-effects') >= 0) return 'AEFT';
        }
    } catch (e) {}

    // 2. CompItem global — exists only in After Effects ExtendScript
    try { if (typeof CompItem !== 'undefined') return 'AEFT'; } catch (e) {}

    // 3. app.project.sequences — Premiere Pro specific
    try {
        if (app.project && typeof app.project.sequences !== 'undefined') return 'PPRO';
    } catch (e) {}

    // 4. app.name string check
    try {
        if (app.name) {
            var n = app.name.toLowerCase();
            if (n.indexOf('premiere') >= 0) return 'PPRO';
            if (n.indexOf('after effects') >= 0 || n.indexOf('aftereffects') >= 0) return 'AEFT';
        }
    } catch (e) {}

    return 'UNKNOWN';
}

/** Returns JSON string with host app info */
function getHostInfo() {
    var id = _getAppId();
    var info = {
        appId:   id,
        appName: (id === 'PPRO') ? 'Premiere Pro' : (id === 'AEFT') ? 'After Effects' : 'Unknown',
        version: app.version || '0'
    };
    return _ckStringify(info);
}



// ═══════════════════════════════════════════════════════════════════
//  GET CLIP INFO  (called by main.js)
// ═══════════════════════════════════════════════════════════════════

/** Entry point — routes to the right host implementation */
function getClipInfo(scope) {
    var id = _getAppId();
    if (id === 'PPRO') return _getClipInfoPremiere(scope);
    if (id === 'AEFT') return _getClipInfoAE(scope);
    return _ckStringify({ error: 'Unsupported application: ' + id + '. Open this panel inside Premiere Pro or After Effects.' });
}

// ═══════════════════════════════════════════════════════════════════
//  PLAYHEAD  (called by main.js when a transcript line is clicked)
// ═══════════════════════════════════════════════════════════════════

/**
 * Move the host's playhead to `t` seconds so clicking a transcript line jumps
 * the viewer to that caption.
 *   AE   — activeItem.time is in seconds.
 *   PPRO — positions are in ticks (254,016,000,000 per second). The modern
 *          Sequence.setPlayerPosition() wants that number AS A STRING, since
 *          a tick count past ~36s exceeds what a double holds exactly. QE's
 *          setPlayerPosition() is the fallback for older builds.
 * Returns JSON so the panel can tell "seeked" from "no sequence open".
 */
function setPlayhead(t) {
    var secs = parseFloat(t);
    if (isNaN(secs) || secs < 0) secs = 0;

    try {
        var id = _getAppId();

        if (id === 'AEFT') {
            var item = app.project.activeItem;
            if (!item || !(item instanceof CompItem)) {
                return _ckStringify({ success: false, error: 'No active composition.' });
            }
            if (secs > item.duration) secs = item.duration;
            item.time = secs;
            return _ckStringify({ success: true, time: secs });
        }

        if (id === 'PPRO') {
            var TICKS_PER_SECOND = 254016000000;
            var ticks = String(Math.round(secs * TICKS_PER_SECOND));

            var seq = app.project.activeSequence;
            if (seq) {
                try { seq.setPlayerPosition(ticks); return _ckStringify({ success: true, time: secs }); }
                catch (modernErr) { /* fall through to QE */ }
            }

            try { if (app.enableQE) app.enableQE(); } catch (qeErr) {}
            if (typeof qe !== 'undefined' && qe.project && qe.project.getActiveSequence) {
                var qseq = qe.project.getActiveSequence();
                if (qseq) {
                    qseq.setPlayerPosition(ticks);
                    return _ckStringify({ success: true, time: secs });
                }
            }
            return _ckStringify({ success: false, error: 'No active sequence.' });
        }

        return _ckStringify({ success: false, error: 'Unsupported application: ' + id });

    } catch (e) {
        return _ckStringify({ success: false, error: 'setPlayhead: ' + e.toString() });
    }
}


// ═══════════════════════════════════════════════════════════════════
//  FONTS  (After Effects) — enumerate every font installed on this
//  machine so the panel can offer a font picker. Uses the app.fonts API
//  (AE 2022 / v22.0+); returns {supported:false} on older builds, where
//  the panel falls back to the composition's default font.
// ═══════════════════════════════════════════════════════════════════
function getSystemFonts() {
    try {
        if (typeof app === 'undefined' || !app.fonts || !app.fonts.allFonts) {
            return _ckStringify({ supported: false, fonts: [] });
        }
        var all  = app.fonts.allFonts;
        var seen = {};
        var out  = [];
        for (var i = 0; i < all.length; i++) {
            var f = all[i];
            var ps = '', fam = '', st = '';
            try { ps  = f.postScriptName; } catch (e1) {}
            try { fam = f.familyName; }     catch (e2) {}
            try { st  = f.styleName; }      catch (e3) {}
            if (!ps || seen[ps]) continue;
            seen[ps] = 1;
            out.push({ ps: ps, fam: fam || ps, st: st || '' });
        }
        out.sort(function (a, b) {
            var x = (a.fam + ' ' + a.st).toLowerCase();
            var y = (b.fam + ' ' + b.st).toLowerCase();
            return x < y ? -1 : (x > y ? 1 : 0);
        });
        return _ckStringify({ supported: true, fonts: out });
    } catch (e) {
        return _ckStringify({ supported: false, fonts: [], error: String(e) });
    }
}

// ═══════════════════════════════════════════════════════════════════
//  PLACE CAPTIONS  (called by main.js)
// ═══════════════════════════════════════════════════════════════════

/** Entry point — routes to the right host implementation */
function placeCaptions(captionDataStr) {
    var id = _getAppId();
    var data;
    try {
        data = eval('(' + captionDataStr + ')');
    } catch (e) {
        return _ckStringify({ success: false, error: 'JSON parse error: ' + e.toString() });
    }
    if (id === 'PPRO') return _placeCaptionsPremiere(data);
    if (id === 'AEFT') return _placeCaptionsAE(data);
    return _ckStringify({ success: false, error: 'Unsupported application: ' + id });
}



/**
 * Read caption data from a JSON file written by the JS side,
 * then dispatch to the correct host function.
 *
 * This avoids the ~64KB evalScript string-length limit that
 * silently breaks inline JSON passing for large caption sets.
 */
function placeCaptionsFromFile(filePath) {
    try {
        var f = new File(filePath);
        if (!f.exists) {
            return _ckStringify({ success: false, error: 'Temp data file not found: ' + filePath });
        }
        f.encoding = 'UTF-8';
        f.open('r');
        var content = f.read();
        f.close();

        var data = eval('(' + content + ')');
        var id   = _getAppId();
        if (id === 'PPRO') return _placeCaptionsPremiere(data);
        if (id === 'AEFT') return _placeCaptionsAE(data);
        return _ckStringify({ success: false, error: 'Unsupported application: ' + id });
    } catch (e) {
        return _ckStringify({ success: false, error: 'placeCaptionsFromFile: ' + e.toString() });
    }
}


// ═══════════════════════════════════════════════════════════════════
//  PREMIERE PRO  ──  Clip Info
// ═══════════════════════════════════════════════════════════════════

function _getClipInfoPremiere(scope) {
    try {
        if (!app.project || !app.project.activeSequence) {
            return _ckStringify({ error: 'No active sequence. Open a sequence first.' });
        }
        var seq = app.project.activeSequence;

        if (scope === 'selected') {
            var clip = _findSelectedClipPremiere(seq);
            if (!clip) {
                return _ckStringify({ error: 'No clip selected. Click a clip in the timeline, then click Generate.' });
            }
            var mediaPath = '';
            try { mediaPath = clip.projectItem.getMediaPath(); } catch (e) {}

            // clip.inPoint / clip.outPoint are SEQUENCE timeline positions,
            // NOT source file offsets. Use projectItem.getInPoint(0) instead.
            var srcIn  = 0;
            var seqDur = clip.end.seconds - clip.start.seconds;
            try {
                var pi = clip.projectItem;
                if (pi && typeof pi.getInPoint === 'function') {
                    var inPtObj = pi.getInPoint(0); // 0 = seconds mode
                    if (inPtObj && typeof inPtObj.seconds !== 'undefined') {
                        srcIn = Math.max(0, inPtObj.seconds);
                    }
                }
            } catch (e) {}

            // Sequence dimensions + frame rate for animation rendering
            var seqW = 1920, seqH = 1080, seqFps = 30;
            try {
                var ss = seq.getSettings();
                seqW   = ss.videoFrameWidth  || 1920;
                seqH   = ss.videoFrameHeight || 1080;
                if (ss.videoFrameRate && ss.videoFrameRate > 0) {
                    seqFps = ss.videoFrameRate;
                }
            } catch(sse) {}

            return _ckStringify({
                mediaPath:         mediaPath,
                startTime:         srcIn,
                endTime:           srcIn + seqDur,
                timelineStartTime: clip.start.seconds,
                timelineEndTime:   clip.end.seconds,
                name:              clip.name,
                sequenceName:      seq.name,
                seqWidth:          seqW,
                seqHeight:         seqH,
                seqFps:            seqFps
            });

        } else {
            // Full sequence — collect ALL clips from all video tracks,
            // each with their CORRECT source in/out points and timeline position.
            // This handles trimmed clips, multiple clips, and re-ordered edits.
            var seenKeys = {};
            var allClips = [];

            var t2, c2, clip2, mp2, key2, srcIn2, seqDur2, pi2, inPt2;
            for (t2 = 0; t2 < seq.videoTracks.numTracks; t2++) {
                var vt2 = seq.videoTracks[t2];
                for (c2 = 0; c2 < vt2.clips.numItems; c2++) {
                    clip2 = vt2.clips[c2];
                    mp2   = '';
                    try { mp2 = clip2.projectItem.getMediaPath(); } catch (e) {}
                    if (!mp2) continue;

                    // Resolve source in-point (not sequence position)
                    srcIn2  = 0;
                    seqDur2 = clip2.end.seconds - clip2.start.seconds;
                    try {
                        pi2 = clip2.projectItem;
                        if (pi2 && typeof pi2.getInPoint === 'function') {
                            inPt2 = pi2.getInPoint(0);
                            if (inPt2 && typeof inPt2.seconds !== 'undefined') {
                                srcIn2 = Math.max(0, inPt2.seconds);
                            }
                        }
                    } catch (e) {}

                    // Deduplicate on source in/out, not sequence position
                    key2 = mp2 + '|' + srcIn2.toFixed(3) + '|' + (srcIn2 + seqDur2).toFixed(3);
                    if (seenKeys[key2]) continue;
                    seenKeys[key2] = true;

                    allClips.push({
                        mediaPath:     mp2,
                        startTime:     srcIn2,
                        endTime:       srcIn2 + seqDur2,
                        timelineStart: clip2.start.seconds
                    });
                }
            }

            // Fall back to audio tracks if no video clips found
            if (allClips.length === 0) {
                for (t2 = 0; t2 < seq.audioTracks.numTracks; t2++) {
                    var at2 = seq.audioTracks[t2];
                    for (c2 = 0; c2 < at2.clips.numItems; c2++) {
                        clip2 = at2.clips[c2];
                        mp2   = '';
                        try { mp2 = clip2.projectItem.getMediaPath(); } catch (e) {}
                        if (!mp2) continue;

                        // Resolve source in-point
                        srcIn2  = 0;
                        seqDur2 = clip2.end.seconds - clip2.start.seconds;
                        try {
                            pi2 = clip2.projectItem;
                            if (pi2 && typeof pi2.getInPoint === 'function') {
                                inPt2 = pi2.getInPoint(0);
                                if (inPt2 && typeof inPt2.seconds !== 'undefined') {
                                    srcIn2 = Math.max(0, inPt2.seconds);
                                }
                            }
                        } catch (e) {}

                        key2 = mp2 + '|' + srcIn2.toFixed(3) + '|' + (srcIn2 + seqDur2).toFixed(3);
                        if (seenKeys[key2]) continue;
                        seenKeys[key2] = true;
                        allClips.push({
                            mediaPath:     mp2,
                            startTime:     srcIn2,
                            endTime:       srcIn2 + seqDur2,
                            timelineStart: clip2.start.seconds
                        });
                    }
                }
            }

            if (allClips.length === 0) {
                return _ckStringify({ error: 'No clips found in the sequence.' });
            }

            // Sort by timeline position
            allClips.sort(function(a, b) { return a.timelineStart - b.timelineStart; });

            // Sequence dimensions + frame rate for animation rendering
            var seqW2 = 1920, seqH2 = 1080, seqFps2 = 30;
            try {
                var ss2 = seq.getSettings();
                seqW2 = ss2.videoFrameWidth  || 1920;
                seqH2 = ss2.videoFrameHeight || 1080;
                if (ss2.videoFrameRate && ss2.videoFrameRate > 0) {
                    seqFps2 = ss2.videoFrameRate;
                }
            } catch(sse2) {}

            return _ckStringify({
                clips:             allClips,
                isFullSequence:    true,
                timelineStartTime: 0,
                timelineEndTime:   seq.end.seconds,
                name:              seq.name,
                sequenceName:      seq.name,
                seqWidth:          seqW2,
                seqHeight:         seqH2,
                seqFps:            seqFps2
            });
        }
    } catch (e) {
        return _ckStringify({ error: 'getClipInfo error: ' + e.toString() });
    }
}

function _findSelectedClipPremiere(seq) {
    var t, c, clip;
    for (t = 0; t < seq.videoTracks.numTracks; t++) {
        var vt = seq.videoTracks[t];
        for (c = 0; c < vt.clips.numItems; c++) {
            clip = vt.clips[c];
            if (clip.isSelected()) return clip;
        }
    }
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
        var at = seq.audioTracks[t];
        for (c = 0; c < at.clips.numItems; c++) {
            clip = at.clips[c];
            if (clip.isSelected()) return clip;
        }
    }
    return null;
}

function _findFirstVideoClipPremiere(seq) {
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var vt = seq.videoTracks[t];
        if (vt.clips.numItems > 0) return vt.clips[0];
    }
    return null;
}


// ═══════════════════════════════════════════════════════════════════
//  PREMIERE PRO  ──  Place Captions
// ═══════════════════════════════════════════════════════════════════

/**
 * Recursively searches a project bin (and sub-bins) for an item by name.
 */
function _findItemRecursive(bin, name) {
    try {
        for (var ri = 0; ri < bin.children.numItems; ri++) {
            var child = bin.children[ri];
            try { if (child.name === name) return child; } catch(e2) {}
            try {
                if (child.children && child.children.numItems > 0) {
                    var found = _findItemRecursive(child, name);
                    if (found) return found;
                }
            } catch(e3) {}
        }
    } catch(e4) {}
    return null;
}


/**
 * Strategy 2 — MOGRT Graphic Clips  (Essential Graphics)
 * ────────────────────────────────────────────────────────
 * Requires a bundled Motion Graphics Template at:
 *   <extension>/assets/Yashkit_caption.mogrt
 *
 * Workflow:
 *   For each caption:
 *      a. seq.importMGT(path, startTime, captionTrackIdx, 0) → places one live
 *         MOGRT instance on the timeline and returns its TrackItem
 *      b. tItem.setOutPoint(endTime) → trim the placed clip to caption length
 *      c. tItem.getMGTComponent() (or the AE Capsule JSON-blob component)
 *      d. Walk getProperties(), find the text property, call setValue(caption.text)
 *   Each clip is a fully-editable Essential Graphics object — the user can
 *   double-click any clip to change font, size, colour, or text in the
 *   Essential Graphics panel.
 *
 * Why importMGT (not importFiles + overwriteClip):
 *   • importFiles() does NOT import .mogrt files — the bin stays empty, so the
 *     old find-ProjectItem-then-overwriteClip path could never work.
 *   • importMGT() is the dedicated, documented MOGRT-placement API (PP 2019+).
 *   • Text is live, editable, renderable — not a flat image
 *   • Styling (font, colour, shadow) is baked into the MOGRT template
 *   • No SRT files, no QE DOM, no undocumented APIs
 *
 * Returns { placed: Boolean, method: String, textSet: Number }.
 */
function _tryMOGRTCaptions(validCaps, seq, mogrPath, diagInfo) {
    if (!mogrPath) {
        diagInfo.errors.push('MOGRT: mogrPath not provided');
        return { placed: false, method: 'mogrt-no-path' };
    }
    var mogrFile = new File(mogrPath);
    if (!mogrFile.exists) {
        diagInfo.errors.push('MOGRT: file not found — bundle mogrt/vibe cc1.mogrt with the plugin: ' + mogrPath);
        return { placed: false, method: 'mogrt-file-missing' };
    }

    // ── 1. Verify the MOGRT placement API is available ───────────────
    // CRITICAL: a .mogrt is a Motion Graphics Template, NOT regular media.
    // app.project.importFiles() silently imports NOTHING for it — the bin
    // stays empty, which is exactly the "item not found" failure this used
    // to hit. The correct (and only) API is Sequence.importMGT(), which
    // places a live MOGRT instance directly on the timeline and returns the
    // created TrackItem — no ProjectItem, no overwriteClip. PP 2019+.
    if (typeof seq.importMGT !== 'function') {
        diagInfo.errors.push('MOGRT: seq.importMGT unavailable in PP ' +
                             (app.version || '?') + ' — cannot place MOGRT captions');
        return { placed: false, method: 'mogrt-no-importmgt' };
    }

    // ── 2. Determine caption track index ─────────────────────────────
    // First choice: add a new video track above all existing content.
    // Fallback (PP builds where addVideoTrack is unavailable): use the
    // highest existing track that is completely empty.
    var numTracksBefore = seq.videoTracks.numTracks;
    var captionTrackIdx = numTracksBefore; // optimistic target (new track)

    try {
        seq.addVideoTrack();
        // Re-read numTracks — addVideoTrack places the new track at the end
        captionTrackIdx = seq.videoTracks.numTracks - 1;
        $.writeln('[MOGRT] addVideoTrack OK, captionTrackIdx=' + captionTrackIdx);
    } catch(ate) {
        diagInfo.errors.push('MOGRT: addVideoTrack: ' + ate.toString());
        // Find the highest empty existing track so we don't overwrite footage
        captionTrackIdx = -1;
        for (var eti = numTracksBefore - 1; eti >= 0; eti--) {
            try {
                if (seq.videoTracks[eti].clips.numItems === 0) {
                    captionTrackIdx = eti;
                    break;
                }
            } catch(etErr) {}
        }
        if (captionTrackIdx < 0) {
            // No completely empty track found — use topmost track and accept overlap risk
            captionTrackIdx = numTracksBefore - 1;
            diagInfo.errors.push('MOGRT: no empty track, using last track idx=' + captionTrackIdx);
        }
        $.writeln('[MOGRT] addVideoTrack unavailable, using existing track idx=' + captionTrackIdx);
    }

    // ── 3. Sort captions and place each instance via importMGT ───────
    var sorted = validCaps.slice().sort(function(a, b) { return a.startTime - b.startTime; });
    var placed        = 0;
    var textSetCount  = 0;
    var firstImportErr = ''; // first importMGT error (logged once)

    // PP internal timing: 254016000000 ticks per second. Express the start
    // time as a ticks string to avoid JS float precision loss on large
    // timecodes; fall back to a float of seconds if the ticks form is rejected.
    var PP_TICKS_PER_SEC = 254016000000;

    for (var i = 0; i < sorted.length; i++) {
        var cap = sorted[i];

        // ── Place via importMGT ───────────────────────────────────────
        // importMGT(path, time, videoTrackIndex, audioTrackIndex) places the
        // template at `time` on the given video track and returns the new
        // TrackItem. `time` accepts a ticks string or a float of seconds.
        var tItem = null;
        var startTicks = String(Math.round(cap.startTime * PP_TICKS_PER_SEC));
        try {
            tItem = seq.importMGT(mogrPath, startTicks, captionTrackIdx, 0);
        } catch(im1) {
            if (i === 0) firstImportErr = 'ticks: ' + im1.toString();
            try {
                tItem = seq.importMGT(mogrPath, cap.startTime, captionTrackIdx, 0);
            } catch(im2) {
                if (i === 0) firstImportErr += ' | seconds: ' + im2.toString();
            }
        }

        // importMGT returns undefined on some builds even when it placed the
        // clip — fall back to locating it on the track by start time.
        if (!tItem) {
            try {
                var trk = seq.videoTracks[captionTrackIdx];
                for (var fci = 0; fci < trk.clips.numItems; fci++) {
                    try {
                        var fcc = trk.clips[fci];
                        if (Math.abs(fcc.start.seconds - cap.startTime) < 0.05) { tItem = fcc; break; }
                    } catch(e) {}
                }
            } catch(e) {}
        }

        if (!tItem) {
            if (i === 0) {
                diagInfo.errors.push('MOGRT: importMGT failed cap 0 t=' +
                    cap.startTime.toFixed(3) + 's track=' + captionTrackIdx +
                    ': ' + (firstImportErr || 'no TrackItem returned'));
            }
            $.writeln('[MOGRT] importMGT failed cap ' + i + ': ' + firstImportErr);
            continue;
        }

        placed++;

        // ── Set caption text on the placed TrackItem ──────────────────
        try {
            if (tItem) {
                // Trim the placed clip to the caption's length. setOutPoint takes
                // a SOURCE-relative time (measured from the clip's media start = 0),
                // i.e. the DURATION — NOT the absolute sequence end time. importMGT
                // places the template at its long authored default length; if this
                // trim is skipped the final caption (which has no clip after it to
                // overwrite the overflow) runs ~30-40s past the end of the video.
                // The .seconds form is unreliable on some builds, so fall back to
                // an explicit ticks value (the form the diagnostics confirmed works).
                var dur = cap.endTime - cap.startTime;
                if (dur < 0.05) dur = 0.05;   // floor so it stays visible
                var trimmed = false;
                try {
                    var endT = new Time(); endT.seconds = dur;
                    tItem.setOutPoint(endT, 1);
                    trimmed = true;
                } catch(tse) {}
                if (!trimmed) {
                    try {
                        var endT2 = new Time();
                        endT2.ticks = String(Math.round(dur * PP_TICKS_PER_SEC));
                        tItem.setOutPoint(endT2, 1);
                        trimmed = true;
                    } catch(tse2) {}
                }
                // Last resort: trim by setting the clip's timeline end directly.
                if (!trimmed) {
                    try {
                        var clipEnd = new Time();
                        clipEnd.ticks = String(Math.round(cap.endTime * PP_TICKS_PER_SEC));
                        tItem.end = clipEnd;
                    } catch(tse3) {}
                }

                // Set caption text — for AE-exported MOGRTs in PP 26, getMGTComponent()
                // returns a stub with no properties. The real source-text param lives in
                // tItem.components as an "AE.ADBE Capsule" with a JSON-blob value.
                try {
                    // On first cap, dump tItem.components for diagnostics. Print FULL
                    // string values (no truncation) so we can see the JSON schema.
                    if (i === 0) {
                        var compDump = [];
                        try {
                            var comps = tItem.components;
                            var cN = (comps && comps.numItems !== undefined)
                                     ? comps.numItems : 0;
                            compDump.push('tItem.components count=' + cN);
                            for (var cdi = 0; cdi < cN; cdi++) {
                                try {
                                    var cmp = comps[cdi];
                                    var cmpName = '?';
                                    var cmpMN   = '?';
                                    try { cmpName = cmp.displayName || '?'; } catch(e) {}
                                    try { cmpMN   = cmp.matchName   || '?'; } catch(e) {}
                                    var pN = 0;
                                    try { pN = (cmp.properties && cmp.properties.numItems !== undefined)
                                                ? cmp.properties.numItems : 0; } catch(e) {}
                                    compDump.push('  comp[' + cdi + '] name="' + cmpName +
                                                  '" match="' + cmpMN + '" props=' + pN);
                                    for (var cpi = 0; cpi < pN; cpi++) {
                                        try {
                                            var sp = cmp.properties[cpi];
                                            var spName = '?'; var spVal = '?';
                                            try { spName = sp.displayName || ('prop' + cpi); } catch(e) {}
                                            try {
                                                var spRaw = sp.getValue ? sp.getValue() : undefined;
                                                if (typeof spRaw === 'string') {
                                                    // Full string — important for JSON schema inspection
                                                    spVal = '"' + spRaw + '"';
                                                } else if (spRaw !== undefined) {
                                                    spVal = String(spRaw);
                                                }
                                            } catch(e) {}
                                            compDump.push('    p[' + cpi + '] "' + spName +
                                                          '" = ' + spVal);
                                        } catch(spErr) {}
                                    }
                                } catch(cmpErr) {}
                            }
                        } catch(cdErr) {
                            compDump.push('tItem.components walk error: ' + cdErr.toString());
                        }
                        diagInfo.mogrComponents = compDump;
                    }

                    // ── Capsule path: find AE.ADBE Capsule component → first JSON-blob prop ──
                    var capsuleProp = null;
                    var capsuleCurr = '';
                    try {
                        var comps2 = tItem.components;
                        var cN2 = (comps2 && comps2.numItems !== undefined) ? comps2.numItems : 0;
                        for (var cci = 0; cci < cN2; cci++) {
                            try {
                                var cmp2 = comps2[cci];
                                var mn2 = '';
                                try { mn2 = cmp2.matchName || ''; } catch(e) {}
                                if (mn2.indexOf('Capsule') < 0) continue;
                                var pN2 = (cmp2.properties && cmp2.properties.numItems !== undefined)
                                          ? cmp2.properties.numItems : 0;
                                for (var cpi2 = 0; cpi2 < pN2; cpi2++) {
                                    try {
                                        var sp2 = cmp2.properties[cpi2];
                                        var raw2 = sp2.getValue ? sp2.getValue() : null;
                                        if (typeof raw2 === 'string' &&
                                            raw2.length > 0 &&
                                            raw2.charAt(0) === '{') {
                                            capsuleProp = sp2;
                                            capsuleCurr = raw2;
                                            break;
                                        }
                                    } catch(e) {}
                                }
                            } catch(e) {}
                            if (capsuleProp) break;
                        }
                    } catch(e) {}

                    if (capsuleProp) {
                        var esc2 = cap.text
                            .replace(/\\/g, '\\\\')
                            .replace(/"/g, '\\"')
                            .replace(/\n/g, '\\n')
                            .replace(/\r/g, '');
                        // Candidate keys for the text content, ordered by likelihood
                        // (AE Capsule schema uses capProp* prefix in PP 26).
                        var keyCandidates = [
                            'capPropTextEdit',
                            'capPropText',
                            'capPropSourceText',
                            'capPropTextEditValue',
                            'textEditValue'
                        ];
                        var capAttempts = [];
                        var capDone = false;
                        for (var kci = 0; kci < keyCandidates.length && !capDone; kci++) {
                            var key = keyCandidates[kci];
                            var pat = new RegExp('"' + key + '"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"');
                            if (!pat.test(capsuleCurr)) {
                                if (i === 0) capAttempts.push(key + ': key not in JSON');
                                continue;
                            }
                            var newJson = capsuleCurr.replace(pat, '"' + key + '":"' + esc2 + '"');
                            var threw2 = false;
                            try { capsuleProp.setValue(newJson, 1); }
                            catch(e1) {
                                try { capsuleProp.setValue(newJson); }
                                catch(e2) { threw2 = true; }
                            }
                            var rb = '';
                            try { rb = capsuleProp.getValue ? String(capsuleProp.getValue()) : ''; } catch(e) {}
                            var ok = rb.indexOf(cap.text) >= 0;
                            if (i === 0) capAttempts.push(key + ': threw=' + threw2 + ' applied=' + ok);
                            if (ok) {
                                capDone = true;
                                textSetCount++;
                            }
                        }

                        // Heuristic fallback — if no known key worked, try swapping each
                        // string-valued field in turn (skip booleans/numbers/known font fields).
                        if (!capDone) {
                            var kv = /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
                            var match;
                            var skipKeys = { capPropFontEdit:1, capPropFontStyleEdit:1,
                                             capPropFontFauxStyleEdit:1, capPropFontSizeEdit:1,
                                             capPropPositionEdit:1, capPropFont:1,
                                             capPropFontStyle:1 };
                            while ((match = kv.exec(capsuleCurr)) !== null && !capDone) {
                                var mk = match[1];
                                if (skipKeys[mk]) continue;
                                var newJson2 = capsuleCurr.substring(0, match.index) +
                                               '"' + mk + '":"' + esc2 + '"' +
                                               capsuleCurr.substring(match.index + match[0].length);
                                try { capsuleProp.setValue(newJson2, 1); } catch(e) {}
                                var rb2 = '';
                                try { rb2 = capsuleProp.getValue ? String(capsuleProp.getValue()) : ''; } catch(e) {}
                                var ok2 = rb2.indexOf(cap.text) >= 0;
                                if (i === 0) capAttempts.push('heur:' + mk + ': applied=' + ok2);
                                if (ok2) {
                                    capDone = true;
                                    textSetCount++;
                                }
                            }
                        }

                        if (i === 0) {
                            diagInfo.mogrCapsuleAttempts = capAttempts;
                            $.writeln('[MOGRT-CAP] attempts:\n  ' + capAttempts.join('\n  '));
                        }

                        // If Capsule path succeeded, skip the legacy MGT path entirely.
                        if (capDone) {
                            $.writeln('[MOGRT] Cap ' + i + ' text set via Capsule');
                            continue;
                        }
                    }

                    var mgt = typeof tItem.getMGTComponent === 'function'
                              ? tItem.getMGTComponent() : null;

                    // Always record on first cap so UI shows status even if mgt path fails
                    if (i === 0) {
                        var mgtStatus = 'mgt=' + (mgt ? 'present' : 'null') +
                                        ' hasGetProps=' + (mgt && typeof mgt.getProperties === 'function');
                        diagInfo.mogrMGTStatus = mgtStatus;
                    }

                    if (mgt && mgt.getProperties) {
                        var props = mgt.getProperties();

                        // On the first caption, dump every property's metadata so we
                        // can see exactly what the MOGRT exposes if injection fails.
                        if (i === 0) {
                            var dump = [];
                            dump.push('numItems=' + (props && props.numItems !== undefined ? props.numItems : 'undefined'));
                            for (var dpi = 0; dpi < props.numItems; dpi++) {
                                try {
                                    var dp = props[dpi];
                                    var dpName = '?';
                                    var dpType = '?';
                                    var dpVal  = '?';
                                    try { dpName = dp.displayName || ('prop' + dpi); } catch(e) {}
                                    try { dpType = dp.getType ? String(dp.getType()) : '?'; } catch(e) {}
                                    try {
                                        var rawVal = dp.getValue ? dp.getValue() : undefined;
                                        if (typeof rawVal === 'string') {
                                            dpVal = '"' + rawVal.substring(0, 40) + '"';
                                        } else if (rawVal !== undefined) {
                                            dpVal = String(rawVal).substring(0, 40);
                                        }
                                    } catch(e) {}
                                    dump.push(dpi + ':' + dpName + ' type=' + dpType + ' val=' + dpVal);
                                } catch(e) {}
                            }
                            diagInfo.mogrFirstClipProps = dump;
                            $.writeln('[MOGRT] First clip props:\n  ' + dump.join('\n  '));
                        }

                        // Try to find a text property using multiple strategies, since
                        // MGT property type IDs/names vary across PP versions and
                        // AE-vs-PP-exported MOGRTs.
                        var didSet = false;
                        for (var mpi = 0; mpi < props.numItems && !didSet; mpi++) {
                            try {
                                var prop = props[mpi];
                                var pName = '';
                                var pType = '';
                                var pCurr = null;
                                try { pName = (prop.displayName || '').toString().toLowerCase(); } catch(e) {}
                                try { pType = prop.getType ? String(prop.getType()).toLowerCase() : ''; } catch(e) {}
                                try { pCurr = prop.getValue ? prop.getValue() : null; } catch(e) {}

                                var looksLikeText =
                                    pType.indexOf('text')   >= 0 ||
                                    pType.indexOf('source') >= 0 ||
                                    pType.indexOf('string') >= 0 ||
                                    pType === '2' ||           // some PP builds report SOURCE_TEXT as 2
                                    pName.indexOf('text')   >= 0 ||
                                    pName.indexOf('caption') >= 0 ||
                                    (typeof pCurr === 'string' && pCurr.length > 0);

                                if (!looksLikeText) continue;

                                // Build candidate values to try. AE-exported source-text
                                // params expect a JSON blob; PP-native params take plain text.
                                // We try multiple formats and verify by reading back.
                                var esc = cap.text
                                    .replace(/\\/g, '\\\\')
                                    .replace(/"/g, '\\"')
                                    .replace(/\n/g, '\\n')
                                    .replace(/\r/g, '');
                                var candidates = [];
                                // (a) Swap textEditValue inside the existing JSON (preserves font/size)
                                if (typeof pCurr === 'string' &&
                                    pCurr.indexOf('textEditValue') >= 0) {
                                    candidates.push(pCurr.replace(
                                        /"textEditValue"\s*:\s*"(?:[^"\\]|\\.)*"/,
                                        '"textEditValue":"' + esc + '"'
                                    ));
                                }
                                // (b) Bare JSON wrapper
                                candidates.push('{"textEditValue":"' + esc + '"}');
                                // (c) Plain text
                                candidates.push(cap.text);

                                var didThisProp = false;
                                var attemptLog  = [];
                                for (var ci2 = 0; ci2 < candidates.length && !didThisProp; ci2++) {
                                    var cand = candidates[ci2];
                                    var threw = false;
                                    try { prop.setValue(cand, 1); }
                                    catch(se1) {
                                        try { prop.setValue(cand); }
                                        catch(se2) { threw = true; }
                                    }
                                    // Verify: read back and check if it now contains our text.
                                    var readback = '';
                                    try { readback = prop.getValue ? String(prop.getValue()) : ''; } catch(rbe) {}
                                    var applied = readback.indexOf(cap.text) >= 0;
                                    if (i === 0) {
                                        attemptLog.push('try' + ci2 +
                                            ' threw=' + threw +
                                            ' applied=' + applied +
                                            ' readback=' + readback.substring(0, 60));
                                    }
                                    if (applied) {
                                        didThisProp = true;
                                        textSetCount++;
                                        didSet = true;
                                    }
                                }
                                if (i === 0) {
                                    diagInfo.mogrSetAttempts = attemptLog;
                                    $.writeln('[MOGRT] Set attempts on prop ' + mpi +
                                              ' (' + pName + ' / ' + pType + '):\n  ' +
                                              attemptLog.join('\n  '));
                                }
                            } catch(pe) {}
                        }

                        if (!didSet && i === 0) {
                            diagInfo.errors.push(
                                'MOGRT: no text property matched on placed clip. ' +
                                'See mogrFirstClipProps in diag for the full property list.');
                        }
                    } else if (!mgt && i === 0) {
                        diagInfo.errors.push('MOGRT: getMGTComponent null on placed clip ' +
                                             '(clip may not be a MOGRT instance)');
                    }
                } catch(mgte) {
                    if (i === 0) diagInfo.errors.push('MOGRT: MGT: ' + mgte.toString());
                }
            }
        } catch(tre) {}

        $.writeln('[MOGRT] Cap ' + i + ': ' +
                  cap.startTime.toFixed(3) + '–' + cap.endTime.toFixed(3) + 's placed');
    }

    diagInfo.mogrTextSet = textSetCount;
    diagInfo.mogrPlaced  = placed;
    $.writeln('[MOGRT] Done: ' + placed + ' placed, ' + textSetCount + ' with text set');

    if (placed === 0) return { placed: false, method: 'mogrt-place-zero' };
    var method = textSetCount > 0 ? 'mogrt-text' : 'mogrt-no-text';
    return { placed: true, method: method, textSet: textSetCount };
}


/**
 * Probes every MOGRT / Essential Graphics API available in the current
 * PP installation.  Also performs a live test on a sample TrackItem if
 * one exists on the timeline.  Called by the "Scan MOGRT API" debug button.
 *
 * PP CAPABILITY AUDIT (PP 26.2.2 findings):
 * ─────────────────────────────────────────
 * CONFIRMED WORKING:
 *   seq.importMGT(path,t,vTrk,aTrk) ✓  place a MOGRT instance on the timeline,
 *                                       returns the new TrackItem  (PP 2019+)
 *   seq.addVideoTrack()             ✓  add empty video track
 *   TrackItem.getMGTComponent()     ✓  access MOGRT instance  (PP 22+)
 *   MGTComponent.getProperties()    ✓  list editable properties
 *   MGTProperty.getType()           ✓  returns 'text','color','slider',…
 *   MGTProperty.setValue()          ✓  set text / color / number
 *   TrackItem.setOutPoint()         ✓  trim the placed clip to caption length
 *
 * BROKEN / UNAVAILABLE IN PP 26.2.2:
 *   app.project.importFiles(.mogrt) ✗  silently imports NOTHING — bin stays
 *                                       empty. A .mogrt is NOT regular media;
 *                                       it MUST be placed with seq.importMGT().
 *   app.project.importFiles(.srt)   ✗  silently fails for all caption types
 *   seq.createCaptionTrack(any)     ✗  throws "Illegal Parameter type"
 *   seq.captionTracks               ✗  property does not exist
 *   seq.insertClip (for captions)   ✗  ripple-inserts, scrambles audio
 *   app.project.createNewTitle()    ✗  API removed / non-functional in PP 26
 *
 * INCONSISTENT ACROSS PP 22–26 BUILDS:
 *   qeSeq.importCaption()           ?  present in some builds, absent in others
 *   qeSeq.captionGroup              ?  varies by build and update
 *
 * RECOMMENDED ARCHITECTURE:
 *   1. Bundle assets/Yashkit_caption.mogrt (single text layer, no animation)
 *   2. per caption: seq.importMGT → setOutPoint → getMGTComponent →
 *      getProperties → setValue (or the AE Capsule JSON-blob path)
 *   Result: editable Essential Graphics clips, perfect sync, zero project bloat
 */
function diagMOGRTAPI() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return _ckStringify({ error: 'no active sequence' });

        var result = {
            ppVersion: app.version,
            apis:      {},
            mgtResult: '(no video clips on timeline to test against)'
        };

        // ── Sequence-level APIs ───────────────────────────────────────
        result.apis['seq.overwriteClip']      = typeof seq.overwriteClip      === 'function';
        result.apis['seq.addVideoTrack']       = typeof seq.addVideoTrack       === 'function';
        result.apis['seq.createCaptionTrack']  = typeof seq.createCaptionTrack  === 'function';
        result.apis['seq.transcribeSequence']  = typeof seq.transcribeSequence  === 'function';
        result.apis['seq.generateCaptions']    = typeof seq.generateCaptions    === 'function';

        // ── Project-level APIs ────────────────────────────────────────
        result.apis['project.importFiles']     = typeof app.project.importFiles     === 'function';
        result.apis['project.createNewTitle']  = typeof app.project.createNewTitle  === 'function';

        // ── QE DOM ────────────────────────────────────────────────────
        try {
            app.enableQE();
            result.apis['qe.available'] = (typeof qe !== 'undefined');
            if (typeof qe !== 'undefined' && qe.project) {
                var qeSeq2 = qe.project.activeSequence;
                result.apis['qeSeq.importCaption']  = qeSeq2 ? (typeof qeSeq2.importCaption  === 'function') : false;
                result.apis['qeSeq.captionGroup']   = qeSeq2 ? (qeSeq2.captionGroup !== undefined)           : false;
            }
        } catch(qe2) { result.apis['qe.available'] = false; }

        // ── TrackItem / MGT live test ─────────────────────────────────
        // Walk all video tracks looking for any clip to test against
        var sampleClip = null;
        for (var t2 = 0; t2 < seq.videoTracks.numTracks && !sampleClip; t2++) {
            var vt2 = seq.videoTracks[t2];
            if (vt2.clips.numItems > 0) sampleClip = vt2.clips[0];
        }

        if (sampleClip) {
            result.apis['TrackItem.getMGTComponent'] = typeof sampleClip.getMGTComponent === 'function';

            if (typeof sampleClip.getMGTComponent === 'function') {
                try {
                    var mgt2 = sampleClip.getMGTComponent();
                    if (mgt2) {
                        result.apis['MGTComponent.getProperties'] = typeof mgt2.getProperties === 'function';
                        if (typeof mgt2.getProperties === 'function') {
                            var props2 = mgt2.getProperties();
                            var propList = [];
                            for (var pi2 = 0; pi2 < props2.numItems; pi2++) {
                                try {
                                    var p2 = props2[pi2];
                                    var pType2 = p2.getType ? p2.getType() : '?';
                                    propList.push((p2.displayName || 'prop' + pi2) + ':' + pType2);
                                } catch(pe2) {}
                            }
                            result.mgtResult = 'getMGTComponent() → ' + props2.numItems +
                                               ' properties: [' + propList.join(', ') + ']';
                        }
                    } else {
                        result.mgtResult = 'getMGTComponent() returned null (clip is not a MOGRT instance)';
                    }
                } catch(mgte2) {
                    result.mgtResult = 'getMGTComponent() threw: ' + mgte2.toString();
                }
            } else {
                result.mgtResult = 'getMGTComponent not a function on TrackItem';
            }
        }

        return _ckStringify(result);
    } catch(e) {
        return _ckStringify({ error: 'diagMOGRTAPI: ' + e.toString() });
    }
}

/**
 * Deep diagnostic: places the bundled MOGRT on the timeline via seq.importMGT(),
 * inspects the resulting TrackItem (MGT component + raw components/matchNames),
 * tests setOutPoint, then removes the probe clip.
 *
 * This is the key diagnostic for understanding MOGRT placement: it confirms
 * importMGT is available, that it actually creates a TrackItem, and exposes the
 * editable text properties / AE Capsule component used to inject caption text.
 *
 * Call via the "Diagnose MOGRT Import" debug button:
 *   csInterface.evalScript('diagMOGRTImport("' + mogrPath + '")', ...)
 *
 * Returns JSON with:
 *   - hasImportMGT:   whether seq.importMGT exists in this build
 *   - placementTests: result of each importMGT variant (ticks / seconds)
 *   - placedName:     name of the placed TrackItem
 *   - mgtResult:      getMGTComponent() outcome + property count
 *   - mgtProps:       editable MGT property display names
 *   - components:     raw component matchNames (to locate the AE Capsule text param)
 *   - setOutPointOk:  whether setOutPoint succeeded on the placed clip
 *   - cleanedUp:      whether we removed the probe clip
 */
function diagMOGRTImport(mogrPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return _ckStringify({ error: 'no active sequence' });

        var mogrFile = new File(mogrPath);
        if (!mogrFile.exists) {
            return _ckStringify({ error: 'MOGRT file not found: ' + mogrPath });
        }

        var out = {
            ppVersion:      app.version,
            mogrPath:       mogrPath,
            hasImportMGT:   (typeof seq.importMGT === 'function'),
            placementTests: []
        };

        if (!out.hasImportMGT) {
            out.error = 'seq.importMGT is not a function in this PP build — ' +
                        'MOGRT captions cannot be placed via scripting.';
            return _ckStringify(out);
        }

        // Determine a safe probe track — prefer the highest empty track so we
        // don't disturb existing content. Undo (remove) the probe clip after.
        var probeTrackIdx = 0;
        try {
            for (var pti = seq.videoTracks.numTracks - 1; pti >= 0; pti--) {
                if (seq.videoTracks[pti].clips.numItems === 0) { probeTrackIdx = pti; break; }
            }
        } catch(pte) {}
        out.probeTrackIdx = probeTrackIdx;

        var PP_TICKS  = 254016000000;
        var probeTime = 0.001; // 1 ms — near-zero to avoid colliding with real clips
        var pTrackObj = null;
        var pClipsBefore = -1;
        try { pTrackObj    = seq.videoTracks[probeTrackIdx]; }               catch(e) {}
        try { pClipsBefore = pTrackObj ? pTrackObj.clips.numItems : -1; }    catch(e) {}

        // Probe placement via importMGT — try ticks string first, then seconds.
        // importMGT returns the created TrackItem; inspect it, then remove it.
        var placed = null;
        try {
            placed = seq.importMGT(mogrPath, String(Math.round(probeTime * PP_TICKS)), probeTrackIdx, 0);
            out.placementTests.push('importMGT[ticks]: returned ' +
                (placed ? 'TrackItem' : 'undefined') + ', clips ' + pClipsBefore +
                '->' + (pTrackObj ? pTrackObj.clips.numItems : '?'));
        } catch(pE1) {
            out.placementTests.push('importMGT[ticks]: ERROR: ' + pE1.toString());
            try {
                placed = seq.importMGT(mogrPath, probeTime, probeTrackIdx, 0);
                out.placementTests.push('importMGT[seconds]: returned ' +
                    (placed ? 'TrackItem' : 'undefined'));
            } catch(pE2) {
                out.placementTests.push('importMGT[seconds]: ERROR: ' + pE2.toString());
            }
        }

        // If the return was undefined, locate the placed clip on the track.
        if (!placed && pTrackObj) {
            try {
                for (var li = 0; li < pTrackObj.clips.numItems; li++) {
                    try {
                        var lc = pTrackObj.clips[li];
                        if (Math.abs(lc.start.seconds - probeTime) < 0.05) { placed = lc; break; }
                    } catch(e) {}
                }
            } catch(e) {}
        }

        if (placed) {
            try { out.placedName = placed.name; } catch(e) {}

            // Inspect the MOGRT instance: getMGTComponent() and raw components.
            try {
                var mgt = (typeof placed.getMGTComponent === 'function')
                          ? placed.getMGTComponent() : null;
                if (mgt && mgt.getProperties) {
                    var props = mgt.getProperties();
                    var pn = (props && props.numItems !== undefined) ? props.numItems : 0;
                    out.mgtResult = 'getMGTComponent() → ' + pn + ' properties';
                    var pNames = [];
                    for (var gpi = 0; gpi < pn; gpi++) {
                        try { pNames.push(props[gpi].displayName || ('prop' + gpi)); } catch(e) {}
                    }
                    out.mgtProps = pNames;
                } else if (mgt) {
                    out.mgtResult = 'getMGTComponent() returned object without getProperties';
                } else {
                    out.mgtResult = 'getMGTComponent() returned null';
                }
            } catch(mge) { out.mgtResult = 'getMGTComponent() threw: ' + mge.toString(); }

            // Dump raw components/matchNames so we can find the AE Capsule text param.
            try {
                var comps = placed.components;
                var cN = (comps && comps.numItems !== undefined) ? comps.numItems : 0;
                var compNames = [];
                for (var di = 0; di < cN; di++) {
                    try {
                        var cmp = comps[di];
                        var mn = ''; try { mn = cmp.matchName || ''; } catch(e) {}
                        var dn = ''; try { dn = cmp.displayName || ''; } catch(e) {}
                        var pc = 0;
                        try { pc = (cmp.properties && cmp.properties.numItems !== undefined)
                                    ? cmp.properties.numItems : 0; } catch(e) {}
                        compNames.push('"' + dn + '" match="' + mn + '" props=' + pc);
                    } catch(e) {}
                }
                out.components = compNames;
            } catch(e) {}

            // Test setOutPoint on the placed clip.
            try {
                var durT = new Time(); durT.seconds = 2.0;
                placed.setOutPoint(durT, 1);
                out.setOutPointOk = true;
            } catch(soe) {
                try {
                    var durT2 = new Time();
                    durT2.ticks = String(Math.round(2.0 * PP_TICKS));
                    placed.setOutPoint(durT2, 1);
                    out.setOutPointOk = 'ticks-only';
                } catch(soe2) {
                    out.setOutPointOk = false;
                    out.setOutPointErr = soe.toString() + ' | ' + soe2.toString();
                }
            }

            // Clean up: remove the probe clip (and any extras above pClipsBefore).
            try {
                var cnt = pTrackObj ? pTrackObj.clips.numItems : 0;
                for (var rci = cnt - 1; rci >= pClipsBefore && rci >= 0; rci--) {
                    try { pTrackObj.clips[rci].remove(false, true); } catch(e) {}
                }
                out.cleanedUp = true;
            } catch(cle) { out.cleanupErr = cle.toString(); }
        } else {
            out.error = 'importMGT did not place a TrackItem on the timeline';
        }

        return _ckStringify(out);
    } catch(e) {
        return _ckStringify({ error: 'diagMOGRTImport: ' + e.toString() });
    }
}

/**
 * Creates the Yashkit caption MOGRT template file.
 *
 * Two paths depending on host:
 *
 *   After Effects (id === 'AEFT'):
 *     Creates a 1920×1080 composition, adds a styled text layer, then calls
 *     comp.exportAsMotionGraphicsTemplate(true, mogrPath) — official AE 16+ API.
 *     The exported .mogrt will have one editable 'text' property that PP
 *     accesses via getMGTComponent().getProperties().
 *     Cleans up the temp composition after export.
 *
 *   Premiere Pro (id === 'PPRO'):
 *     Returns { needsAE: true, ppInstructions: [...] } with step-by-step
 *     manual instructions for creating the template in PP's Essential
 *     Graphics panel, AND tries a BridgeTalk send to a running AE instance.
 *
 * @param {string} mogrPath  Absolute path where the .mogrt should be saved
 *                           (e.g. "<extension>/assets/Yashkit_caption.mogrt").
 * @returns {string}  JSON { success, message } on success,
 *                    JSON { success:false, error, needsAE?, ppInstructions? } on failure.
 */
function setupMOGRTTemplate(mogrPath) {
    var id = _getAppId();

    // ── After Effects: create comp → style text → export MOGRT ───────────
    if (id === 'AEFT') {
        try {
            // Ensure assets folder exists
            var lastSlash = Math.max(mogrPath.lastIndexOf('/'), mogrPath.lastIndexOf('\\'));
            if (lastSlash > 0) {
                var assetsFolder = new Folder(mogrPath.substring(0, lastSlash));
                if (!assetsFolder.exists) {
                    if (!assetsFolder.create()) {
                        return _ckStringify({ success: false,
                            error: 'Could not create folder: ' + mogrPath.substring(0, lastSlash) });
                    }
                }
            }

            // 1. Create 1920×1080 comp @ 30 fps, 5 s duration
            //    (duration doesn't matter — clips are trimmed at placement via setOutPoint)
            var comp = app.project.items.addComp(
                'Yashkit Caption Template', 1920, 1080, 1.0, 5.0, 30
            );

            // 2. Add box text (wraps and centres better than point text)
            var textLayer;
            try {
                textLayer = comp.layers.addBoxText([1700, 220], 'Caption Text');
            } catch(ate) {
                // Older AE: fall back to point text
                textLayer = comp.layers.addText('Caption Text');
            }
            textLayer.name = 'Caption Text';

            // 3. Style: white 72px + thin black stroke for legibility
            try {
                var tp = textLayer
                    .property('ADBE Text Properties')
                    .property('ADBE Text Document');
                var doc = tp.value;
                doc.text      = 'Caption Text';
                doc.fontSize  = 72;
                doc.fillColor = [1, 1, 1]; // white
                doc.applyFill = true;
                try {
                    doc.strokeColor = [0, 0, 0];
                    doc.strokeWidth = 2;
                    doc.applyStroke = true;
                } catch(se) { /* stroke not always settable this way */ }
                tp.setValue(doc);
            } catch(styErr) { $.writeln('[setupMOGRT] style error: ' + styErr); }

            // 4. Position: bottom-centre of frame
            try {
                var xf = textLayer.property('ADBE Transform Group');
                xf.property('ADBE Anchor Point').setValue([850, 110]);
                xf.property('ADBE Position').setValue([960, 950]);
            } catch(posErr) { $.writeln('[setupMOGRT] position error: ' + posErr); }

            // 4.5. Register the text property as an Essential Graphics controller.
            //      AE requires at least one "property controller" before it will allow
            //      exportAsMotionGraphicsTemplate() — this is what caused the
            //      "You must add at least one property controller" warning.
            //      addToMotionGraphicsTemplateAs(comp, name) — AE 15.0 (CC 2018)+
            try {
                var mgtProp = textLayer
                    .property('ADBE Text Properties')
                    .property('ADBE Text Document');
                var mgtOk = false;
                if (typeof mgtProp.addToMotionGraphicsTemplateAs === 'function') {
                    mgtOk = mgtProp.addToMotionGraphicsTemplateAs(comp, 'Caption Text');
                    $.writeln('[setupMOGRT] addToMotionGraphicsTemplateAs: ' + mgtOk);
                }
                if (!mgtOk && typeof mgtProp.addToMotionGraphicsTemplate === 'function') {
                    mgtOk = mgtProp.addToMotionGraphicsTemplate(comp);
                    $.writeln('[setupMOGRT] addToMotionGraphicsTemplate fallback: ' + mgtOk);
                }
                if (!mgtOk) { $.writeln('[setupMOGRT] WARNING: could not add MGT controller — export may fail'); }
            } catch(mge) { $.writeln('[setupMOGRT] addToMGT error (non-fatal): ' + mge); }

            // 5. Export as Motion Graphics Template
            //    exportAsMotionGraphicsTemplate(doOverwrite, filePath) — AE 16.0 (CC 2019)+
            var exported;
            try {
                exported = comp.exportAsMotionGraphicsTemplate(true, mogrPath);
            } catch(expErr) {
                try { comp.remove(); } catch(re) {}
                return _ckStringify({ success: false,
                    error: 'exportAsMotionGraphicsTemplate failed: ' + expErr.toString() +
                           ' — requires AE 16.0 (CC 2019) or later.' });
            }

            // 6. Clean up the temp comp regardless of result
            try { comp.remove(); } catch(re) {}

            if (exported) {
                $.writeln('[setupMOGRT] Created: ' + mogrPath);
                return _ckStringify({ success: true,
                    message: 'MOGRT template created! Switch to Premiere Pro and click "Place on Timeline" again.' });
            } else {
                return _ckStringify({ success: false,
                    error: 'exportAsMotionGraphicsTemplate returned false. ' +
                           'Try manually: Window > Essential Graphics → Export Motion Graphics Template.' });
            }
        } catch(e) {
            return _ckStringify({ success: false,
                error: 'setupMOGRTTemplate (AE): ' + e.toString() });
        }
    }

    // ── Premiere Pro: try BridgeTalk to a running AE instance ────────────
    if (id === 'PPRO') {
        // Step 1 — check if AE is running via BridgeTalk.getTargets()
        var aeTarget = null;
        try {
            var btTargets = BridgeTalk.getTargets ? BridgeTalk.getTargets() : [];
            for (var bti = 0; bti < btTargets.length; bti++) {
                if (btTargets[bti].toLowerCase().indexOf('aftereffects') >= 0) {
                    aeTarget = btTargets[bti];
                    break;
                }
            }
        } catch(bte) { $.writeln('[setupMOGRT] BridgeTalk.getTargets error: ' + bte); }

        if (aeTarget) {
            // Step 2 — AE is running: send a self-contained creation script
            // We write the result to a temp JSON file since BridgeTalk is async,
            // then poll for it (max 15 s).
            var resultPath = Folder.temp.fsName + '/YashkitMOGRTResult_' + new Date().getTime() + '.json';
            try { (new File(resultPath)).remove(); } catch(rpe) {}

            // Build the AE-side script as a single string (no external dependencies)
            var aeScript =
                'try {' +
                '  var mp = ' + _ckStringify(mogrPath) + ';' +
                '  var ls = Math.max(mp.lastIndexOf("/"), mp.lastIndexOf("\\\\"));' +
                '  if (ls > 0) { var af = new Folder(mp.substring(0, ls)); if (!af.exists) af.create(); }' +
                '  var comp = app.project.items.addComp("Yashkit Caption Template", 1920, 1080, 1.0, 5.0, 30);' +
                '  var tl; try { tl = comp.layers.addBoxText([1700, 220], "Caption Text"); } catch(e) { tl = comp.layers.addText("Caption Text"); }' +
                '  tl.name = "Caption Text";' +
                '  try {' +
                '    var tp = tl.property("ADBE Text Properties").property("ADBE Text Document");' +
                '    var d = tp.value; d.text = "Caption Text"; d.fontSize = 72; d.fillColor = [1,1,1]; d.applyFill = true;' +
                '    try { d.strokeColor = [0,0,0]; d.strokeWidth = 2; d.applyStroke = true; } catch(se) {}' +
                '    tp.setValue(d);' +
                '  } catch(se2) {}' +
                '  try { var xf = tl.property("ADBE Transform Group"); xf.property("ADBE Anchor Point").setValue([850,110]); xf.property("ADBE Position").setValue([960,950]); } catch(pe) {}' +
                '  try { var mp2 = tl.property("ADBE Text Properties").property("ADBE Text Document"); var mo = false; if (typeof mp2.addToMotionGraphicsTemplateAs === "function") mo = mp2.addToMotionGraphicsTemplateAs(comp, "Caption Text"); if (!mo && typeof mp2.addToMotionGraphicsTemplate === "function") mp2.addToMotionGraphicsTemplate(comp); } catch(mge) {}' +
                '  var ok = comp.exportAsMotionGraphicsTemplate(true, mp);' +
                '  try { comp.remove(); } catch(re) {}' +
                '  var rp = ' + _ckStringify(resultPath) + ';' +
                '  var rf = new File(rp); rf.encoding = "UTF-8"; rf.open("w");' +
                '  rf.write(ok ? \'{"success":true}\' : \'{"success":false,"error":"export returned false"}\');' +
                '  rf.close();' +
                '} catch(e) {' +
                '  var rp2 = ' + _ckStringify(resultPath) + ';' +
                '  var rf2 = new File(rp2); rf2.encoding = "UTF-8"; rf2.open("w");' +
                '  rf2.write(\'{"success":false,"error":"\' + e.toString().replace(/"/g, "\'") + \'"}\');' +
                '  rf2.close();' +
                '}';

            try {
                var bt = new BridgeTalk();
                bt.target = aeTarget;
                bt.body   = aeScript;
                bt.send(5); // 5 s send timeout

                // Poll the result file (max 15 s in 200 ms steps)
                var resultFile = new File(resultPath);
                for (var wi = 0; wi < 75; wi++) {
                    $.sleep(200);
                    if (resultFile.exists) break;
                }

                if (resultFile.exists) {
                    resultFile.encoding = 'UTF-8';
                    resultFile.open('r');
                    var rsStr = resultFile.read();
                    resultFile.close();
                    try { resultFile.remove(); } catch(re2) {}
                    var rs = eval('(' + rsStr + ')');
                    if (rs.success) {
                        return _ckStringify({ success: true,
                            message: 'MOGRT template created via After Effects! Click "Place on Timeline" again.' });
                    }
                    return _ckStringify({ success: false,
                        error: 'AE script: ' + (rs.error || 'unknown') });
                } else {
                    return _ckStringify({ success: false,
                        error: 'After Effects did not respond in time. Open the Yashkit panel inside After Effects and click "Create MOGRT Template" from there.' });
                }
            } catch(bte2) {
                return _ckStringify({ success: false,
                    error: 'BridgeTalk: ' + bte2.toString() });
            }
        }

        // Step 3 — AE is not running: return PP manual instructions
        return _ckStringify({
            success: false,
            needsAE: true,
            ppInstructions: [
                '1. Open Premiere Pro → Window > Essential Graphics',
                '2. Click the pencil icon (Edit) → New Layer > Text',
                '3. Type any placeholder text, then click the canvas to confirm',
                '4. In the Essential Graphics panel header, click "Export Motion Graphics Template…"',
                '5. Name it "Yashkit_caption" and save to:',
                '   ' + mogrPath,
                '',
                '  — OR —',
                '',
                'Open After Effects, open the Yashkit panel there, and click',
                '"Create MOGRT Template" to auto-generate it.'
            ],
            error: 'After Effects is not open. See instructions in the debug panel.'
        });
    }

    return _ckStringify({ success: false, error: 'Unsupported host: ' + id });
}


/**
 * Place captions in Premiere Pro.
 *
 * Strategy order:
 *   1. QE DOM  — qeSeq.importCaption() / createCaptionTrack()
 *               → native editable caption track (best result)
 *   2. MOGRT   — Essential Graphics instances on timeline (fallback)
 *
 * Regardless of scripting outcome, an SRT + VTT file is always written
 * to the user's Desktop so they can import manually via
 * Window → Text → Captions → Import Captions from File.
 */
function _placeCaptionsPremiere(data) {
    try {
        var captions  = data.captions;
        var mogrPath  = data.mogrPath  || '';
        var style     = data.style     || {};
        var seq = app.project.activeSequence;

        if (!seq) {
            return _ckStringify({ success: false, error: 'No active sequence. Open a sequence first.' });
        }

        var diagInfo = {
            ppVersion: app.version,
            trackIdx:  -1,
            mogrPath:  mogrPath,
            errors:    []
        };

        $.writeln('[PR] PP v' + app.version + ' | ' + captions.length +
                  ' captions | seq=' + seq.name);

        // ── Validate captions ────────────────────────────────────────
        // cap.words is carried through: the native renderer keys its animation
        // off real word timestamps, so losing it would flatten every per-word
        // style back to a plain fade.
        var validCaps = [];
        for (var vi = 0; vi < captions.length; vi++) {
            var c  = captions[vi];
            var cs = parseFloat(c.startTime) || 0;
            var ce = parseFloat(c.endTime)   || 0;
            var ct = String(c.text || '').replace(/\r\n|\r|\n/g, ' ').replace(/^\s+|\s+$/g, '');
            if (ct && ce > cs) {
                validCaps.push({
                    startTime: cs,
                    endTime:   ce,
                    text:      ct,
                    words:     (c.words && c.words.length) ? c.words : null,
                    emoji:     c.emoji || ''
                });
            }
        }
        if (validCaps.length === 0) {
            return _ckStringify({ success: false, error: 'No valid captions to place.' });
        }
        $.writeln('[PR] Valid captions: ' + validCaps.length);

        // ── Native animated captions (word-timed, keyframed) ─────────
        // Only for the styles that have been ported; everything else — and any
        // failure at all — falls through to the one-clip-per-caption MOGRT path
        // below, so this can never place fewer captions than before.
        if (_PPRO_NATIVE_STYLES[style.animation]) {
            var natRes = _tryNativeAnimatedCaptions(validCaps, seq, mogrPath, style, data, diagInfo);
            if (natRes.placed) {
                $.writeln('[PR] native placement SUCCESS via ' + natRes.method);
                return _ckStringify({
                    success:      true,
                    placed:       true,
                    captionCount: validCaps.length,
                    clipCount:    natRes.clipCount,
                    method:       natRes.method,
                    diag:         diagInfo
                });
            }
            diagInfo.nativeMethod = natRes.method;
            $.writeln('[PR] native placement failed (' + natRes.method + ') — falling back to MOGRT');
        }

        // ── Place captions as MOGRT instances ─────────────────────────
        var mogrResult = _tryMOGRTCaptions(validCaps, seq, mogrPath, diagInfo);
        if (mogrResult.placed) {
            $.writeln('[PR] MOGRT placement SUCCESS via ' + mogrResult.method);
            return _ckStringify({
                success:      true,
                placed:       true,
                captionCount: validCaps.length,
                method:       mogrResult.method,
                diag:         diagInfo
            });
        }

        $.writeln('[PR] MOGRT placement failed: ' + mogrResult.method);
        diagInfo.mogrMethod = mogrResult.method;
        return _ckStringify({
            success:      true,
            placed:       false,
            captionCount: validCaps.length,
            method:       mogrResult.method,
            diag:         diagInfo
        });

    } catch (e) {
        return _ckStringify({ success: false, error: '_placeCaptionsPremiere: ' + e.toString() });
    }
}


// ═══════════════════════════════════════════════════════════════════
//  PREMIERE PRO  ──  NATIVE ANIMATED CAPTIONS
//
//  What the old path did: one MOGRT instance per caption, text poked into the
//  template. Word timing was thrown away, the panel's font/size/colour/position
//  were ignored, and nothing moved.
//
//  What this does: splits each caption into per-word STEPS, places one graphic
//  clip per step so words genuinely arrive with the voice, applies the panel's
//  style through the template's Essential Graphics parameters (so the clip stays
//  editable in Essential Graphics after placement), and keyframes the clip's own
//  Motion / Opacity from cap.words[].
//
//  API constraints this is built around — all from the live audit in
//  diagMOGRTAPI() below, measured on PP 26.2.2:
//    • There is NO API that creates a text graphic from nothing.
//      createNewTitle(), createCaptionTrack() and importFiles('.srt') are all
//      dead. seq.importMGT() is the only way to get live text on a timeline,
//      so a bundled .mogrt is still the substrate.
//    • getMGTComponent().getProperties() → setValue() DOES work. When the
//      template exposes its text/font/size/colour as Essential Graphics
//      parameters, that is what makes a placed caption editable afterwards.
//      The AE-exported templates currently bundled hide everything inside one
//      opaque "AE.ADBE Capsule" JSON blob, which is why captions placed today
//      aren't editable in Essential Graphics. Both routes are attempted here,
//      EG parameters FIRST, so a Premiere-authored template gets the good path
//      the moment one is bundled.
//    • ComponentParam.setTimeVarying/addKey/setValueAtKey/
//      setInterpolationTypeAtKey are the supported way to keyframe a clip, and
//      that is how the word-timed motion below is written.
// ═══════════════════════════════════════════════════════════════════

var PP_TICKS_PER_SECOND = 254016000000;

/* Styles the native renderer knows how to draw. Anything else goes to the
   legacy one-clip-per-caption path untouched. */
var _PPRO_NATIVE_STYLES = {
    wordappear: true,   // words appear, hard cut, in sync with speech
    word:       true,   // Slide Up — the line rises in, then words appear
    karaoke:    true    // full line held, a beat on each spoken word
};

/* Keyframe interpolation ids used by setInterpolationTypeAtKey. */
var PP_KF_LINEAR = 1;
var PP_KF_HOLD   = 4;
var PP_KF_BEZIER = 5;

function _ppTicks(seconds) {
    return String(Math.round(seconds * PP_TICKS_PER_SECOND));
}

/* A Time at `seconds`. The .seconds setter is unreliable on some builds, so
   ticks is the fallback (the form the diagnostics confirmed works). */
function _ppTime(seconds) {
    var t = new Time();
    try { t.seconds = seconds; } catch (e) { }
    try {
        if (!t.seconds || Math.abs(t.seconds - seconds) > 0.001) t.ticks = _ppTicks(seconds);
    } catch (e2) {
        try { t.ticks = _ppTicks(seconds); } catch (e3) { }
    }
    return t;
}

/**
 * Break one caption into the clips that will represent it.
 *
 * Returns [{ text, tIn, tOut, wordIndex, isFirst }] in timeline order,
 * non-overlapping, covering exactly [cap.startTime, cap.endTime].
 *
 *   wordappear / word → ACCUMULATING text: step i shows words 0..i, so each
 *                       clip boundary is the moment a word is spoken. This is
 *                       how word-by-word is done in Premiere — a single text
 *                       object can't reveal part of itself.
 *   karaoke           → the FULL line every step. The line never changes; the
 *                       step boundaries exist so each spoken word can carry a
 *                       scale beat. (A true per-word colour highlight needs a
 *                       template that exposes a highlight colour parameter —
 *                       see the note in _ppApplyStyleParams.)
 *
 * Steps shorter than MIN_STEP are folded into the previous one, so a fast
 * run of words doesn't produce a pile of 1-frame clips.
 */
function _ppAnimSteps(cap, anim) {
    var MIN_STEP = 0.08;
    var words = cap.words;
    var single = [{ text: cap.text, tIn: cap.startTime, tOut: cap.endTime, wordIndex: 0, isFirst: true }];

    if (!words || words.length < 2) return single;

    var accumulate = (anim === 'wordappear' || anim === 'word');
    var steps = [];
    var parts = [];

    for (var i = 0; i < words.length; i++) {
        var w = words[i];
        var wTxt = String(w && w.word != null ? w.word : '').replace(/^\s+|\s+$/g, '');
        if (wTxt) parts.push(wTxt);

        // First word shows with the caption's own start (the caption is on
        // screen slightly before the word is spoken — same lead-in as AE).
        var tIn = (i === 0) ? cap.startTime
                            : Math.max(cap.startTime, parseFloat(w.start) || cap.startTime);
        var tOut;
        if (i < words.length - 1) {
            var nextStart = parseFloat(words[i + 1].start);
            tOut = Math.min(cap.endTime, isNaN(nextStart) ? cap.endTime : nextStart);
        } else {
            tOut = cap.endTime;
        }
        if (tOut <= tIn) continue;

        var text = accumulate ? parts.join(' ') : cap.text;

        // Fold a too-short step into the previous clip: keep the later text
        // (it has more words) and stretch that clip over both spans.
        var prev = steps.length ? steps[steps.length - 1] : null;
        if (prev && (tOut - tIn) < MIN_STEP) {
            prev.text = text;
            prev.tOut = tOut;
            continue;
        }
        if (prev && prev.tOut > tIn) prev.tOut = tIn;   // never overlap

        steps.push({ text: text, tIn: tIn, tOut: tOut, wordIndex: i, isFirst: steps.length === 0 });
    }

    if (steps.length === 0) return single;
    // The last clip always runs to the caption's end.
    steps[steps.length - 1].tOut = cap.endTime;
    return steps;
}

/* Find a component on a track item whose matchName or displayName contains any
   of `needles` (lower-cased substring match). Returns null when absent. */
function _ppFindComponent(tItem, needles) {
    try {
        var comps = tItem.components;
        var n = (comps && comps.numItems !== undefined) ? comps.numItems : 0;
        for (var i = 0; i < n; i++) {
            try {
                var c = comps[i];
                var mn = '';
                var dn = '';
                try { mn = String(c.matchName || '').toLowerCase(); } catch (e) { }
                try { dn = String(c.displayName || '').toLowerCase(); } catch (e) { }
                for (var k = 0; k < needles.length; k++) {
                    var needle = needles[k].toLowerCase();
                    if (mn.indexOf(needle) >= 0 || dn.indexOf(needle) >= 0) return c;
                }
            } catch (e2) { }
        }
    } catch (e3) { }
    return null;
}

/* Find a parameter on a component by display-name substring. */
function _ppFindParam(comp, needles) {
    if (!comp) return null;
    try {
        var props = comp.properties;
        var n = (props && props.numItems !== undefined) ? props.numItems : 0;
        for (var i = 0; i < n; i++) {
            try {
                var p = props[i];
                var dn = '';
                try { dn = String(p.displayName || '').toLowerCase(); } catch (e) { }
                for (var k = 0; k < needles.length; k++) {
                    if (dn.indexOf(needles[k].toLowerCase()) >= 0) return p;
                }
            } catch (e2) { }
        }
    } catch (e3) { }
    return null;
}

/**
 * Write one keyframe. Premiere needs the stream switched to time-varying before
 * it will hold keys, and addKey/setValueAtKey are separate calls.
 *
 * `tClip` is CLIP-relative seconds (0 = the clip's own start). If keyframes ever
 * come out clustered at the head of the sequence instead of on their clips, this
 * is the line to check first — some builds are reported to address ComponentParam
 * keys in SEQUENCE time, in which case the callers need step.tIn added on. It is
 * written clip-relative here because that is what the documented Motion
 * parameter behaviour describes.
 */
function _ppKey(param, tClip, value, interp) {
    if (!param) return false;
    try {
        var t = _ppTime(tClip);
        try { param.setTimeVarying(true); } catch (e) { }
        try { param.addKey(t); } catch (e2) { }
        try { param.setValueAtKey(t, value, true); }
        catch (e3) {
            try { param.setValueAtKey(t, value); } catch (e4) { return false; }
        }
        if (interp) {
            try { param.setInterpolationTypeAtKey(t, interp, true); } catch (e5) { }
        }
        return true;
    } catch (e6) { return false; }
}

/**
 * Keyframe one placed clip for its step.
 *
 * Everything here is best-effort: a build that refuses to keyframe still gets
 * correctly timed, correctly styled, editable text on the timeline — it just
 * doesn't move.
 *
 *   wordappear — hard cut. Opacity holds at 100; no motion.
 *   word       — the caption's FIRST clip rises into place (Position) and fades
 *                up; later clips cut in, so already-visible words don't jump
 *                (a single text object can't slide only its newest word).
 *   karaoke    — every clip pops slightly at its start, so the beat lands on
 *                the word being spoken.
 */
function _ppAnimateClip(tItem, step, anim, style, seqW, seqH) {
    var dur = step.tOut - step.tIn;
    if (dur <= 0) return;

    var spd = parseFloat(style.animSpeed) || 1;
    var motion  = _ppFindComponent(tItem, ['ADBE Motion', 'motion']);
    var opacity = _ppFindParam(_ppFindComponent(tItem, ['ADBE Opacity', 'opacity']), ['opacity']);

    // Fade the very end of a caption out, and the very start in, so cuts
    // between captions aren't hard flashes. Word steps inside one caption cut.
    var FADE = Math.min(0.10, dur * 0.35);

    if (anim === 'word' && step.isFirst) {
        var pos  = _ppFindParam(motion, ['position']);
        var rise = (seqH || 1080) * 0.035;          // ~38px in a 1080 sequence
        var riseDur = Math.min(Math.max(0.14, dur * 0.55), 0.34) * spd;
        if (pos) {
            // Motion Position is normalised (0..1 of frame), so the rise is a
            // fraction of frame height rather than pixels.
            var base = null;
            try { base = pos.getValue(); } catch (e) { }
            if (base && base.length >= 2) {
                var fromY = base[1] + (rise / (seqH || 1080));
                _ppKey(pos, 0,       [base[0], fromY],   PP_KF_BEZIER);
                _ppKey(pos, riseDur, [base[0], base[1]], PP_KF_BEZIER);
            }
        }
        if (opacity) {
            _ppKey(opacity, 0,    0,   PP_KF_BEZIER);
            _ppKey(opacity, FADE, 100, PP_KF_BEZIER);
        }
    }

    if (anim === 'karaoke') {
        var scale = _ppFindParam(motion, ['scale']);
        if (scale) {
            var s0 = 100;
            try { var sv = scale.getValue(); if (typeof sv === 'number') s0 = sv; } catch (e) { }
            var beat = Math.min(0.075, dur * 0.4);
            _ppKey(scale, 0,          s0,          PP_KF_BEZIER);
            _ppKey(scale, beat,       s0 * 1.075,  PP_KF_BEZIER);
            _ppKey(scale, beat * 2.4, s0,          PP_KF_BEZIER);
        }
        if (opacity && step.isFirst) {
            _ppKey(opacity, 0,    0,   PP_KF_BEZIER);
            _ppKey(opacity, FADE, 100, PP_KF_BEZIER);
        }
    }

    // Tail fade on the clip that ends the caption.
    if (step.isLast && opacity) {
        _ppKey(opacity, Math.max(0, dur - FADE), 100, PP_KF_BEZIER);
        _ppKey(opacity, dur, 0, PP_KF_BEZIER);
    }
}

/**
 * Put the caption text on a freshly placed graphic clip.
 *
 * Two routes, in order of how well the result behaves afterwards:
 *   1. Essential Graphics parameters (getMGTComponent → getProperties). A
 *      Premiere-authored template exposes its source text here, and text set
 *      this way stays editable in the Essential Graphics panel.
 *   2. The AE "Capsule" JSON blob, which is all an AE-exported template gives
 *      us. Works, but the result is not EG-editable — the template, not this
 *      code, is the limit.
 *
 * Deliberately kept separate from the equivalent block in _tryMOGRTCaptions:
 * that path is load-bearing and tuned against real templates, and this one
 * needs a different order of preference. Changing one must not risk the other.
 */
function _ppSetClipText(tItem, text, diagInfo, wantDiag) {
    var esc = String(text)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '');

    // ── 1. Essential Graphics source text ────────────────────────────
    try {
        var mgt = (typeof tItem.getMGTComponent === 'function') ? tItem.getMGTComponent() : null;
        if (mgt && mgt.getProperties) {
            var props = mgt.getProperties();
            var pn = (props && props.numItems !== undefined) ? props.numItems : 0;
            for (var i = 0; i < pn; i++) {
                try {
                    var p = props[i];
                    var nm = '';
                    var ty = '';
                    var curr = null;
                    try { nm = String(p.displayName || '').toLowerCase(); } catch (e) { }
                    try { ty = p.getType ? String(p.getType()).toLowerCase() : ''; } catch (e) { }
                    try { curr = p.getValue ? p.getValue() : null; } catch (e) { }

                    var looksTextual = ty.indexOf('text') >= 0 || ty.indexOf('source') >= 0 ||
                                       ty.indexOf('string') >= 0 || ty === '2' ||
                                       nm.indexOf('text') >= 0 || nm.indexOf('caption') >= 0 ||
                                       (typeof curr === 'string' && curr.length > 0);
                    if (!looksTextual) continue;

                    var candidates = [];
                    if (typeof curr === 'string' && curr.indexOf('textEditValue') >= 0) {
                        candidates.push(curr.replace(
                            /"textEditValue"\s*:\s*"(?:[^"\\]|\\.)*"/,
                            '"textEditValue":"' + esc + '"'));
                    }
                    candidates.push(String(text));
                    candidates.push('{"textEditValue":"' + esc + '"}');

                    for (var ci = 0; ci < candidates.length; ci++) {
                        try { p.setValue(candidates[ci], 1); }
                        catch (s1) { try { p.setValue(candidates[ci]); } catch (s2) { continue; } }
                        var rb = '';
                        try { rb = p.getValue ? String(p.getValue()) : ''; } catch (e) { }
                        if (rb.indexOf(text) >= 0) {
                            if (wantDiag) diagInfo.nativeTextRoute = 'essential-graphics';
                            return true;
                        }
                    }
                } catch (pe) { }
            }
        }
    } catch (egErr) { }

    // ── 2. AE Capsule JSON blob ──────────────────────────────────────
    try {
        var comps = tItem.components;
        var cn = (comps && comps.numItems !== undefined) ? comps.numItems : 0;
        for (var c = 0; c < cn; c++) {
            var cmp = comps[c];
            var mn = '';
            try { mn = String(cmp.matchName || ''); } catch (e) { }
            if (mn.indexOf('Capsule') < 0) continue;

            var ppn = (cmp.properties && cmp.properties.numItems !== undefined)
                      ? cmp.properties.numItems : 0;
            for (var q = 0; q < ppn; q++) {
                var sp, raw = null;
                try { sp = cmp.properties[q]; raw = sp.getValue ? sp.getValue() : null; } catch (e) { continue; }
                if (typeof raw !== 'string' || raw.length === 0 || raw.charAt(0) !== '{') continue;

                var keys = ['capPropTextEdit', 'capPropText', 'capPropSourceText',
                            'capPropTextEditValue', 'textEditValue'];
                for (var k = 0; k < keys.length; k++) {
                    var pat = new RegExp('"' + keys[k] + '"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"');
                    if (!pat.test(raw)) continue;
                    var next = raw.replace(pat, '"' + keys[k] + '":"' + esc + '"');
                    try { sp.setValue(next, 1); }
                    catch (e1) { try { sp.setValue(next); } catch (e2) { continue; } }
                    var back = '';
                    try { back = sp.getValue ? String(sp.getValue()) : ''; } catch (e) { }
                    if (back.indexOf(text) >= 0) {
                        if (wantDiag) diagInfo.nativeTextRoute = 'ae-capsule';
                        return true;
                    }
                }
            }
        }
    } catch (capErr) { }

    if (wantDiag) diagInfo.nativeTextRoute = 'none';
    return false;
}

/**
 * Push the panel's Customize settings onto a placed clip's Essential Graphics
 * parameters — font, size, colour, vertical position. The old path ignored
 * these entirely in Premiere, so a caption came out looking however the
 * template was authored.
 *
 * Every one is optional: a template that doesn't expose a parameter simply
 * keeps its authored value.
 *
 * NOTE on karaoke: a true per-word highlight needs the template to expose a
 * second, highlight-coloured text layer (or a colour parameter that can be
 * keyed per word). None of the bundled templates do, so karaoke ports as a
 * beat on each spoken word instead of a colour sweep. Bundling a
 * Premiere-authored template with a "Highlight" colour parameter is what
 * unlocks the real thing — no change needed here beyond reading it.
 */
function _ppApplyStyleParams(tItem, style, seqW, seqH, diagInfo, wantDiag) {
    var applied = [];
    var mgt = null;
    try { mgt = (typeof tItem.getMGTComponent === 'function') ? tItem.getMGTComponent() : null; }
    catch (e) { return applied; }
    if (!mgt || !mgt.getProperties) return applied;

    var props;
    try { props = mgt.getProperties(); } catch (e) { return applied; }
    var pn = (props && props.numItems !== undefined) ? props.numItems : 0;

    // `avoid` keeps "Font" from matching a "Font Size" slider, which would push a
    // PostScript name into a numeric parameter.
    function findByName(needles, avoid) {
        for (var i = 0; i < pn; i++) {
            try {
                var p = props[i];
                var nm = String(p.displayName || '').toLowerCase();
                var skip = false;
                if (avoid) {
                    for (var a = 0; a < avoid.length; a++) {
                        if (nm.indexOf(avoid[a]) >= 0) { skip = true; break; }
                    }
                }
                if (skip) continue;
                for (var k = 0; k < needles.length; k++) {
                    if (nm.indexOf(needles[k]) >= 0) return p;
                }
            } catch (e) { }
        }
        return null;
    }

    // Font size — the panel's value is authored against a 1080 short edge.
    var sizeParam = findByName(['size', 'font size']);
    if (sizeParam && style.fontSize) {
        var shortEdge = Math.min(seqW || 1920, seqH || 1080);
        var scaled = Math.max(10, Math.round((parseFloat(style.fontSize) || 60) * (shortEdge / 1080)));
        try { sizeParam.setValue(scaled, 1); applied.push('size'); } catch (e) { }
    }

    // Fill colour — EG colour params take [r,g,b,a] in 0..1.
    var colorParam = findByName(['color', 'colour', 'fill']);
    if (colorParam && style.textColor) {
        var rgb = _hexToRGB01(style.textColor);
        try { colorParam.setValue([rgb.r, rgb.g, rgb.b, 1], 1); applied.push('color'); } catch (e) { }
    }

    // Font (PostScript name from the panel's font picker).
    var fontParam = findByName(['font'], ['size', 'color', 'colour']);
    if (fontParam && style.font && fontParam !== sizeParam) {
        try { fontParam.setValue(String(style.font), 1); applied.push('font'); } catch (e) { }
    }

    // Vertical position — normalised, matching the AE placement fractions.
    var posParam = findByName(['position']);
    if (posParam) {
        var y = (style.position === 'center') ? 0.50
              : (style.position === 'top')    ? 0.10
              :                                 0.88;
        try { posParam.setValue([0.5, y], 1); applied.push('position'); } catch (e) { }
    }

    if (wantDiag) diagInfo.nativeStyleParams = applied.length ? applied.join(',') : 'none';
    return applied;
}

/**
 * Place every caption as one or more keyframed, Essential-Graphics-editable
 * text clips on a dedicated video track.
 *
 * Returns { placed, method, clipCount }. placed:false means the caller should
 * fall back to the legacy path — nothing partial is left behind that the
 * fallback can't simply overwrite on its own new track.
 */
function _tryNativeAnimatedCaptions(validCaps, seq, mogrPath, style, data, diagInfo) {
    var anim = style.animation;

    if (!mogrPath) return { placed: false, method: 'native-no-mogrt-path' };
    var mogrFile = new File(mogrPath);
    if (!mogrFile.exists) return { placed: false, method: 'native-mogrt-missing' };
    if (typeof seq.importMGT !== 'function') return { placed: false, method: 'native-no-importmgt' };

    var seqW = parseInt(data.seqWidth, 10)  || 1920;
    var seqH = parseInt(data.seqHeight, 10) || 1080;

    // ── Caption track: a new one on top, else the highest empty track ──
    var before = seq.videoTracks.numTracks;
    var trackIdx = before;
    try {
        seq.addVideoTrack();
        trackIdx = seq.videoTracks.numTracks - 1;
    } catch (ate) {
        trackIdx = -1;
        for (var t = before - 1; t >= 0; t--) {
            try { if (seq.videoTracks[t].clips.numItems === 0) { trackIdx = t; break; } } catch (e) { }
        }
        if (trackIdx < 0) return { placed: false, method: 'native-no-track' };
    }
    diagInfo.trackIdx = trackIdx;

    // ── Build the full clip list up front ────────────────────────────
    var sorted = validCaps.slice().sort(function (a, b) { return a.startTime - b.startTime; });
    var steps = [];
    for (var ci = 0; ci < sorted.length; ci++) {
        var cap = sorted[ci];
        var capSteps = _ppAnimSteps(cap, anim);
        for (var si = 0; si < capSteps.length; si++) {
            var s = capSteps[si];
            // Auto-emoji rides on the caption's last step, so it lands once the
            // whole line is up rather than leading the first word.
            s.isLast = (si === capSteps.length - 1);
            if (s.isLast && style.emojiOn && cap.emoji) s.text = s.text + ' ' + cap.emoji;
            s.capIndex = ci;
            steps.push(s);
        }
    }
    diagInfo.nativeSteps = steps.length;

    var placed = 0, textSet = 0, animated = 0;

    for (var i = 0; i < steps.length; i++) {
        var step = steps[i];
        var dur  = step.tOut - step.tIn;
        if (dur < 0.02) continue;

        // ── Place ────────────────────────────────────────────────────
        var tItem = null;
        try { tItem = seq.importMGT(mogrPath, _ppTicks(step.tIn), trackIdx, 0); }
        catch (im1) {
            try { tItem = seq.importMGT(mogrPath, step.tIn, trackIdx, 0); } catch (im2) { }
        }
        // Some builds return undefined even after placing — find it by start.
        if (!tItem) {
            try {
                var trk = seq.videoTracks[trackIdx];
                for (var fi = 0; fi < trk.clips.numItems; fi++) {
                    try {
                        var cc = trk.clips[fi];
                        if (Math.abs(cc.start.seconds - step.tIn) < 0.05) { tItem = cc; break; }
                    } catch (e) { }
                }
            } catch (e) { }
        }
        if (!tItem) {
            if (i === 0) {
                diagInfo.errors.push('native: importMGT failed on the first clip at t=' +
                    step.tIn.toFixed(3) + 's track=' + trackIdx);
            }
            continue;
        }
        placed++;

        // ── Trim to the step's length (source-relative = duration) ───
        try { tItem.setOutPoint(_ppTime(dur), 1); }
        catch (te) {
            try { tItem.end = _ppTime(step.tOut); } catch (te2) { }
        }

        // ── Text, style, motion ──────────────────────────────────────
        var textOk = _ppSetClipText(tItem, step.text, diagInfo, i === 0);
        if (textOk) textSet++;

        // Probe on the first clip: if this template exposes nothing writable,
        // stop here rather than filling a whole track with the template's
        // placeholder text. Undo the probe clip and let the legacy path — which
        // carries extra brute-force strategies — try on its own track.
        if (i === 0 && !textOk) {
            try { tItem.remove(false, false); } catch (re) { }
            diagInfo.errors.push('native: template exposes no writable text parameter');
            return { placed: false, method: 'native-no-text-param', clipCount: 0 };
        }

        _ppApplyStyleParams(tItem, style, seqW, seqH, diagInfo, i === 0);
        try { _ppAnimateClip(tItem, step, anim, style, seqW, seqH); animated++; }
        catch (ae) { if (i === 0) diagInfo.errors.push('native: keyframes: ' + ae.toString()); }
    }

    diagInfo.nativePlaced   = placed;
    diagInfo.nativeTextSet  = textSet;
    diagInfo.nativeAnimated = animated;
    $.writeln('[PR-native] ' + placed + '/' + steps.length + ' clips, ' +
              textSet + ' with text, ' + animated + ' keyframed');

    if (placed === 0) return { placed: false, method: 'native-place-zero', clipCount: 0 };

    return {
        placed:    true,
        method:    'native-' + anim + (diagInfo.nativeTextRoute ? '-' + diagInfo.nativeTextRoute : ''),
        clipCount: placed
    };
}


// ═══════════════════════════════════════════════════════════════════
//  AFTER EFFECTS  ──  Clip Info
// ═══════════════════════════════════════════════════════════════════

function _getClipInfoAE(scope) {
    try {
        var activeItem = app.project.activeItem;
        if (!activeItem || !(activeItem instanceof CompItem)) {
            return _ckStringify({ error: 'No active composition. Open a composition first.' });
        }
        var comp = activeItem;

        if (scope === 'selected') {
            var selLayers = comp.selectedLayers;
            if (selLayers.length === 0) {
                return _ckStringify({ error: 'No layer selected. Select a footage layer in the timeline.' });
            }

            var layer = selLayers[0];
            if (!layer.source || !layer.source.file) {
                return _ckStringify({ error: 'Selected layer has no source file. Select an audio or video layer.' });
            }

            // Transcribe ONLY the trimmed/visible portion of the source, not the
            // whole media file. layer.startTime is the comp time at which the
            // source's frame 0 would play, so the source range actually shown is
            // [inPoint - startTime, outPoint - startTime]. Extracting that exact
            // range makes word timestamps line up with the comp: a word at audio
            // time t lands at comp time (inPoint + t). (Previously this used
            // [0, outPoint-inPoint], which mis-synced any clip trimmed from its
            // start.)
            var srcIn  = layer.inPoint  - layer.startTime;
            var srcOut = layer.outPoint - layer.startTime;
            if (srcIn  < 0) srcIn  = 0;
            if (srcOut <= srcIn) srcOut = srcIn + (layer.outPoint - layer.inPoint);

            return _ckStringify({
                mediaPath:         layer.source.file.fsName,
                startTime:         srcIn,
                endTime:           srcOut,
                timelineStartTime: layer.inPoint,
                timelineEndTime:   layer.outPoint,
                name:              layer.name,
                compName:          comp.name,
                compWidth:         comp.width,
                compHeight:        comp.height,
                compFrameRate:     comp.frameRate
            });

        } else {
            // Full composition — collect ALL audio-bearing footage layers
            // (sorted by timeline position) so the whole comp's audio is
            // transcribed, not just the first clip. Each entry maps a source
            // file + its in/out to a timeline position; main.js concatenates
            // them and remaps the timestamps back onto the timeline.
            var clips = [];
            for (var i = 1; i <= comp.numLayers; i++) {
                var l = comp.layer(i);
                if (!l.source || !l.source.file) continue;   // skip text/shape/solid layers
                if (l.hasAudio === false)         continue;   // skip silent footage (graphics, stills)
                if (l.audioEnabled === false)     continue;   // skip muted layers (audio switch off)

                // Portion of the source used by this layer (account for trim + start offset)
                var srcIn  = l.inPoint  - l.startTime;
                var srcOut = l.outPoint - l.startTime;
                if (srcOut <= srcIn) continue;

                clips.push({
                    mediaPath:     l.source.file.fsName,
                    startTime:     srcIn,        // source in-point (seconds)
                    endTime:       srcOut,       // source out-point (seconds)
                    timelineStart: l.inPoint     // position on the comp timeline
                });
            }

            if (clips.length === 0) {
                return _ckStringify({ error: 'No audio layers found in this composition. Add a video/audio layer and try again.' });
            }

            // Sort by timeline position so concat order matches the timeline
            clips.sort(function(a, b) { return a.timelineStart - b.timelineStart; });

            return _ckStringify({
                isFullSequence:    true,
                clips:             clips,
                timelineStartTime: 0,
                timelineEndTime:   comp.duration,
                name:              comp.name,
                compName:          comp.name,
                compWidth:         comp.width,
                compHeight:        comp.height,
                seqWidth:          comp.width,
                seqHeight:         comp.height,
                compFrameRate:     comp.frameRate,
                isFullComp:        true
            });
        }
    } catch (e) {
        return _ckStringify({ error: 'getClipInfoAE: ' + e.toString() });
    }
}


// ═══════════════════════════════════════════════════════════════════
//  AFTER EFFECTS  ──  Place Captions
// ═══════════════════════════════════════════════════════════════════

function _placeCaptionsAE(data) {
    // ── Pre-flight: scripting must be allowed ──────────────────────
    // AE will silently do nothing if "Allow Scripts to Write Files
    // and Access Network" is off. Detect this early.
    try {
        var testFile = new File(Folder.temp.fsName + '/_pulse_test.tmp');
        testFile.open('w');
        testFile.write('1');
        testFile.close();
        testFile.remove();
    } catch (scriptingErr) {
        return _ckStringify({
            success: false,
            error: 'After Effects scripting access is disabled. Go to Preferences → Scripting & Expressions → "Allow Scripts to Write Files and Access Network", then try again.'
        });
    }

    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return _ckStringify({ success: false, error: 'No active composition. Click on the composition in the Project panel first.' });
        }

        var captions = data.captions;
        var style    = data.style;

        if (!captions || captions.length === 0) {
            return _ckStringify({ success: false, error: 'No captions in data.' });
        }

        // ── Vertical position ──────────────────────────────────────
        var yPos;
        var xPos = comp.width / 2;
        if (style.position === 'center')     yPos = comp.height * 0.50;
        else if (style.position === 'top')   yPos = comp.height * 0.10;
        else                                 yPos = comp.height * 0.88; // bottom (default)

        var fontSize   = style.fontSize || 60;
        // The chosen size is defined against a standard 1080 comp (1920×1080
        // horizontal or 1080×1920 vertical both have a 1080 short edge). Scale
        // it to THIS comp so captions keep the same relative size everywhere —
        // proxies and small comps shrink, 4K grows. Standard comps unchanged.
        var compScale = Math.min(comp.width, comp.height) / 1080;
        if (compScale > 0 && compScale !== 1) fontSize = Math.max(10, Math.round(fontSize * compScale));
        // Minimal look: small tracked caps — scale the chosen size down.
        if (style.animation === 'minimal') fontSize = Math.max(14, Math.round(fontSize * 0.6));
        // Cinematic reads as a title card, not a caption: smaller and tracked.
        if (style.animation === 'cinematic') fontSize = Math.max(14, Math.round(fontSize * 0.52));
        var textRGB    = _hexToRGB01(style.textColor || '#ffffff');

        // Box size: full usable width, tall enough for 2 lines
        var boxW = comp.width  * 0.92;
        var boxH = fontSize * 2.8;

        // emoji → PNG path, written by the panel (see AIEmoji.renderAssets).
        var emojiAssets = data.emojiAssets || {};
        var emojiFootage = {};      // path → FootageItem, imported once each

        app.beginUndoGroup('Yashkit Captions — Place');

        var placed = 0;
        var cachedAnchorY = null;   // (legacy) kept for safety
        var rectCache = {};         // text-bounds cache keyed by "text|fontSize"

        for (var i = 0; i < captions.length; i++) {
            var cap = captions[i];

            // Guard: skip captions with zero or invalid duration
            var tIn  = parseFloat(cap.startTime) || 0;
            var tOut = parseFloat(cap.endTime)   || 0;
            if (tOut <= tIn) tOut = tIn + 0.5; // minimum 0.5s visibility

            // Clamp to comp bounds
            if (tIn  > comp.duration) tIn  = comp.duration - 0.1;
            if (tOut > comp.duration) tOut = comp.duration;
            if (tIn  < 0)            tIn  = 0;
            if (tOut < 0)            tOut = 0.5;

            // ── Two-line looks (Emphasis / Font Pair) build their own pair
            //    of layers; skip the single-layer path entirely. Falls back
            //    to the normal path for very short captions (< 3 words). ──
            if (style.animation === 'emphasis' || style.animation === 'fontpair') {
                var placedPair = false;
                try {
                    placedPair = _placeTwoLineCaption(comp, cap, style, tIn, tOut,
                        xPos, yPos, fontSize, textRGB);
                } catch (pairErr) { placedPair = false; }
                if (placedPair) { placed++; continue; }
            }

            // Hormozi / Iman Gadzhi / Minimal looks render in ALL CAPS.
            // Uppercasing here (not on the stored caption) keeps the
            // transcript/SRT untouched; word lengths are unchanged so
            // per-word highlight indices still line up.
            var wantsCaps = (style.animation === 'hormozi'   ||
                             style.animation === 'gadzhi'    ||
                             style.animation === 'minimal'   ||
                             style.animation === 'gaming'    ||
                             style.animation === 'cinematic');
            var baseText = wantsCaps
                ? String(cap.text == null ? '' : cap.text).toUpperCase()
                : cap.text;

            // ── Auto-emoji ─────────────────────────────────────────
            // cap.emoji is one emoji chosen by the LLM in the panel ('' for
            // most captions — see js/ai-emoji.js).
            //
            // It is NOT put into the text. After Effects cannot render
            // colour-emoji fonts (Apple Color Emoji is sbix, Segoe UI Emoji is
            // COLR) — an emoji in a text layer comes out blank or as a tofu
            // box. The panel rasterises each one to a PNG and passes the path
            // in data.emojiAssets; it goes into the comp as its own footage
            // layer, placed beside the caption (see _addEmojiLayer).
            //
            // So the layer's text stays exactly the words, char indices stay
            // put, and the per-word animators need no offset.
            // No PNG (no emoji font on that machine) means no emoji at all —
            // the panel has already warned about it. A tofu box in a caption is
            // worse than a caption without an emoji.
            var capEmoji   = (style.emojiOn && cap.emoji) ? String(cap.emoji) : '';
            var emojiPath  = (capEmoji && emojiAssets) ? emojiAssets[capEmoji] : null;
            var capText    = baseText;
            // 0 today: nothing is prefixed to the layer's text. Kept wired up
            // because anything that ever is — an inline emoji, a speaker
            // label — shifts every per-word character index (see
            // _wordCharIndices), and that failure is silent and hard to spot.
            var charOffset = 0;

            // Point text + measured-anchor centring is reliable on every AE
            // version. Box-text paragraph justification is inconsistent across
            // releases and was leaving captions left-aligned.
            var textLayer = comp.layers.addText(capText);

            // Name the layer after its actual caption text (so the timeline
            // reads "humanity" instead of "Caption 213"). Falls back to the id.
            textLayer.name     = _layerNameFromText(baseText, cap.id);
            textLayer.inPoint  = tIn;
            textLayer.outPoint = tOut;

            // ── Text styling ───────────────────────────────────────
            try {
                var textProp = textLayer
                    .property('ADBE Text Properties')
                    .property('ADBE Text Document');
                var doc = textProp.value;

                doc.text        = capText;
                doc.fontSize    = fontSize;
                doc.fillColor   = [textRGB.r, textRGB.g, textRGB.b];
                doc.applyFill   = true;

                // ── Outline ────────────────────────────────────────
                // The single biggest legibility win over busy footage. Gaming
                // owns a heavy one as part of its look; every other style takes
                // the panel's Outline setting.
                var wantStroke  = !!style.strokeOn || style.animation === 'gaming';
                var strokeHeavy = (style.animation === 'gaming') || style.strokeWeight === 'bold';
                doc.applyStroke = wantStroke;
                if (wantStroke) {
                    var sRGB = _hexToRGB01(style.strokeColor || '#000000');
                    try { doc.strokeColor = [sRGB.r, sRGB.g, sRGB.b]; } catch (scErr) {}
                    try { doc.strokeWidth = Math.max(1, Math.round(fontSize * (strokeHeavy ? 0.105 : 0.05))); }
                    catch (swErr) {}
                    // Stroke UNDER the fill keeps letter shapes crisp; over the
                    // fill it eats into thin strokes at caption sizes.
                    try { doc.strokeOverFill = false; } catch (sofErr) {}
                }

                // Wide letter-spacing for the tracked looks (tracking is
                // best-effort — not writable on some AE versions).
                if (style.animation === 'minimal') {
                    try { doc.tracking = 120; } catch (trkErr) {}
                } else if (style.animation === 'cinematic') {
                    try { doc.tracking = 260; } catch (trkErr2) {}
                }
                // Centre the text horizontally inside the box so we don't need a
                // per-layer render to find the horizontal centre.
                try { doc.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (jErr) {}

                // ── Font ───────────────────────────────────────────
                // Prefer the PostScript name from the font picker (the most
                // reliable way to pin an exact face); fall back to family/style.
                if (style.font) {
                    try { doc.font = style.font; }
                    catch (fontErr) {
                        try {
                            doc.fontFamily = style.fontFamily || style.font;
                            doc.fontStyle  = style.fontStyle  || 'Regular';
                        } catch (ff) {}
                    }
                } else if (style.fontFamily) {
                    try {
                        doc.fontFamily = style.fontFamily;
                        doc.fontStyle  = 'Regular';
                    } catch (fontFamilyErr) {
                        try { doc.font = style.fontFamily; } catch (fontErr2) {}
                    }
                }

                textProp.setValue(doc);
            } catch (styleErr) { /* text created, styling failed — continue */ }

            // ── Center on comp ─────────────────────────────────────
            // ── Centre on comp (horizontal + vertical) ─────────────
            // Measure the rendered text bounds, set the anchor to their centre,
            // then place the anchor at the comp's horizontal centre + chosen Y.
            // This centres every caption regardless of justification. The rect
            // is cached per "text|fontSize" (identical text ⇒ identical bounds)
            // so repeated words don't each pay for a render.
            // An emoji layer sits to the LEFT of the words, so the text shifts
            // right by half the emoji block and the pair stays centred as one
            // unit. textRect/textX are read again below to place the emoji.
            var emojiSize = emojiPath ? Math.round(fontSize * 1.02) : 0;
            var emojiGap  = emojiPath ? Math.round(fontSize * 0.26) : 0;
            var textRect  = null;
            var textX     = xPos;

            try {
                var xform = textLayer.property('ADBE Transform Group');
                var rcKey  = capText + '|' + fontSize;
                var cached = rectCache[rcKey];
                var rect;
                if (cached) {
                    // Same text measured before — reuse its (possibly shrunk)
                    // size so this layer matches without another render.
                    if (cached.fitSize && cached.fitSize !== fontSize) {
                        try {
                            var tpC  = textLayer.property('ADBE Text Properties').property('ADBE Text Document');
                            var docC = tpC.value;
                            docC.fontSize = cached.fitSize;
                            tpC.setValue(docC);
                        } catch (fitCacheErr) {}
                    }
                    rect = cached.rect;
                } else {
                    // Auto-fit: a caption must never run wider than the frame.
                    rect = _fitTextToWidth(textLayer, comp.width * 0.92, tIn);
                    var fitSize = fontSize;
                    try {
                        fitSize = textLayer.property('ADBE Text Properties')
                                           .property('ADBE Text Document').value.fontSize;
                    } catch (szErr) {}
                    rectCache[rcKey] = { rect: rect, fitSize: fitSize };
                }
                var anchorX = rect.left + rect.width  / 2;
                var anchorY = rect.top  + rect.height / 2;
                textRect = rect;
                if (emojiPath) textX = xPos + (emojiSize + emojiGap) / 2;
                xform.property('ADBE Anchor Point').setValue([anchorX, anchorY]);
                xform.property('ADBE Position').setValue([textX, yPos]);
            } catch (posErr) {
                try {
                    textLayer.property('ADBE Transform Group')
                             .property('ADBE Position').setValue([textX, yPos]);
                } catch (e2) {}
            }

            // ── Auto-emoji layer ───────────────────────────────────
            if (emojiPath) {
                try {
                    _addEmojiLayer(comp, emojiPath, emojiFootage, tIn, tOut,
                        xPos, yPos, textRect, emojiSize, emojiGap, style);
                } catch (emErr) { /* the caption still stands without it */ }
            }

            // ── Boxed look: rounded backing shape behind the text ──
            if (style.animation === 'boxed') {
                try {
                    var bEntry = rectCache[capText + '|' + fontSize];
                    var bRect  = (bEntry && bEntry.rect) ? bEntry.rect
                               : textLayer.sourceRectAtTime(tIn, false);
                    _addCaptionBacking(comp, textLayer, tIn, tOut, xPos, yPos, bRect, fontSize);
                } catch (bgErr) { /* backing is best-effort */ }
            }

            // ── Optional animation ─────────────────────────────────
            // A bundled .ffx preset takes precedence: apply it verbatim and
            // skip the built-in keyframe animations so they don't stack.
            if (style.ffxPath) {
                try {
                    var ffxFile = new File(style.ffxPath);
                    if (ffxFile.exists) textLayer.applyPreset(ffxFile);
                } catch (ffxErr) { /* preset is best-effort — never block placement */ }
            } else {
                try {
                    _applyCaptionAnimation(textLayer, style.animation, tIn, tOut, xPos, yPos, fontSize, {
                        words:      cap.words,
                        highlight:  _hexToRGB01(style.highlightColor || '#FFE000'),
                        speed:      parseFloat(style.animSpeed) || 1,
                        charOffset: charOffset
                    });
                }
                catch (animErr) { /* animation is best-effort — never block placement */ }
            }

            placed++;
        }

        app.endUndoGroup();

        return _ckStringify({
            success:      true,
            placed:       true,
            captionCount: placed,
            compName:     comp.name,
            message:      'Placed ' + placed + ' text layers in "' + comp.name + '"'
        });

    } catch (e) {
        try { app.endUndoGroup(); } catch (u) {}
        return _ckStringify({ success: false, error: '_placeCaptionsAE error: ' + e.toString() });
    }
}


// ═══════════════════════════════════════════════════════════════════
//  SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════


function _hexToRGB01(hex) {
    var r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!r) return { r: 1, g: 1, b: 1 };
    return {
        r: parseInt(r[1], 16) / 255,
        g: parseInt(r[2], 16) / 255,
        b: parseInt(r[3], 16) / 255
    };
}

// Turn caption text into a clean After Effects layer name: single line,
// collapsed whitespace, trimmed, length-capped. Falls back to "Caption <id>".
function _layerNameFromText(text, id) {
    var t = (text == null) ? '' : String(text);
    t = t.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ');
    // strip leading/trailing whitespace (ExtendScript has no String.trim)
    t = t.replace(/^\s+/, '').replace(/\s+$/, '');
    if (!t) return 'Caption ' + id;
    if (t.length > 40) t = t.substring(0, 39) + '…';   // … ellipsis
    return t;
}

// Apply an in/out animation to a caption text layer.
//   fade      → opacity fade in + out
//   pop       → scale overshoot (from centre) + quick fade
//   slide     → rise into place from below + fade
//   slidedown → drop into place from above + fade
//   blur      → Gaussian blur resolves from soft → sharp + fade
//   wipe      → feathered Linear Wipe reveal (Feather 200)
//   word       → per-word slide+fade reveal via a Text Animator
//   wordfade   → per-word fade-in reveal (no slide) via a Text Animator
//   wordappear → per-word HARD reveal (no fade) — each word pops in instantly
// All keyframes are eased and clamped so they never overlap on short clips.
function _applyCaptionAnimation(layer, anim, tIn, tOut, xPos, yPos, fontSize, opts) {
    if (!anim || anim === 'none') return;
    opts = opts || {};
    var capWords = opts.words || [];
    var hlRGB    = opts.highlight || { r: 1, g: 0.878, b: 0 };   // default #FFE000
    var spd      = opts.speed || 1;   // reveal-duration multiplier (Slow 1.5 / Fast .65)
    var chOff    = parseInt(opts.charOffset, 10) || 0;   // auto-emoji prefix length

    var dur    = Math.max(0.0, tOut - tIn);
    var inDur  = Math.min(0.20, dur * 0.40);
    var outDur = Math.min(0.16, dur * 0.35);
    if (inDur <= 0) return;

    var grp = layer.property('ADBE Transform Group');
    var op  = grp.property('ADBE Opacity');

    // ── Karaoke: full phrase visible, spoken word highlights in sync ──
    if (anim === 'karaoke') {
        op.setValueAtTime(tIn, 0);
        op.setValueAtTime(tIn + inDur, 100);
        if (tOut - outDur > tIn + inDur) op.setValueAtTime(tOut - outDur, 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);
        // One "word" means there's nothing to sweep — a translated CJK caption
        // has no spaces to split on, and highlighting the whole line just turns
        // it a solid colour. Leave it as the plain fade above.
        if (capWords && capWords.length > 1) _wordHighlight(layer, capWords, hlRGB, chOff);
        return;
    }

    // ── Hormozi: punch-in scale + per-word reveal + active-word accent ──
    if (anim === 'hormozi') {
        var punchIn = Math.min(0.09, dur * 0.30);
        op.setValueAtTime(tIn, 0);
        op.setValueAtTime(tIn + punchIn, 100);
        if (tOut - outDur > tIn + punchIn) op.setValueAtTime(tOut - outDur, 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);

        var scH  = grp.property('ADBE Scale');
        var baseH = scH.value;
        scH.setValueAtTime(tIn, [baseH[0] * 0.60, baseH[1] * 0.60]);
        scH.setValueAtTime(tIn + punchIn * 1.3, [baseH[0] * 1.10, baseH[1] * 1.10]);  // overshoot
        scH.setValueAtTime(tIn + punchIn * 2.0, baseH);
        _easeKeys(scH);

        if (capWords && capWords.length > 1) {
            _wordRevealByTiming(layer, capWords, chOff);
            _wordHighlight(layer, capWords, hlRGB, chOff);
        } else {
            _wordByWordAppear(layer, tIn, tOut, inDur);
        }
        return;
    }

    // ── Gaming: heavy outlined caps that PUNCH in, then settle with a
    //    micro-shake. Words arrive with the voice. The thick stroke is set on
    //    the text document (see the Outline block in _placeCaptionsAE) — this
    //    is the motion half of the look. ──
    if (anim === 'gaming') {
        var gPunch = Math.min(0.085, dur * 0.28);
        op.setValueAtTime(tIn, 0);
        op.setValueAtTime(tIn + gPunch * 0.6, 100);
        if (tOut - outDur > tIn + gPunch) op.setValueAtTime(tOut - outDur, 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);

        // Overshoot hard, snap back — the "impact" feel.
        var scGm  = grp.property('ADBE Scale');
        var baseG2 = scGm.value;
        scGm.setValueAtTime(tIn,                [baseG2[0] * 0.45, baseG2[1] * 0.45]);
        scGm.setValueAtTime(tIn + gPunch,       [baseG2[0] * 1.18, baseG2[1] * 1.18]);
        scGm.setValueAtTime(tIn + gPunch * 1.7, [baseG2[0] * 0.96, baseG2[1] * 0.96]);
        scGm.setValueAtTime(tIn + gPunch * 2.4, baseG2);
        _easeKeys(scGm);

        // Micro-shake on the way in: two frames of rotation either side of 0.
        try {
            var rotG = grp.property('ADBE Rotate Z');
            rotG.setValueAtTime(tIn,                -2.6);
            rotG.setValueAtTime(tIn + gPunch,        1.8);
            rotG.setValueAtTime(tIn + gPunch * 1.8, -0.7);
            rotG.setValueAtTime(tIn + gPunch * 2.6,  0);
            _easeKeys(rotG);
        } catch (rotErr) {}

        if (capWords && capWords.length > 1) _wordRevealByTiming(layer, capWords, chOff);
        return;
    }

    // ── Cinematic: a title card, not a caption. Slow fade up, a long slow
    //    push in (the drift that makes stills feel filmed), no per-word
    //    motion at all. Tracking + smaller size are set on the document. ──
    if (anim === 'cinematic') {
        var cIn  = Math.min(0.75, dur * 0.42);
        var cOut = Math.min(0.60, dur * 0.38);
        op.setValueAtTime(tIn, 0);
        op.setValueAtTime(tIn + cIn, 100);
        if (tOut - cOut > tIn + cIn) op.setValueAtTime(tOut - cOut, 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);

        // Drift across the WHOLE clip, not just the entrance — that's what
        // separates it from a plain scale-in.
        var scCin  = grp.property('ADBE Scale');
        var baseC  = scCin.value;
        scCin.setValueAtTime(tIn,  [baseC[0] * 0.965, baseC[1] * 0.965]);
        scCin.setValueAtTime(tOut, [baseC[0] * 1.025, baseC[1] * 1.025]);
        _easeKeys(scCin);
        return;
    }

    // ── Neon: the text glows and the glow breathes. Colour comes from the
    //    panel's text colour; the glow picks it up automatically. ──
    if (anim === 'neon') {
        op.setValueAtTime(tIn, 0);
        op.setValueAtTime(tIn + Math.min(0.18, dur * 0.35), 100);
        if (tOut - outDur > tIn + inDur) op.setValueAtTime(tOut - outDur, 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);

        try {
            var fxN = layer.property('ADBE Effect Parade');
            var glow;
            try { glow = fxN.addProperty('ADBE Glo2'); }        // Glow
            catch (g1) { glow = fxN.addProperty('ADBE Glow'); }
            // Glow Threshold / Radius / Intensity are properties 2/3/4 on both
            // the current and legacy effects; each set is best-effort.
            try { glow.property(2).setValue(38); } catch (e) {}
            var radius = glow.property(3);
            var intens = glow.property(4);
            try { radius.setValue(Math.max(6, Math.round(fontSize * 0.30))); } catch (e) {}

            // Breathe the intensity so it reads as a live sign, not a blur.
            try {
                var beat = Math.max(0.35, Math.min(0.85, dur / 3));
                var t = tIn, hi = true;
                intens.setValueAtTime(tIn, 1.0);
                while (t < tOut - 0.05) {
                    t += beat;
                    intens.setValueAtTime(Math.min(t, tOut), hi ? 1.9 : 1.1);
                    hi = !hi;
                }
                _easeKeys(intens);
            } catch (e) {
                try { intens.setValue(1.5); } catch (e2) {}
            }
        } catch (glowErr) { /* no Glow on this build — plain fade stands */ }

        if (capWords && capWords.length > 1) _wordRevealByTiming(layer, capWords, chOff);
        return;
    }

    // ── Ali Abdal: clean, minimal — gentle rise + soft fade, no accent ──
    if (anim === 'aliabdal') {
        op.setValueAtTime(tIn, 0);
        op.setValueAtTime(tIn + Math.min(0.28, dur * 0.5), 100);
        if (tOut - outDur > tIn + inDur) op.setValueAtTime(tOut - outDur, 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);

        var posA  = grp.property('ADBE Position');
        var riseA = (fontSize || 60) * 0.35;
        posA.setValueAtTime(tIn, [xPos, yPos + riseA]);
        posA.setValueAtTime(tIn + Math.min(0.34, dur * 0.6), [xPos, yPos]);
        _easeKeys(posA);
        return;
    }

    // ── Minimal: no entrance or exit at all — the caption cuts in and
    //    out with the layer (per design: no fade opening/closing). ──
    if (anim === 'minimal') return;

    // ── Iman Gadzhi: clean bold caps, words appear in sync with speech —
    //    like Hormozi's reveal but without the accent colour or big punch. ──
    if (anim === 'gadzhi') {
        var gIn = Math.min(0.10, dur * 0.30);
        op.setValueAtTime(tIn, 0);
        op.setValueAtTime(tIn + gIn, 100);
        if (tOut - outDur > tIn + gIn) op.setValueAtTime(tOut - outDur, 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);

        var scG  = grp.property('ADBE Scale');
        var baseG = scG.value;
        scG.setValueAtTime(tIn, [baseG[0] * 0.86, baseG[1] * 0.86]);
        scG.setValueAtTime(tIn + gIn * 1.6, baseG);
        _easeKeys(scG);

        if (capWords && capWords.length > 1) _wordRevealByTiming(layer, capWords, chOff);
        else _wordByWordAppear(layer, tIn, tOut, inDur);
        return;
    }

    // ── Word-by-word reveal animates per-word opacity itself, so the layer
    //    only needs a fade-out at the end (no layer-level fade-in). ──
    if (anim === 'word') {
        _wordByWordSlide(layer, tIn, tOut, inDur, fontSize, spd);
        op.setValueAtTime(Math.max(tIn, tOut - outDur), 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);
        return;
    }

    if (anim === 'wordfade') {
        _wordByWordFade(layer, tIn, tOut, inDur, spd);
        op.setValueAtTime(Math.max(tIn, tOut - outDur), 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);
        return;
    }

    if (anim === 'wordappear') {
        _wordByWordAppear(layer, tIn, tOut, inDur, spd);
        op.setValueAtTime(Math.max(tIn, tOut - outDur), 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);
        return;
    }

    // ── Spotlight: whole line visible, the SPOKEN word zooms in sync ──
    if (anim === 'spotlight') {
        op.setValueAtTime(tIn, 0);
        op.setValueAtTime(tIn + inDur, 100);
        if (tOut - outDur > tIn + inDur) op.setValueAtTime(tOut - outDur, 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);
        if (capWords && capWords.length > 1) _wordZoom(layer, capWords, 118, chOff);
        return;
    }

    // ── Shuffle: words pop in, but in RANDOM order ──
    if (anim === 'shuffle') {
        _wordShuffleAppear(layer, tIn, tOut, inDur, spd);
        op.setValueAtTime(Math.max(tIn, tOut - outDur), 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);
        return;
    }

    // ── Flip Up: words swing in one by one (rotation + fade) ──
    if (anim === 'flipup') {
        _wordFlipUp(layer, tIn, tOut, inDur, spd);
        op.setValueAtTime(Math.max(tIn, tOut - outDur), 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);
        return;
    }

    // ── Pulse: the whole caption beats on every spoken word ──
    if (anim === 'pulse') {
        op.setValueAtTime(tIn, 0);
        op.setValueAtTime(tIn + Math.min(0.1, dur * 0.3), 100);
        if (tOut - outDur > tIn + inDur) op.setValueAtTime(tOut - outDur, 100);
        op.setValueAtTime(tOut, 0);
        _easeKeys(op);
        _pulseOnWords(layer, capWords, tIn, tOut);
        return;
    }

    // ── Opacity: fade in, hold, fade out (shared by the rest) ──
    op.setValueAtTime(tIn, 0);
    op.setValueAtTime(tIn + inDur, 100);
    if (tOut - outDur > tIn + inDur) op.setValueAtTime(tOut - outDur, 100);
    op.setValueAtTime(tOut, 0);
    _easeKeys(op);

    if (anim === 'pop') {
        var sc = grp.property('ADBE Scale');
        var base = sc.value;   // typically [100, 100]
        sc.setValueAtTime(tIn, [base[0] * 0.55, base[1] * 0.55]);
        sc.setValueAtTime(tIn + inDur * 0.75, [base[0] * 1.08, base[1] * 1.08]);   // overshoot
        sc.setValueAtTime(tIn + inDur, base);
        _easeKeys(sc);
    } else if (anim === 'bounce') {
        // Playful settle: small → big overshoot → dip → light overshoot → rest
        // (mirrors the panel's pvBO preview curve).
        var scB   = grp.property('ADBE Scale');
        var baseB = scB.value;
        var bDur  = Math.max(inDur, Math.min(0.34, dur * 0.5));
        scB.setValueAtTime(tIn,               [baseB[0] * 0.30, baseB[1] * 0.30]);
        scB.setValueAtTime(tIn + bDur * 0.40, [baseB[0] * 1.20, baseB[1] * 1.20]);
        scB.setValueAtTime(tIn + bDur * 0.65, [baseB[0] * 0.92, baseB[1] * 0.92]);
        scB.setValueAtTime(tIn + bDur * 0.85, [baseB[0] * 1.05, baseB[1] * 1.05]);
        scB.setValueAtTime(tIn + bDur,        baseB);
        _easeKeys(scB);
    } else if (anim === 'type') {
        _typewriterIn(layer, tIn, tOut);
    } else if (anim === 'slide' || anim === 'slidedown') {
        var pos  = grp.property('ADBE Position');
        var rise = (fontSize || 60) * 0.8;
        var fromY = (anim === 'slidedown') ? (yPos - rise) : (yPos + rise);
        pos.setValueAtTime(tIn, [xPos, fromY]);
        pos.setValueAtTime(tIn + inDur, [xPos, yPos]);
        _easeKeys(pos);
    } else if (anim === 'blur') {
        _blurIn(layer, tIn, inDur, tOut, outDur);
    } else if (anim === 'wipe') {
        _linearWipe(layer, tIn, inDur, tOut, outDur);
    }
}

// Gaussian-blur resolve: soft → sharp on the way in, sharp → soft on the way out.
function _blurIn(layer, tIn, inDur, tOut, outDur) {
    var fx = layer.property('ADBE Effect Parade');
    var blur;
    try { blur = fx.addProperty('ADBE Gaussian Blur 2'); }
    catch (e) { blur = fx.addProperty('ADBE Gaussian Blur'); }
    var b = blur.property(1);   // Blurriness
    b.setValueAtTime(tIn, 60);
    b.setValueAtTime(tIn + inDur, 0);
    if (tOut - outDur > tIn + inDur) b.setValueAtTime(tOut - outDur, 0);
    b.setValueAtTime(tOut, 60);
    _easeKeys(b);
}

// Feathered Linear Wipe reveal. Feather = 200 (per spec). Transition
// Completion 100 (hidden) → 0 (visible) on the way in, and back out.
// Properties are looked up by matchName with an index fallback so a property
// name mismatch on some AE version can't silently kill the whole animation.
function _linearWipe(layer, tIn, inDur, tOut, outDur) {
    var fx = layer.property('ADBE Effect Parade');
    var wipe;
    try { wipe = fx.addProperty('ADBE Linear Wipe'); }
    catch (addErr) { return; }   // effect not installed — skip gracefully

    function prop(matchName, idx) {
        try { return wipe.property(matchName); } catch (e) {}
        try { return wipe.property(idx); }       catch (e) {}
        return null;
    }
    var comp    = prop('ADBE Linear Wipe-0001', 1);   // Transition Completion
    var angle   = prop('ADBE Linear Wipe-0002', 2);   // Wipe Angle
    var feather = prop('ADBE Linear Wipe-0003', 3);   // Feather
    if (angle)   { try { angle.setValue(280); }   catch (e) {} }   // default wipe angle
    if (feather) { try { feather.setValue(200); } catch (e) {} }
    if (!comp) return;

    var revealDur = Math.min(inDur * 1.6, Math.max(inDur, (tOut - tIn) * 0.5));
    comp.setValueAtTime(tIn, 100);
    comp.setValueAtTime(tIn + revealDur, 0);
    if (tOut - outDur > tIn + revealDur) comp.setValueAtTime(tOut - outDur, 0);
    comp.setValueAtTime(tOut, 100);
    _easeKeys(comp);
}

// Word-by-word slide-in using a Text Animator + Range Selector based on Words.
// Each word starts pushed down and invisible, then snaps into place in reading
// order as the selector's Start sweeps 0 → 100%.
function _wordByWordSlide(layer, tIn, tOut, inDur, fontSize, spd) {
    var animators = layer.property('ADBE Text Properties').property('ADBE Text Animators');
    var animator  = animators.addProperty('ADBE Text Animator');
    var aProps    = animator.property('ADBE Text Animator Properties');

    // Per-word offset: pushed down + fully transparent until revealed.
    try { aProps.addProperty('ADBE Text Position 3D').setValue([0, (fontSize || 60) * 0.9, 0]); } catch (e) {}
    try { aProps.addProperty('ADBE Text Opacity').setValue(0); } catch (e) {}

    var sel = animator.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    var advS = sel.property('ADBE Text Range Advanced');
    // Base the range on whole Words (Based On lives under the Advanced group).
    try { advS.property('ADBE Text Range Type2').setValue(3); } catch (e) {}
    // Full smoothness → each word ramps gently instead of snapping.
    try { advS.property('ADBE Text Selector Smoothness').setValue(100); } catch (e) {}

    var start = sel.property('ADBE Text Percent Start');
    var revealDur = Math.min(0.9, Math.max(inDur, (tOut - tIn) * 0.7)) * (spd || 1);
    revealDur = Math.min(revealDur, Math.max(0.15, (tOut - tIn) * 0.9));
    start.setValueAtTime(tIn, 0);
    start.setValueAtTime(tIn + revealDur, 100);
    _easeKeys(start);
}

// Word-by-word fade-in using a Text Animator + Range Selector based on Words.
// Each word starts fully transparent, then fades into view in reading order
// as the selector's Start sweeps 0 → 100%. No position offset — pure opacity.
function _wordByWordFade(layer, tIn, tOut, inDur, spd) {
    var animators = layer.property('ADBE Text Properties').property('ADBE Text Animators');
    var animator  = animators.addProperty('ADBE Text Animator');
    var aProps    = animator.property('ADBE Text Animator Properties');

    // Per-word opacity: fully transparent until revealed.
    try { aProps.addProperty('ADBE Text Opacity').setValue(0); } catch (e) {}

    var sel = animator.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    // Base the range on whole Words.
    try { sel.property('ADBE Text Range Advanced').property('ADBE Text Range Type2').setValue(3); } catch (e) {}

    var start = sel.property('ADBE Text Percent Start');
    var revealDur = Math.min(0.9, Math.max(inDur, (tOut - tIn) * 0.7)) * (spd || 1);
    revealDur = Math.min(revealDur, Math.max(0.15, (tOut - tIn) * 0.9));
    start.setValueAtTime(tIn, 0);
    start.setValueAtTime(tIn + revealDur, 100);
    _easeKeys(start);
}

// Word-by-word HARD appear (no fade). Same Words-based selector as the fade
// version, but the selector Smoothness is forced to 0 so each word switches
// from invisible to fully visible instantly — words pop in one by one as the
// Start sweeps 0 → 100%, with no cross-fade between them.
function _wordByWordAppear(layer, tIn, tOut, inDur, spd) {
    var animators = layer.property('ADBE Text Properties').property('ADBE Text Animators');
    var animator  = animators.addProperty('ADBE Text Animator');
    var aProps    = animator.property('ADBE Text Animator Properties');

    // Per-word opacity: fully transparent until revealed.
    try { aProps.addProperty('ADBE Text Opacity').setValue(0); } catch (e) {}

    var sel = animator.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    var adv = sel.property('ADBE Text Range Advanced');
    // Base the range on whole Words.
    try { adv.property('ADBE Text Range Type2').setValue(3); } catch (e) {}
    // Smoothness 0 → hard edge → no fade as the boundary crosses each word.
    try { adv.property('ADBE Text Selector Smoothness').setValue(0); } catch (e) {}

    var start = sel.property('ADBE Text Percent Start');
    var revealDur = Math.min(0.9, Math.max(inDur, (tOut - tIn) * 0.7)) * (spd || 1);
    revealDur = Math.min(revealDur, Math.max(0.15, (tOut - tIn) * 0.9));
    start.setValueAtTime(tIn, 0);
    start.setValueAtTime(tIn + revealDur, 100);
    // Linear timing keeps a steady one-word-after-another cadence (no easing
    // ramp that would bunch the reveals together).
    try {
        var n = start.numKeys;
        for (var k = 1; k <= n; k++) {
            start.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        }
    } catch (e) {}
}

// Measure a text layer and, if it's wider than maxW, shrink its font size
// proportionally so it fits, then re-measure. Returns the final bounds (or
// null if measuring failed entirely). Keeps captions inside the frame on
// every comp size and orientation.
function _fitTextToWidth(layer, maxW, tIn) {
    var rect = null;
    try { rect = layer.sourceRectAtTime(tIn, false); } catch (e) { return null; }
    if (!rect || rect.width <= 0 || rect.width <= maxW) return rect;
    try {
        var tp  = layer.property('ADBE Text Properties').property('ADBE Text Document');
        var doc = tp.value;
        var newSize = Math.max(10, Math.floor(doc.fontSize * (maxW / rect.width)));
        doc.fontSize = newSize;
        tp.setValue(doc);
        rect = layer.sourceRectAtTime(tIn, false);
    } catch (e2) {}
    return rect;
}

// Two-line caption looks (per the creator reference: a small intro line over
// a bigger payoff line, appearing with a light emphasis pop).
//   emphasis → both lines in the chosen font; bottom line ~1.05×, top ~0.55×
//   fontpair → top line italic serif (Georgia), bottom line the chosen font
// Builds TWO text layers so each line can carry its own size/typeface, keeps
// the pair centred as one block on (xPos, yPos), and staggers their entrance
// (intro fades in, payoff pops in a beat later). Returns false for captions
// too short to split — the caller falls back to the single-layer path.
function _placeTwoLineCaption(comp, cap, style, tIn, tOut, xPos, yPos, fontSize, textRGB) {
    var words = String(cap.text == null ? '' : cap.text).replace(/\s+/g, ' ').split(' ');
    if (words.length < 3) return false;

    // Split point: the AI-weighted index computed in the panel (intro word
    // count), falling back to ~40% when it's missing or out of range.
    var mid = parseInt(cap.splitIndex, 10);
    if (!(mid >= 1 && mid < words.length)) {
        mid = Math.max(1, Math.min(words.length - 1, Math.floor(words.length * 0.4)));
    }
    var lineA = words.slice(0, mid).join(' ');
    var lineB = words.slice(mid).join(' ');

    // Auto-emoji rides on the payoff line, after the words — the intro line is
    // the small lead-in, so an emoji there would land on the wrong half. These
    // two layers animate by word percentage, not character index, so the extra
    // glyph needs no offset bookkeeping.
    if (style.emojiOn && cap.emoji) lineB = lineB + ' ' + String(cap.emoji);

    var isPair = (style.animation === 'fontpair');
    var sizeA  = Math.max(18, Math.round(fontSize * 0.55));
    var sizeB  = Math.round(fontSize * (isPair ? 1.0 : 1.05));

    function _makeLine(text, size, secondary) {
        var layer = comp.layers.addText(text);
        layer.inPoint  = tIn;
        layer.outPoint = tOut;
        try {
            var tp  = layer.property('ADBE Text Properties').property('ADBE Text Document');
            var doc = tp.value;
            doc.text        = text;
            doc.fontSize    = size;
            doc.fillColor   = [textRGB.r, textRGB.g, textRGB.b];
            doc.applyFill   = true;
            doc.applyStroke = false;
            try { doc.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (e) {}
            if (secondary && isPair) {
                // Font-pair intro line: user-chosen pair font, else Georgia
                // Italic; user-chosen pair colour, else the text colour.
                try {
                    var pc = _hexToRGB01(style.pairColor || style.textColor || '#ffffff');
                    doc.fillColor = [pc.r, pc.g, pc.b];
                } catch (pcErr) {}
                if (style.pairFont) {
                    try { doc.font = style.pairFont; }
                    catch (p1) {
                        try { doc.fontFamily = style.pairFontFamily || style.pairFont; doc.fontStyle = style.pairFontStyle || 'Regular'; } catch (p2) {}
                    }
                } else {
                    try { doc.font = 'Georgia-Italic'; }
                    catch (e1) {
                        try { doc.fontFamily = 'Georgia'; doc.fontStyle = 'Italic'; } catch (e2) {}
                    }
                }
            } else if (style.font) {
                try { doc.font = style.font; }
                catch (e3) {
                    try { doc.fontFamily = style.fontFamily || style.font; doc.fontStyle = style.fontStyle || 'Regular'; } catch (e4) {}
                }
            } else if (style.fontFamily) {
                try { doc.fontFamily = style.fontFamily; doc.fontStyle = 'Regular'; } catch (e5) {}
            }
            tp.setValue(doc);
        } catch (docErr) {}
        return layer;
    }

    var layerA = _makeLine(lineA, sizeA, true);
    var layerB = _makeLine(lineB, sizeB, false);
    layerA.name = _layerNameFromText(cap.text, cap.id) + ' · 1';
    layerB.name = _layerNameFromText(cap.text, cap.id) + ' · 2';

    // Measure both lines, then centre the combined block on (xPos, yPos).
    var maxLineW = comp.width * 0.92;
    var rectA = _fitTextToWidth(layerA, maxLineW, tIn);
    var rectB = _fitTextToWidth(layerB, maxLineW, tIn);
    if (!rectA) rectA = { left: 0, top: 0, width: 0, height: sizeA };
    if (!rectB) rectB = { left: 0, top: 0, width: 0, height: sizeB };
    var gap    = fontSize * 0.16;
    var totalH = rectA.height + gap + rectB.height;
    var yA = yPos - totalH / 2 + rectA.height / 2;
    var yB = yPos + totalH / 2 - rectB.height / 2;

    function _placeLine(layer, rect, y) {
        try {
            var xf = layer.property('ADBE Transform Group');
            xf.property('ADBE Anchor Point').setValue([rect.left + rect.width / 2, rect.top + rect.height / 2]);
            xf.property('ADBE Position').setValue([xPos, y]);
        } catch (e) {}
    }
    _placeLine(layerA, rectA, yA);
    _placeLine(layerB, rectB, yB);

    // Entrance: word-by-word HARD appear on each line — the intro's words
    // land first, then the payoff's words sweep in right after. A short
    // fade-out at the end keeps exits gentle.
    var dur    = Math.max(0.0, tOut - tIn);
    var outDur = Math.min(0.16, dur * 0.35);
    var spd    = parseFloat(style.animSpeed) || 1;
    var introDur = Math.min(0.30, dur * 0.25) * spd;

    try { _wordByWordAppear(layerA, tIn, tIn + Math.max(0.2, introDur * 2), Math.min(0.1, dur * 0.2), spd); } catch (e) {}
    try { _wordByWordAppear(layerB, tIn + introDur, tOut, Math.min(0.12, dur * 0.25), spd); } catch (e) {}

    function _tailFade(layer) {
        try {
            var op = layer.property('ADBE Transform Group').property('ADBE Opacity');
            op.setValueAtTime(Math.max(tIn, tOut - outDur), 100);
            op.setValueAtTime(tOut, 0);
            _easeKeys(op);
        } catch (e) {}
    }
    _tailFade(layerA);
    _tailFade(layerB);

    return true;
}

/**
 * Place one auto-emoji as a footage layer beside its caption.
 *
 * The PNG was rendered by the panel (js/ai-emoji.js → renderAssets) because
 * After Effects can't draw colour-emoji fonts. Each distinct emoji is imported
 * ONCE and cached in `footageCache` — a 40-caption transcript with four repeated
 * emoji imports four files, not forty.
 *
 * Geometry: the caption's text has already been shifted right by
 * (size + gap) / 2, so the emoji centres at half the text width plus the gap to
 * the left of the caption's centre. The pair reads as one centred block.
 *
 * Entrance: a short scale pop so it arrives with the caption instead of just
 * being there. In/out match the caption exactly.
 */
function _addEmojiLayer(comp, pngPath, footageCache, tIn, tOut, xPos, yPos,
                        textRect, size, gap, style) {
    // ── Import once per distinct emoji ───────────────────────────────
    var item = footageCache[pngPath];
    if (!item) {
        var f = new File(pngPath);
        if (!f.exists) return null;
        var io = new ImportOptions(f);
        try { io.importAs = ImportAsType.FOOTAGE; } catch (e) { }
        item = app.project.importFile(io);
        if (!item) return null;
        try { item.name = 'emoji ' + item.name; } catch (e) { }
        footageCache[pngPath] = item;
    }

    var layer = comp.layers.add(item);
    layer.inPoint  = tIn;
    layer.outPoint = tOut;
    try { layer.name = 'emoji'; } catch (e) { }

    // ── Scale the 256px square down to caption height ───────────────
    var srcW = 256, srcH = 256;
    try { srcW = item.width || 256; srcH = item.height || 256; } catch (e) { }
    var pct = (size / Math.max(1, srcH)) * 100;
    var xf  = layer.property('ADBE Transform Group');
    try { xf.property('ADBE Scale').setValue([pct, pct]); } catch (e) { }

    // ── Position: left of the words, vertically centred on them ─────
    var textW = (textRect && textRect.width) ? textRect.width : 0;
    var ex = xPos - (textW + gap) / 2;
    // Keep it inside the frame if the caption is nearly full width.
    var half = size / 2;
    if (ex - half < 6) ex = half + 6;
    try { xf.property('ADBE Position').setValue([ex, yPos]); } catch (e) { }

    // ── Entrance pop, then hold ─────────────────────────────────────
    var dur = Math.max(0.0, tOut - tIn);
    var popDur = Math.min(0.22, dur * 0.45) * (parseFloat(style.animSpeed) || 1);
    if (popDur > 0.02) {
        try {
            var sc = xf.property('ADBE Scale');
            sc.setValueAtTime(tIn,               [pct * 0.35, pct * 0.35]);
            sc.setValueAtTime(tIn + popDur * 0.7, [pct * 1.12, pct * 1.12]);
            sc.setValueAtTime(tIn + popDur,       [pct, pct]);
            _easeKeys(sc);
        } catch (e) { }
        try {
            var op = xf.property('ADBE Opacity');
            op.setValueAtTime(tIn, 0);
            op.setValueAtTime(tIn + Math.min(0.10, dur * 0.3), 100);
            var outDur = Math.min(0.16, dur * 0.35);
            if (tOut - outDur > tIn + popDur) op.setValueAtTime(tOut - outDur, 100);
            op.setValueAtTime(tOut, 0);
            _easeKeys(op);
        } catch (e) { }
    }

    return layer;
}

// Boxed look: rounded semi-opaque rectangle behind a caption, sized from the
// text's measured bounds + padding. The shape layer sits directly below its
// text layer, matches its in/out points, and fades with the same timing so
// the pair reads as one element.
function _addCaptionBacking(comp, textLayer, tIn, tOut, xPos, yPos, rect, fontSize) {
    var padX  = (fontSize || 60) * 0.55;
    var padY  = (fontSize || 60) * 0.30;
    var round = (fontSize || 60) * 0.22;

    var shape = comp.layers.addShape();
    shape.name     = textLayer.name + ' · bg';
    shape.inPoint  = tIn;
    shape.outPoint = tOut;

    var grp   = shape.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group');
    var items = grp.property('ADBE Vectors Group');
    var rc    = items.addProperty('ADBE Vector Shape - Rect');
    rc.property('ADBE Vector Rect Size').setValue([rect.width + padX * 2, rect.height + padY * 2]);
    try { rc.property('ADBE Vector Rect Roundness').setValue(round); } catch (e) {}
    var fill = items.addProperty('ADBE Vector Graphic - Fill');
    fill.property('ADBE Vector Fill Color').setValue([0, 0, 0, 1]);
    try { fill.property('ADBE Vector Fill Opacity').setValue(78); } catch (e) {}

    var xf = shape.property('ADBE Transform Group');
    xf.property('ADBE Position').setValue([xPos, yPos]);

    // Fade with the same envelope the text layer gets from the shared path.
    var dur    = Math.max(0.0, tOut - tIn);
    var inDur  = Math.min(0.20, dur * 0.40);
    var outDur = Math.min(0.16, dur * 0.35);
    if (inDur > 0) {
        var opS = xf.property('ADBE Opacity');
        opS.setValueAtTime(tIn, 0);
        opS.setValueAtTime(tIn + inDur, 100);
        if (tOut - outDur > tIn + inDur) opS.setValueAtTime(tOut - outDur, 100);
        opS.setValueAtTime(tOut, 0);
        _easeKeys(opS);
    }

    // Keep the backing directly beneath its text layer in the stack.
    shape.moveAfter(textLayer);
}

// Typewriter reveal: per-CHARACTER hard appear. Same selector approach as
// the word-by-word appear, but Based On = Characters and Smoothness 0 so
// letters switch on one at a time (no cross-fade) as Start sweeps 0 → 100%.
function _typewriterIn(layer, tIn, tOut) {
    var animators = layer.property('ADBE Text Properties').property('ADBE Text Animators');
    var animator  = animators.addProperty('ADBE Text Animator');
    var aProps    = animator.property('ADBE Text Animator Properties');
    try { aProps.addProperty('ADBE Text Opacity').setValue(0); } catch (e) { return; }

    var sel = animator.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    var adv = sel.property('ADBE Text Range Advanced');
    try { adv.property('ADBE Text Range Type2').setValue(1); }         catch (e) {}  // Based on Characters
    try { adv.property('ADBE Text Selector Smoothness').setValue(0); } catch (e) {}  // hard edge

    var start = sel.property('ADBE Text Percent Start');
    var dur       = Math.max(0.0, tOut - tIn);
    var revealDur = Math.min(0.9, Math.max(0.25, dur * 0.55));
    start.setValueAtTime(tIn, 0);
    start.setValueAtTime(tIn + revealDur, 100);
    // Linear timing keeps a steady letter-after-letter cadence.
    try {
        for (var k = 1; k <= start.numKeys; k++) {
            start.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        }
    } catch (e) {}
}

// Compute per-word character index ranges for a caption whose text is the
// words joined by single spaces (matches the caption builder). Returns
// [{ cs, ce, start, end }] where cs/ce are 0-based char indices (ce exclusive)
// and start/end are the word's absolute timeline seconds.
//
// `offset` is how many characters sit in front of the first word in the layer's
// actual text — currently the auto-emoji prefix ("🔥 " → 2). Without it every
// per-word range would point one emoji too far left.
function _wordCharIndices(capWords, offset) {
    var out = [], idx = parseInt(offset, 10) || 0;
    for (var i = 0; i < capWords.length; i++) {
        var w   = capWords[i];
        var txt = (w && w.word != null) ? String(w.word) : '';
        var cs  = idx;
        var ce  = idx + txt.length;
        out.push({ cs: cs, ce: ce, start: (w && w.start) || 0, end: (w && w.end) || 0 });
        idx = ce + 1;   // +1 for the joining space
    }
    return out;
}

// Set every keyframe on a property to HOLD (stepped) interpolation, so the
// value jumps at each keyframe instead of ramping — used for the word-index
// selectors that advance one word at a time.
function _holdKeys(prop) {
    try {
        for (var k = 1; k <= prop.numKeys; k++) {
            prop.setInterpolationTypeAtKey(k,
                KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
        }
    } catch (e) {}
}

// Configure a Range Selector to work in character-INDEX units with a hard
// (non-feathered) edge. Shared by the highlight + reveal animators.
function _indexSelector(animator) {
    var sel = animator.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    var adv = sel.property('ADBE Text Range Advanced');
    try { adv.property('ADBE Text Range Type2').setValue(1); }        catch (e) {}  // Based on Characters
    try { adv.property('ADBE Text Range Units').setValue(2); }        catch (e) {}  // Units = Index
    try { adv.property('ADBE Text Selector Smoothness').setValue(0); } catch (e) {}  // hard edge
    return sel;
}

// Karaoke-style highlight: a Fill Color animator whose index selector brackets
// exactly the word being spoken, advancing word-by-word via HOLD keyframes so
// the accent colour tracks the audio.
function _wordHighlight(layer, capWords, rgb, offset) {
    if (!capWords || capWords.length === 0) return;
    var ranges = _wordCharIndices(capWords, offset);

    var animators = layer.property('ADBE Text Properties').property('ADBE Text Animators');
    var animator  = animators.addProperty('ADBE Text Animator');
    var aProps    = animator.property('ADBE Text Animator Properties');
    try { aProps.addProperty('ADBE Text Fill Color').setValue([rgb.r, rgb.g, rgb.b]); }
    catch (e) { return; }   // fill-colour animator unavailable — skip highlight

    var sel   = _indexSelector(animator);
    var start = sel.property('ADBE Text Index Start');
    var end   = sel.property('ADBE Text Index End');

    var t0 = layer.inPoint;
    // Before the first word: empty range (nothing highlighted).
    start.setValueAtTime(t0, 0);
    end.setValueAtTime(t0, 0);
    for (var i = 0; i < ranges.length; i++) {
        var t = Math.max(t0, ranges[i].start);
        start.setValueAtTime(t, ranges[i].cs);
        end.setValueAtTime(t, ranges[i].ce);
    }
    _holdKeys(start);
    _holdKeys(end);
}

// Per-word reveal synced to speech: an Opacity animator (base opacity 0) whose
// index selector covers the NOT-yet-spoken tail of the line. The selector's
// Start index steps forward at each word's start time, so earlier words stay
// visible while the rest remain hidden.
function _wordRevealByTiming(layer, capWords, offset) {
    if (!capWords || capWords.length === 0) return;
    var ranges = _wordCharIndices(capWords, offset);
    var total  = ranges[ranges.length - 1].ce;

    var animators = layer.property('ADBE Text Properties').property('ADBE Text Animators');
    var animator  = animators.addProperty('ADBE Text Animator');
    var aProps    = animator.property('ADBE Text Animator Properties');
    try { aProps.addProperty('ADBE Text Opacity').setValue(0); } catch (e) { return; }

    var sel   = _indexSelector(animator);
    var start = sel.property('ADBE Text Index Start');
    var end   = sel.property('ADBE Text Index End');
    end.setValue(total);   // hide from Start → end-of-line

    var t0 = layer.inPoint;
    for (var i = 0; i < ranges.length; i++) {
        // First word reveals with the layer's entrance; later words at speech time.
        var t = (i === 0) ? t0 : Math.max(t0, ranges[i].start);
        start.setValueAtTime(t, ranges[i].ce);   // everything up to word i is shown
    }
    _holdKeys(start);
}

// Spotlight: a Scale text-animator whose index selector brackets exactly the
// word being spoken (HOLD keys at the real word timestamps), so the active
// word zooms while the rest of the line holds still. Same machinery as the
// karaoke colour highlight, but scaling instead of tinting.
function _wordZoom(layer, capWords, amount, offset) {
    if (!capWords || capWords.length === 0) return;
    var ranges = _wordCharIndices(capWords, offset);

    var animators = layer.property('ADBE Text Properties').property('ADBE Text Animators');
    var animator  = animators.addProperty('ADBE Text Animator');
    var aProps    = animator.property('ADBE Text Animator Properties');
    try { aProps.addProperty('ADBE Text Scale 3D').setValue([amount, amount]); }
    catch (e1) {
        try { aProps.property('ADBE Text Scale 3D').setValue([amount, amount, 100]); }
        catch (e2) { return; }
    }

    var sel   = _indexSelector(animator);
    var start = sel.property('ADBE Text Index Start');
    var end   = sel.property('ADBE Text Index End');

    var t0 = layer.inPoint;
    start.setValueAtTime(t0, 0);
    end.setValueAtTime(t0, 0);
    for (var i = 0; i < ranges.length; i++) {
        var t = Math.max(t0, ranges[i].start);
        start.setValueAtTime(t, ranges[i].cs);
        end.setValueAtTime(t, ranges[i].ce);
    }
    _holdKeys(start);
    _holdKeys(end);
}

// Shuffle: identical to the hard word-appear, but with the selector's
// Randomize Order flag on, so words land scattered instead of left-to-right.
function _wordShuffleAppear(layer, tIn, tOut, inDur, spd) {
    var animators = layer.property('ADBE Text Properties').property('ADBE Text Animators');
    var animator  = animators.addProperty('ADBE Text Animator');
    var aProps    = animator.property('ADBE Text Animator Properties');
    try { aProps.addProperty('ADBE Text Opacity').setValue(0); } catch (e) { return; }

    var sel = animator.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    var adv = sel.property('ADBE Text Range Advanced');
    try { adv.property('ADBE Text Range Type2').setValue(3); }               catch (e) {}
    try { adv.property('ADBE Text Selector Smoothness').setValue(0); }       catch (e) {}
    try { adv.property('ADBE Text Range Random Order').setValue(true); }     catch (e) {}

    var start = sel.property('ADBE Text Percent Start');
    var revealDur = Math.min(0.9, Math.max(inDur, (tOut - tIn) * 0.7)) * (spd || 1);
    revealDur = Math.min(revealDur, Math.max(0.15, (tOut - tIn) * 0.9));
    start.setValueAtTime(tIn, 0);
    start.setValueAtTime(tIn + revealDur, 100);
    try {
        for (var k = 1; k <= start.numKeys; k++) {
            start.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        }
    } catch (e) {}
}

// Flip Up: per-word rotation swing (tilted + transparent until revealed),
// sweeping through the words like the slide but with a swing instead.
function _wordFlipUp(layer, tIn, tOut, inDur, spd) {
    var animators = layer.property('ADBE Text Properties').property('ADBE Text Animators');
    var animator  = animators.addProperty('ADBE Text Animator');
    var aProps    = animator.property('ADBE Text Animator Properties');
    try { aProps.addProperty('ADBE Text Rotation').setValue(38); } catch (e) {}
    try { aProps.addProperty('ADBE Text Opacity').setValue(0); }   catch (e) {}

    var sel = animator.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    var adv = sel.property('ADBE Text Range Advanced');
    try { adv.property('ADBE Text Range Type2').setValue(3); }           catch (e) {}
    try { adv.property('ADBE Text Selector Smoothness').setValue(100); } catch (e) {}

    var start = sel.property('ADBE Text Percent Start');
    var revealDur = Math.min(0.9, Math.max(inDur, (tOut - tIn) * 0.7)) * (spd || 1);
    revealDur = Math.min(revealDur, Math.max(0.15, (tOut - tIn) * 0.9));
    start.setValueAtTime(tIn, 0);
    start.setValueAtTime(tIn + revealDur, 100);
    _easeKeys(start);
}

// Pulse: layer-level scale beats on every spoken word (uses the real word
// timestamps). Falls back to a steady beat when word timing is missing.
function _pulseOnWords(layer, capWords, tIn, tOut) {
    var sc;
    try { sc = layer.property('ADBE Transform Group').property('ADBE Scale'); }
    catch (e) { return; }
    var base = sc.value;

    var beats = [];
    if (capWords && capWords.length > 0) {
        for (var i = 0; i < capWords.length; i++) {
            var t = capWords[i].start;
            if (t >= tIn - 0.05 && t < tOut - 0.15) beats.push(Math.max(tIn, t));
        }
    }
    if (beats.length === 0) {
        for (var b = tIn; b < tOut - 0.2; b += 0.4) beats.push(b);
    }

    sc.setValueAtTime(tIn, base);
    for (var k = 0; k < beats.length; k++) {
        var bt = beats[k];
        sc.setValueAtTime(bt,        base);
        sc.setValueAtTime(bt + 0.06, [base[0] * 1.07, base[1] * 1.07]);
        sc.setValueAtTime(bt + 0.18, base);
    }
    _easeKeys(sc);
}

// Best-effort easing: smooth every keyframe on a property (ignored on
// AE versions where KeyframeInterpolationType isn't writable here).
function _easeKeys(prop) {
    try {
        for (var k = 1; k <= prop.numKeys; k++) {
            prop.setInterpolationTypeAtKey(k,
                KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
        }
        var n = prop.numKeys;
        if (prop.value instanceof Array) {
            var dim = prop.value.length;
            var zero = [], full = [];
            for (var d = 0; d < dim; d++) { zero.push(new KeyframeEase(0, 33)); full.push(new KeyframeEase(0, 33)); }
            for (var j = 1; j <= n; j++) prop.setTemporalEaseAtKey(j, zero, full);
        } else {
            var ein = new KeyframeEase(0, 33), eout = new KeyframeEase(0, 33);
            for (var m = 1; m <= n; m++) prop.setTemporalEaseAtKey(m, [ein], [eout]);
        }
    } catch (e) { /* leave linear */ }
}


// ═══════════════════════════════════════════════════════════════════
//  APPLY STYLE TO ALL CAPTIONS
//  Yashkit feature: propagate visual style from one "template" text
//  layer to every other caption text layer in the active comp,
//  without overwriting the individual text strings.
// ═══════════════════════════════════════════════════════════════════

/**
 * _ckCopyPropertyKeyframes — Universal keyframe copier with time remapping.
 *
 * Copies every keyframe from srcProp to tgtProp. Times are remapped so that
 * each keyframe keeps the same RELATIVE position from the layer's inPoint:
 *
 *   relativeOffset = srcKeyTime - srcInPoint
 *   targetKeyTime  = tgtInPoint + relativeOffset
 *
 * This means a fade-in that starts 0.1s after the source layer's start will
 * also start 0.1s after the target layer's start — even though the two layers
 * may begin at completely different times on the timeline.
 *
 * If clamping is needed (keyframe falls outside target layer), the keyframe
 * is silently clamped to [tgtInPoint, tgtOutPoint].
 *
 * Interpolation type (BEZIER / LINEAR / HOLD) and temporal ease are preserved
 * on a best-effort basis — some AE versions restrict writing ease on certain
 * property types.
 *
 * @param {Property} srcProp   — source property to read keyframes from
 * @param {Property} tgtProp   — target property to write keyframes to
 * @param {number}   srcIn     — source layer inPoint (seconds)
 * @param {number}   tgtIn     — target layer inPoint (seconds)
 * @param {number}   tgtOut    — target layer outPoint (seconds), for clamping
 */
function _ckCopyPropertyKeyframes(srcProp, tgtProp, srcIn, tgtIn, tgtOut, srcOut) {
    try {
        // Clear existing keyframes on the target first
        while (tgtProp.numKeys > 0) {
            tgtProp.removeKey(1);
        }

        var n = srcProp.numKeys;
        if (n === 0) return;

        var srcDur = (srcOut != null && srcOut > srcIn) ? (srcOut - srcIn) : 0;
        if (srcDur <= 0) {
            try { srcDur = srcProp.keyTime(n) - srcIn; } catch (e) {}
        }
        if (srcDur <= 0) srcDur = 1.0;

        var tgtDur = tgtOut - tgtIn;
        if (tgtDur <= 0) tgtDur = 0.05;

        var isTargetLonger = (tgtDur > srcDur);

        // Check if property has an exit keyframe near srcOut (within 15% or last keyframe at srcOut)
        var hasExitAtEnd = false;
        if (n >= 2) {
            var lastKeyTime = srcProp.keyTime(n);
            if (srcOut - lastKeyTime <= Math.max(0.05, srcDur * 0.15)) {
                hasExitAtEnd = true;
            }
        }

        var lastTgtTime = -999999;

        for (var k = 1; k <= n; k++) {
            var srcTime = srcProp.keyTime(k);
            var tgtTime;

            if (isTargetLonger) {
                // If target text is longer than reference text:
                // Animations should be as long as reference text, NOT stretched by percentage.
                var distFromIn  = srcTime - srcIn;
                var distFromOut = srcOut - srcTime;

                if (hasExitAtEnd && distFromOut < distFromIn && distFromOut <= srcDur * 0.45) {
                    // Exit keyframe: anchored to tgtOut with exact reference duration
                    tgtTime = tgtOut - distFromOut;
                } else {
                    // Entrance or forward keyframe: anchored to tgtIn with exact reference duration
                    tgtTime = tgtIn + distFromIn;
                }
            } else {
                // If target text is shorter than reference text:
                // Scale by percentage so keyframes fit proportionally without collapsing
                var pct = (srcTime - srcIn) / srcDur;
                if (pct < 0) pct = 0;
                if (pct > 1) pct = 1;
                tgtTime = tgtIn + pct * tgtDur;
            }

            // Ensure keyframe times are strictly ascending and inside bounds
            if (tgtTime < tgtIn) tgtTime = tgtIn;
            if (tgtTime > tgtOut) tgtTime = tgtOut;
            if (tgtTime <= lastTgtTime) {
                tgtTime = lastTgtTime + 0.001;
            }
            if (tgtTime > tgtOut) tgtTime = tgtOut;
            if (tgtTime <= lastTgtTime) tgtTime = lastTgtTime + 0.0001;

            lastTgtTime = tgtTime;

            var val = srcProp.keyValue(k);
            tgtProp.setValueAtTime(tgtTime, val);
        }

        // ── Copy interpolation types ────────────────────────────────
        // Must be done AFTER all keyframes exist so AE can resolve pairs.
        try {
            for (var k = 1; k <= Math.min(n, tgtProp.numKeys); k++) {
                var inType  = srcProp.keyInInterpolationType(k);
                var outType = srcProp.keyOutInterpolationType(k);
                tgtProp.setInterpolationTypeAtKey(k, inType, outType);
            }
        } catch (interpErr) { /* best-effort */ }

        // ── Copy temporal ease ──────────────────────────────────────
        try {
            for (var k = 1; k <= Math.min(n, tgtProp.numKeys); k++) {
                var easeIn  = srcProp.keyInTemporalEase(k);
                var easeOut = srcProp.keyOutTemporalEase(k);
                tgtProp.setTemporalEaseAtKey(k, easeIn, easeOut);
            }
        } catch (easeErr) { /* best-effort */ }

    } catch (e) { /* property doesn't support keyframes — skip silently */ }
}

/**
 * _ckCopyPropertyValue — Copy a single property's static value and/or expression.
 *
 * If the source has keyframes, delegates to _ckCopyPropertyKeyframes.
 * If the source has only a static value, sets it directly.
 * If the source has an expression, copies the expression string.
 *
 * @param {Property} srcProp — source property
 * @param {Property} tgtProp — target property
 * @param {number}   srcIn   — source layer inPoint
 * @param {number}   tgtIn   — target layer inPoint
 * @param {number}   tgtOut  — target layer outPoint
 * @param {number}   srcOut  — source layer outPoint
 */
function _ckCopyPropertyValue(srcProp, tgtProp, srcIn, tgtIn, tgtOut, srcOut) {
    try {
        if (!srcProp || !tgtProp) return;
        // Properties that can't be set (e.g. groups) — skip
        if (srcProp.propertyValueType === PropertyValueType.NO_VALUE) return;

        if (srcProp.numKeys > 0) {
            _ckCopyPropertyKeyframes(srcProp, tgtProp, srcIn, tgtIn, tgtOut, srcOut);
        } else {
            try { tgtProp.setValue(srcProp.value); } catch (svErr) {}
        }

        // Copy expression (if any)
        try {
            if (srcProp.expressionEnabled) {
                tgtProp.expression = srcProp.expression;
            } else if (tgtProp.expressionEnabled) {
                // Source has no expression but target does — clear it
                tgtProp.expression = '';
            }
        } catch (exErr) { /* expression not supported on this prop */ }

    } catch (e) { /* skip gracefully */ }
}

/**
 * _ckCopyTextStyle — Transfer TextDocument character/paragraph styling.
 *
 * Reads every supported style attribute from the source TextDocument and
 * applies it to the target's TextDocument, preserving the target's original
 * text string.
 *
 * @param {TextLayer} srcLayer — source text layer
 * @param {TextLayer} tgtLayer — target text layer
 */
function _ckCopyTextStyle(srcLayer, tgtLayer) {
    try {
        var srcTextProp = srcLayer.property('ADBE Text Properties').property('ADBE Text Document');
        var tgtTextProp = tgtLayer.property('ADBE Text Properties').property('ADBE Text Document');
        var srcDoc = srcTextProp.value;
        var tgtDoc = tgtTextProp.value;

        // ── Preserve the target's text ──────────────────────────────
        var originalText = tgtDoc.text;

        // ── Character styling ───────────────────────────────────────
        try { tgtDoc.font = srcDoc.font; }                 catch (e) {}
        try { tgtDoc.fontSize = srcDoc.fontSize; }         catch (e) {}
        try { tgtDoc.fillColor = srcDoc.fillColor; }       catch (e) {}
        try { tgtDoc.applyFill = srcDoc.applyFill; }       catch (e) {}
        try { tgtDoc.strokeColor = srcDoc.strokeColor; }   catch (e) {}
        try { tgtDoc.strokeWidth = srcDoc.strokeWidth; }   catch (e) {}
        try { tgtDoc.applyStroke = srcDoc.applyStroke; }   catch (e) {}
        try { tgtDoc.strokeOverFill = srcDoc.strokeOverFill; } catch (e) {}
        try { tgtDoc.tracking = srcDoc.tracking; }         catch (e) {}
        try { tgtDoc.leading = srcDoc.leading; }           catch (e) {}
        try { tgtDoc.autoLeading = srcDoc.autoLeading; }   catch (e) {}
        try { tgtDoc.fauxBold = srcDoc.fauxBold; }         catch (e) {}
        try { tgtDoc.fauxItalic = srcDoc.fauxItalic; }     catch (e) {}
        try { tgtDoc.allCaps = srcDoc.allCaps; }           catch (e) {}
        try { tgtDoc.smallCaps = srcDoc.smallCaps; }       catch (e) {}
        try { tgtDoc.baselineShift = srcDoc.baselineShift; } catch (e) {}
        try { tgtDoc.tsume = srcDoc.tsume; }               catch (e) {}

        // ── Paragraph styling ───────────────────────────────────────
        try { tgtDoc.justification = srcDoc.justification; } catch (e) {}

        // ── Box text geometry (if source is box-text) ───────────────
        try {
            if (srcDoc.boxText) {
                tgtDoc.boxText = true;
                tgtDoc.boxTextSize = srcDoc.boxTextSize;
            }
        } catch (e) {}

        // ── Font family / style fallback (modern AE) ────────────────
        try { tgtDoc.fontFamily = srcDoc.fontFamily; }     catch (e) {}
        try { tgtDoc.fontStyle = srcDoc.fontStyle; }       catch (e) {}

        // ── Restore original text and commit ────────────────────────
        tgtDoc.text = originalText;
        tgtTextProp.setValue(tgtDoc);

    } catch (e) { /* text styling transfer failed — layer keeps its look */ }
}

/**
 * _ckCopyAnimators — Replicate all Text Animators from source to target.
 *
 * Removes all existing animators on the target layer (to avoid stacking
 * duplicates), then iterates through the source's animators and rebuilds
 * each one on the target with matching properties, selectors, and keyframes.
 *
 * Keyframe times are remapped relative to layer inPoints.
 *
 * @param {TextLayer} srcLayer — source text layer
 * @param {TextLayer} tgtLayer — target text layer
 */
function _ckCopyAnimators(srcLayer, tgtLayer, srcIn, tgtIn, tgtOut, srcOut) {
    try {
        var srcAnimators = srcLayer.property('ADBE Text Properties').property('ADBE Text Animators');
        var tgtAnimators = tgtLayer.property('ADBE Text Properties').property('ADBE Text Animators');

        if (srcIn == null) srcIn = srcLayer.inPoint;
        if (srcOut == null) srcOut = srcLayer.outPoint;
        if (tgtIn == null) tgtIn = tgtLayer.inPoint;
        if (tgtOut == null) tgtOut = tgtLayer.outPoint;

        var srcDur = srcOut - srcIn;
        if (srcDur <= 0) srcDur = 1.0;
        var tgtDur = tgtOut - tgtIn;
        if (tgtDur <= 0) tgtDur = 0.05;

        // Get text lengths for index-based selectors
        var srcLen = 1;
        var tgtLen = 1;
        try {
            var srcDoc = srcLayer.property('ADBE Text Properties').property('ADBE Text Document').value;
            var tgtDoc = tgtLayer.property('ADBE Text Properties').property('ADBE Text Document').value;
            if (srcDoc && srcDoc.text) srcLen = srcDoc.text.length;
            if (tgtDoc && tgtDoc.text) tgtLen = tgtDoc.text.length;
        } catch (docErr) {}

        // ── Remove existing animators on target (iterate backwards) ─
        for (var r = tgtAnimators.numProperties; r >= 1; r--) {
            try { tgtAnimators.property(r).remove(); } catch (rmErr) {}
        }

        // In AE, removing animators DOES NOT turn off threeDPerChar automatically!
        // Explicitly sync threeDPerChar to match the source layer right away.
        try {
            var srcHas3DPerChar = false;
            try {
                if (typeof srcLayer.threeDPerChar !== 'undefined') {
                    srcHas3DPerChar = (srcLayer.threeDPerChar === true);
                }
            } catch (s3Err) {}
            if (typeof tgtLayer.threeDPerChar !== 'undefined') {
                tgtLayer.threeDPerChar = srcHas3DPerChar;
            }
        } catch (e3d) {}

        // ── Replicate each source animator ──────────────────────────
        for (var a = 1; a <= srcAnimators.numProperties; a++) {
            var srcAnim = srcAnimators.property(a);
            var newAnim = tgtAnimators.addProperty('ADBE Text Animator');

            // Copy animator name
            try { newAnim.name = srcAnim.name; } catch (nameErr) {}

            // ── Copy Animator Properties (Position, Opacity, etc.) ──
            var srcProps = srcAnim.property('ADBE Text Animator Properties');
            var newProps = newAnim.property('ADBE Text Animator Properties');
            if (srcProps && newProps) {
                for (var p = 1; p <= srcProps.numProperties; p++) {
                    var sp = srcProps.property(p);
                    if (!sp) continue;

                    var mn = sp.matchName;

                    // 1. If source layer is NOT 3D, never copy 3D-only animator properties
                    if (!srcLayer.threeDLayer && !srcLayer.threeDPerChar) {
                        if (mn === 'ADBE Text Bevel Depth' ||
                            mn === 'ADBE Text Extrusion Depth' ||
                            mn === 'ADBE Text Rotate X' ||
                            mn === 'ADBE Text Rotate Y') {
                            continue;
                        }
                    }

                    // 2. Check if this property is ACTUALLY added / active on the source animator.
                    var isAddedToSrc = false;
                    try {
                        if (typeof srcProps.canAddProperty === 'function') {
                            isAddedToSrc = !srcProps.canAddProperty(mn);
                        }
                    } catch (capErr) {}

                    // 3. Fallback verification: check if property is modified, keyframed, or expression-driven
                    var hasContent = false;
                    try {
                        hasContent = (sp.numKeys > 0) || 
                                     (sp.expressionEnabled && sp.expression && sp.expression.length > 0) || 
                                     sp.isModified;
                    } catch (hcErr) {}

                    // Only replicate if it is genuinely active/added on the source animator
                    if (!isAddedToSrc && !hasContent) {
                        continue;
                    }

                    try {
                        var np = newProps.property(mn);
                        if (!np && typeof newProps.addProperty === 'function') {
                            np = newProps.addProperty(mn);
                        }
                        if (np) {
                            _ckCopyPropertyValue(sp, np, srcIn, tgtIn, tgtOut, srcOut);
                        }
                    } catch (propErr) { /* skip this animator property */ }
                }
            }

            // ── Copy Selectors (Range Selectors, Wiggly, Expression) ─
            var srcSels = srcAnim.property('ADBE Text Selectors');
            var newSels = newAnim.property('ADBE Text Selectors');
            if (srcSels && newSels) {
                // Clear any default selectors created by AE to avoid duplicates
                for (var ns = newSels.numProperties; ns >= 1; ns--) {
                    try { newSels.property(ns).remove(); } catch (rmSelErr) {}
                }

                for (var s = 1; s <= srcSels.numProperties; s++) {
                    var srcSel = srcSels.property(s);
                    try {
                        var newSel = newSels.addProperty(srcSel.matchName);

                        // Copy top-level selector properties (Start, End, Offset, etc.)
                        for (var sp2 = 1; sp2 <= srcSel.numProperties; sp2++) {
                            var selProp = srcSel.property(sp2);
                            // Sub-groups (like Advanced) must be iterated into
                            if (selProp.propertyType === PropertyType.INDEXED_GROUP ||
                                selProp.propertyType === PropertyType.NAMED_GROUP) {
                                var tgtSubGrp;
                                try { tgtSubGrp = newSel.property(selProp.matchName); }
                                catch (e) { tgtSubGrp = null; }
                                if (tgtSubGrp) {
                                    for (var sg = 1; sg <= selProp.numProperties; sg++) {
                                        var subP = selProp.property(sg);
                                        try {
                                            var tgtSubP = tgtSubGrp.property(subP.matchName);
                                            if (tgtSubP) _ckCopyPropertyValue(subP, tgtSubP, srcIn, tgtIn, tgtOut, srcOut);
                                        } catch (subErr) {}
                                    }
                                }
                            } else {
                                try {
                                    var tgtSelProp = newSel.property(selProp.matchName);
                                    if (tgtSelProp) {
                                        // SPECIAL PROPORTIONAL SCALING FOR RANGE SELECTORS
                                        if (selProp.matchName === 'ADBE Text Index End') {
                                            // Ensure End covers the target text's character length, never stuck to source's length!
                                            tgtSelProp.setValue(tgtLen);
                                        } else if (selProp.matchName === 'ADBE Text Index Start') {
                                            while (tgtSelProp.numKeys > 0) tgtSelProp.removeKey(1);
                                            if (selProp.numKeys > 0) {
                                                var lastTTime = -999999;
                                                for (var sk = 1; sk <= selProp.numKeys; sk++) {
                                                    var sTime = selProp.keyTime(sk);
                                                    var tTime;
                                                    if (tgtDur > srcDur) {
                                                        // Target is longer: animation is as long as reference text, not percentage
                                                        tTime = tgtIn + (sTime - srcIn);
                                                    } else {
                                                        // Target is shorter: scale by percentage
                                                        var pctT = (sTime - srcIn) / srcDur;
                                                        if (pctT < 0) pctT = 0;
                                                        if (pctT > 1) pctT = 1;
                                                        tTime = tgtIn + pctT * tgtDur;
                                                    }

                                                    if (tTime < tgtIn) tTime = tgtIn;
                                                    if (tTime > tgtOut) tTime = tgtOut;
                                                    if (tTime <= lastTTime) tTime = lastTTime + 0.001;
                                                    if (tTime > tgtOut) tTime = tgtOut;
                                                    if (tTime <= lastTTime) tTime = lastTTime + 0.0001;
                                                    lastTTime = tTime;

                                                    var sVal = selProp.keyValue(sk);
                                                    var tVal = Math.round(sVal * (tgtLen / Math.max(1, srcLen)));
                                                    // On final keyframe, guarantee full reveal of characters
                                                    if (sk === selProp.numKeys && tVal < tgtLen) tVal = tgtLen;
                                                    tgtSelProp.setValueAtTime(tTime, tVal);
                                                }
                                            } else {
                                                tgtSelProp.setValue(0);
                                            }
                                        } else if (selProp.matchName === 'ADBE Text Percent Start') {
                                            while (tgtSelProp.numKeys > 0) tgtSelProp.removeKey(1);
                                            if (selProp.numKeys > 0) {
                                                var lastTTime2 = -999999;
                                                for (var sk2 = 1; sk2 <= selProp.numKeys; sk2++) {
                                                    var sTime2 = selProp.keyTime(sk2);
                                                    var tTime2;
                                                    if (tgtDur > srcDur) {
                                                        // Target is longer: animation is as long as reference text, not percentage
                                                        tTime2 = tgtIn + (sTime2 - srcIn);
                                                    } else {
                                                        // Target is shorter: scale by percentage
                                                        var pctT2 = (sTime2 - srcIn) / srcDur;
                                                        if (pctT2 < 0) pctT2 = 0;
                                                        if (pctT2 > 1) pctT2 = 1;
                                                        tTime2 = tgtIn + pctT2 * tgtDur;
                                                    }

                                                    if (tTime2 < tgtIn) tTime2 = tgtIn;
                                                    if (tTime2 > tgtOut) tTime2 = tgtOut;
                                                    if (tTime2 <= lastTTime2) tTime2 = lastTTime2 + 0.001;
                                                    if (tTime2 > tgtOut) tTime2 = tgtOut;
                                                    if (tTime2 <= lastTTime2) tTime2 = lastTTime2 + 0.0001;
                                                    lastTTime2 = tTime2;

                                                    var sVal2 = selProp.keyValue(sk2);
                                                    if (sk2 === selProp.numKeys && sVal2 < 100) sVal2 = 100;
                                                    tgtSelProp.setValueAtTime(tTime2, sVal2);
                                                }
                                            } else {
                                                tgtSelProp.setValue(selProp.value);
                                            }
                                        } else {
                                            _ckCopyPropertyValue(selProp, tgtSelProp, srcIn, tgtIn, tgtOut, srcOut);
                                        }
                                    }
                                } catch (selPropErr) {}
                            }
                        }
                    } catch (selErr) { /* skip this selector */ }
                }
            }
        }
    } catch (e) { /* animator replication failed — layer keeps its look */ }
}

/**
 * _ckCopyTextMoreAndPathOptions — Copy Path Options and More Options of the text layer.
 */
function _ckCopyTextMoreAndPathOptions(srcLayer, tgtLayer, srcIn, tgtIn, tgtOut, srcOut) {
    try {
        var srcText = srcLayer.property('ADBE Text Properties');
        var tgtText = tgtLayer.property('ADBE Text Properties');
        if (!srcText || !tgtText) return;

        // Copy Path Options
        var srcPath = srcText.property('ADBE Text Path Options');
        var tgtPath = tgtText.property('ADBE Text Path Options');
        if (srcPath && tgtPath) {
            for (var p = 1; p <= srcPath.numProperties; p++) {
                try {
                    var sp = srcPath.property(p);
                    var tp = tgtPath.property(sp.matchName) || tgtPath.property(p);
                    if (sp && tp) {
                        _ckCopyPropertyValue(sp, tp, srcIn, tgtIn, tgtOut, srcOut);
                    }
                } catch (pathErr) {}
            }
        }

        // Copy More Options
        var srcMore = srcText.property('ADBE Text More Options');
        var tgtMore = tgtText.property('ADBE Text More Options');
        if (srcMore && tgtMore) {
            for (var m = 1; m <= srcMore.numProperties; m++) {
                try {
                    var sm = srcMore.property(m);
                    var tm = tgtMore.property(sm.matchName) || tgtMore.property(m);
                    if (sm && tm) {
                        _ckCopyPropertyValue(sm, tm, srcIn, tgtIn, tgtOut, srcOut);
                    }
                } catch (moreErr) {}
            }
        }
    } catch (err) {}
}

/**
 * _ckCopyLayerTopLevelGroups — Copy material, geometry, and other custom top-level property groups recursively.
 */
function _ckCopyLayerTopLevelGroups(srcLayer, tgtLayer, srcIn, tgtIn, tgtOut) {
    try {
        for (var i = 1; i <= srcLayer.numProperties; i++) {
            var srcProp = srcLayer.property(i);
            if (!srcProp) continue;

            var mn = srcProp.matchName;
            // Skip known groups that are already handled or shouldn't be duplicated directly
            if (mn === 'ADBE Transform Group' || 
                mn === 'ADBE Effect Parade' || 
                mn === 'ADBE Text Properties' || 
                mn === 'ADBE Layer Upstream Properties') {
                continue;
            }

            // CRITICAL: If source layer is NOT 3D, do NOT touch material or geometry groups on target.
            // Touching these groups on a 2D layer can cause AE to convert it to a 3D layer.
            if (!srcLayer.threeDLayer && (
                mn === 'ADBE Material Options Group' || 
                mn === 'ADBE Extrusion Options Group' || 
                mn === 'ADBE Geometry Options Group')) {
                continue;
            }

            if (srcProp.propertyType === PropertyType.INDEXED_GROUP ||
                srcProp.propertyType === PropertyType.NAMED_GROUP) {
                try {
                    var tgtProp = tgtLayer.property(mn) || tgtLayer.property(srcProp.name);
                    if (tgtProp) {
                        _ckCopyPropertyGroupRecursive(srcProp, tgtProp, srcIn, tgtIn, tgtOut);
                    }
                } catch (groupErr) {}
            }
        }
    } catch (err) {}
}

function _ckCopyPropertyGroupRecursive(srcGroup, tgtGroup, srcIn, tgtIn, tgtOut, srcOut) {
    for (var i = 1; i <= srcGroup.numProperties; i++) {
        var sp = srcGroup.property(i);
        try {
            var tp = tgtGroup.property(sp.matchName) || tgtGroup.property(sp.name) || tgtGroup.property(i);
            if (!tp) continue;

            if (sp.propertyType === PropertyType.INDEXED_GROUP ||
                sp.propertyType === PropertyType.NAMED_GROUP) {
                _ckCopyPropertyGroupRecursive(sp, tp, srcIn, tgtIn, tgtOut, srcOut);
            } else if (sp.propertyValueType !== PropertyValueType.NO_VALUE) {
                _ckCopyPropertyValue(sp, tp, srcIn, tgtIn, tgtOut, srcOut);
            }
        } catch (propErr) {}
    }
}


/**
 * _ckCopyEffects — Replicate the entire Effect Parade from source to target.
 *
 * Removes all existing effects on the target, then iterates through the
 * source's effects. For each effect, adds a new instance by matchName and
 * copies every property's value/keyframes/expressions.
 *
 * @param {Layer} srcLayer — source layer
 * @param {Layer} tgtLayer — target layer
 */
function _ckCopyEffects(srcLayer, tgtLayer, srcIn, tgtIn, tgtOut, srcOut) {
    try {
        var srcFX = srcLayer.property('ADBE Effect Parade');
        var tgtFX = tgtLayer.property('ADBE Effect Parade');
        if (!srcFX || !tgtFX) return;

        if (srcIn == null) srcIn  = srcLayer.inPoint;
        if (srcOut == null) srcOut = srcLayer.outPoint;
        if (tgtIn == null) tgtIn  = tgtLayer.inPoint;
        if (tgtOut == null) tgtOut = tgtLayer.outPoint;

        // ── Remove existing effects on target (iterate backwards) ───
        for (var r = tgtFX.numProperties; r >= 1; r--) {
            try { tgtFX.property(r).remove(); } catch (rmErr) {}
        }

        // ── Replicate each source effect ────────────────────────────
        for (var f = 1; f <= srcFX.numProperties; f++) {
            var srcEffect = srcFX.property(f);
            try {
                var newEffect = tgtFX.addProperty(srcEffect.matchName);

                // Copy effect name
                try { newEffect.name = srcEffect.name; } catch (nameErr) {}

                // Copy enabled state
                try { newEffect.enabled = srcEffect.enabled; } catch (enErr) {}

                // ── Copy every property inside the effect ────────────
                _ckCopyEffectProperties(srcEffect, newEffect, srcIn, tgtIn, tgtOut, srcOut);

            } catch (fxErr) { /* effect not available on this AE build — skip */ }
        }
    } catch (e) { /* effect replication failed */ }
}

/**
 * _ckCopyEffectProperties — Recursively copy all properties within an effect.
 * Handles nested property groups (e.g., Fractal Noise sub-groups).
 */
function _ckCopyEffectProperties(srcGroup, tgtGroup, srcIn, tgtIn, tgtOut, srcOut) {
    for (var p = 1; p <= srcGroup.numProperties; p++) {
        var srcProp = srcGroup.property(p);
        try {
            var tgtProp = tgtGroup.property(srcProp.matchName);
            if (!tgtProp) continue;

            if (srcProp.propertyType === PropertyType.INDEXED_GROUP ||
                srcProp.propertyType === PropertyType.NAMED_GROUP) {
                // Recurse into sub-groups
                _ckCopyEffectProperties(srcProp, tgtProp, srcIn, tgtIn, tgtOut, srcOut);
            } else if (srcProp.propertyValueType !== PropertyValueType.NO_VALUE) {
                _ckCopyPropertyValue(srcProp, tgtProp, srcIn, tgtIn, tgtOut, srcOut);
            }
        } catch (propErr) { /* skip unreadable property */ }
    }
}

/**
 * _ckCopyTransform — Copy all transform properties from source to target.
 *
 * Handles: Anchor Point, Position, Scale, Rotation (X/Y/Z), Opacity.
 * Keyframes are time-remapped relative to layer inPoints.
 *
 * @param {Layer} srcLayer — source layer
 * @param {Layer} tgtLayer — target layer
 */
function _ckCopyTransform(srcLayer, tgtLayer, srcIn, tgtIn, tgtOut, srcOut) {
    try {
        var srcXform = srcLayer.property('ADBE Transform Group');
        var tgtXform = tgtLayer.property('ADBE Transform Group');
        if (!srcXform || !tgtXform) return;

        if (srcIn == null) srcIn = srcLayer.inPoint;
        if (srcOut == null) srcOut = srcLayer.outPoint;
        if (tgtIn == null) tgtIn = tgtLayer.inPoint;
        if (tgtOut == null) tgtOut = tgtLayer.outPoint;

        // 1. Recalculate Anchor Point for the target layer's own bounds so text is perfectly centered
        try {
            var r = tgtLayer.sourceRectAtTime(tgtIn, false);
            if (r.width > 0 && r.height > 0) {
                tgtXform.property('ADBE Anchor Point').setValue([r.left + r.width / 2, r.top + r.height / 2]);
            }
        } catch (apErr) {}

        // 2. Position: match vertical Y position (baseline), while keeping target horizontal X position centered
        try {
            var srcPos = srcXform.property('ADBE Position');
            var tgtPos = tgtXform.property('ADBE Position');
            if (srcPos && tgtPos) {
                if (srcPos.numKeys === 0) {
                    var sv = srcPos.value;
                    var tv = tgtPos.value;
                    tgtPos.setValue([tv[0], sv[1]]);
                } else {
                    _ckCopyPropertyValue(srcPos, tgtPos, srcIn, tgtIn, tgtOut, srcOut);
                }
            }
        } catch (posErr) {}

        // 3. Other transform properties: Scale, Rotation, Opacity
        var otherProps = [
            'ADBE Scale',
            'ADBE Rotate Z',
            'ADBE Opacity'
        ];

        try {
            if (srcLayer.threeDLayer && tgtLayer.threeDLayer) {
                otherProps.push('ADBE Rotate X');
                otherProps.push('ADBE Rotate Y');
            }
        } catch (e3d) {}

        for (var i = 0; i < otherProps.length; i++) {
            try {
                var sp = srcXform.property(otherProps[i]);
                var tp = tgtXform.property(otherProps[i]);
                if (sp && tp) {
                    _ckCopyPropertyValue(sp, tp, srcIn, tgtIn, tgtOut, srcOut);
                }
            } catch (xfErr) {}
        }
    } catch (e) { /* transform copy failed */ }
}

/**
 * _ckIsTextLayer — Robust check whether an AE layer is a TextLayer.
 * Works across all AE versions and ExtendScript contexts.
 */
function _ckIsTextLayer(layer) {
    if (!layer) return false;
    try {
        if (layer instanceof TextLayer) return true;
    } catch (e1) {}
    try {
        if (layer.property && layer.property('ADBE Text Properties') !== null) return true;
    } catch (e2) {}
    return false;
}

/**
 * _ckSyncLayerSwitches — Mirror timeline layer switches from reference layer to target.
 * Synchronizes 3D state (both standard 3D and per-character 3D), motion blur,
 * quality switches, blend modes, and flags.
 */
function _ckSyncLayerSwitches(srcLayer, tgtLayer) {
    if (!srcLayer || !tgtLayer) return;

    // 1. Standard 3D Layer Switch (solid cube)
    try {
        tgtLayer.threeDLayer = (srcLayer.threeDLayer === true);
    } catch (e3d) {}

    // 2. Per-Character 3D on Text Layers (dotted wireframe cube)
    try {
        var src3DPerChar = false;
        try {
            if (typeof srcLayer.threeDPerChar !== 'undefined') {
                src3DPerChar = (srcLayer.threeDPerChar === true);
            }
        } catch (s3pErr) {}

        if (typeof tgtLayer.threeDPerChar !== 'undefined') {
            tgtLayer.threeDPerChar = src3DPerChar;
        }

        // Also ensure ADBE Text Character 3D under More Options is synced if present
        try {
            var tgtText = tgtLayer.property('ADBE Text Properties');
            if (tgtText) {
                var moreOpts = tgtText.property('ADBE Text More Options');
                if (moreOpts) {
                    var char3DProp = moreOpts.property('ADBE Text Character 3D');
                    if (char3DProp) {
                        char3DProp.setValue(src3DPerChar ? 1 : 0);
                    }
                }
            }
        } catch (eMore) {}
    } catch (ePerChar) {}

    // 3. Motion Blur Switch (three overlapping circles)
    try {
        tgtLayer.motionBlur = (srcLayer.motionBlur === true);
    } catch (eMb) {}

    // 4. Quality & Sampling Quality switches (Draft vs Best)
    try {
        if (srcLayer.quality !== undefined) tgtLayer.quality = srcLayer.quality;
    } catch (eQ) {}
    try {
        if (srcLayer.samplingQuality !== undefined) tgtLayer.samplingQuality = srcLayer.samplingQuality;
    } catch (eSq) {}

    // 5. Effects Active toggle (fx switch)
    try {
        if (srcLayer.effectsActive !== undefined) tgtLayer.effectsActive = srcLayer.effectsActive;
    } catch (eFx) {}

    // 6. Blending Mode & Preserve Transparency
    try {
        if (srcLayer.blendingMode !== undefined) tgtLayer.blendingMode = srcLayer.blendingMode;
    } catch (eBm) {}
    try {
        if (srcLayer.preserveTransparency !== undefined) tgtLayer.preserveTransparency = srcLayer.preserveTransparency;
    } catch (ePt) {}

    // 7. Adjustment Layer & Guide Layer
    try {
        if (srcLayer.adjustmentLayer !== undefined) tgtLayer.adjustmentLayer = srcLayer.adjustmentLayer;
    } catch (eAdj) {}
    try {
        if (srcLayer.guideLayer !== undefined) tgtLayer.guideLayer = srcLayer.guideLayer;
    } catch (eGd) {}

    // 8. Label Color
    try {
        if (srcLayer.label !== undefined) tgtLayer.label = srcLayer.label;
    } catch (eLbl) {}
}

/**
 * applyStyleToAll — Main entry point called from the Yashkit panel.
 *
 * Accepts a JSON string with options:
 *   {
 *     scope:          "all" | "selected",
 *     copyText:       true/false,
 *     copyAnimators:  true/false,
 *     copyEffects:    true/false,
 *     copyTransform:  true/false
 *   }
 *
 * Validates the active comp, identifies the source text layer, discovers
 * targets, and delegates to the appropriate copier functions.
 *
 * @param  {string} optsStr — JSON-encoded options
 * @return {string} — JSON response { status, modifiedCount, skippedCount, message }
 */
function applyStyleToAll(optsStr) {
    var opts;
    try {
        opts = eval('(' + optsStr + ')');
    } catch (parseErr) {
        return _ckStringify({ status: 'error', message: 'Invalid options: ' + parseErr.toString() });
    }

    // ── Defaults ────────────────────────────────────────────────────
    var scope         = opts.scope || 'all';
    var copyText      = (opts.copyText !== false);
    var copyAnimators = (opts.copyAnimators !== false);
    var copyEffects   = (opts.copyEffects !== false);
    var copyTransform = (opts.copyTransform !== false);

    try {
        // ── 1. Validate active composition ──────────────────────────
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return _ckStringify({
                status: 'error',
                message: 'No active composition. Click on the composition in the Project panel first.'
            });
        }

        // ── 2. Identify source (template) text layer ────────────────
        var selectedLayers = comp.selectedLayers;
        if (!selectedLayers || selectedLayers.length === 0) {
            return _ckStringify({
                status: 'error',
                message: 'No layer selected. Select a styled text layer to use as the source.'
            });
        }

        // Find the first selected TextLayer — that's our source
        var sourceLayer = null;
        for (var s = 0; s < selectedLayers.length; s++) {
            if (_ckIsTextLayer(selectedLayers[s])) {
                sourceLayer = selectedLayers[s];
                break;
            }
        }

        if (!sourceLayer) {
            return _ckStringify({
                status: 'error',
                message: 'No text layer selected. Select a text layer to use as the style source.'
            });
        }

        // ── 3. Discover target text layers ──────────────────────────
        var targets = [];
        if (scope === 'selected') {
            // Only other SELECTED text layers
            for (var s2 = 0; s2 < selectedLayers.length; s2++) {
                var sl = selectedLayers[s2];
                if (_ckIsTextLayer(sl) && sl.index !== sourceLayer.index) {
                    targets.push(sl);
                }
            }
        } else {
            // All text layers in the comp (except the source)
            for (var i = 1; i <= comp.numLayers; i++) {
                var layer = comp.layer(i);
                if (_ckIsTextLayer(layer) && layer.index !== sourceLayer.index) {
                    targets.push(layer);
                }
            }
        }

        if (targets.length === 0) {
            return _ckStringify({
                status: 'error',
                message: 'No other text layers found to apply the style to.'
            });
        }

        // ── 4. Apply styles inside a single undo group ──────────────
        app.beginUndoGroup('Yashkit: Apply Style to All');

        // Automatically enable comp-level motion blur if source text has motion blur
        try {
            if (sourceLayer.motionBlur && comp.motionBlur !== undefined && !comp.motionBlur) {
                comp.motionBlur = true;
            }
        } catch (cmbErr) {}

        var modifiedCount = 0;
        var skippedCount  = 0;

        for (var t = 0; t < targets.length; t++) {
            var tgt = targets[t];

            // Skip locked layers
            if (tgt.locked) {
                skippedCount++;
                continue;
            }

            try {
                // Determine target boundaries for keyframe time clamping
                var tgtIn  = tgt.inPoint;
                var tgtOut = tgt.outPoint;
                var srcIn  = sourceLayer.inPoint;
                var srcOut = sourceLayer.outPoint;

                // 1. Initial switches sync before copying properties (ensures 3D props exist if source is 3D)
                _ckSyncLayerSwitches(sourceLayer, tgt);

                if (copyText) {
                    _ckCopyTextStyle(sourceLayer, tgt);
                    _ckCopyTextMoreAndPathOptions(sourceLayer, tgt, srcIn, tgtIn, tgtOut, srcOut);
                }
                if (copyAnimators) {
                    _ckCopyAnimators(sourceLayer, tgt, srcIn, tgtIn, tgtOut, srcOut);
                }
                if (copyEffects) {
                    _ckCopyEffects(sourceLayer, tgt, srcIn, tgtIn, tgtOut, srcOut);
                }
                if (copyTransform) {
                    _ckCopyTransform(sourceLayer, tgt, srcIn, tgtIn, tgtOut, srcOut);
                    _ckCopyLayerTopLevelGroups(sourceLayer, tgt, srcIn, tgtIn, tgtOut);
                }

                // 2. Final switches sync after copying (guarantees 3D, per-char-3D, motionBlur, and flags match sourceLayer)
                _ckSyncLayerSwitches(sourceLayer, tgt);

                modifiedCount++;
            } catch (layerErr) {
                // One layer failing shouldn't stop the batch
                skippedCount++;
            }
        }

        app.endUndoGroup();

        // ── 5. Return result ────────────────────────────────────────
        var msg = 'Applied style to ' + modifiedCount + ' layer' + (modifiedCount !== 1 ? 's' : '');
        if (skippedCount > 0) msg += ' (' + skippedCount + ' skipped)';
        return _ckStringify({
            status: 'success',
            modifiedCount: modifiedCount,
            skippedCount: skippedCount,
            message: msg
        });

    } catch (e) {
        try { app.endUndoGroup(); } catch (u) {}
        return _ckStringify({
            status: 'error',
            message: 'applyStyleToAll: ' + e.toString()
        });
    }
}

/**
 * fixInvisibleCaptions — Repairs all text layers in the active composition
 * that have become invisible due to crushed keyframes, stuck animators, or
 * misaligned anchor points. Restores full visibility and centering immediately.
 *
 * @return {string} — JSON response { status, message }
 */
function fixInvisibleCaptions() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return _ckStringify({
                status: 'error',
                message: 'No active composition. Open your composition and try again.'
            });
        }

        app.beginUndoGroup('Yashkit: Fix Invisible Captions');

        var fixedCount = 0;

        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (!_ckIsTextLayer(layer)) continue;
            if (layer.locked) continue;

            var modified = false;
            var tIn  = layer.inPoint;
            var tOut = layer.outPoint;
            var dur  = tOut - tIn;
            if (dur <= 0) continue;

            // 1. Restore Transform Opacity if stuck at 0 or crushed
            try {
                var xf = layer.property('ADBE Transform Group');
                var op = xf ? xf.property('ADBE Opacity') : null;
                if (op) {
                    if (op.numKeys === 0) {
                        if (op.value < 50) {
                            op.setValue(100);
                            modified = true;
                        }
                    } else {
                        // Check if keyframes leave opacity near 0 in the middle of the layer
                        var midVal = op.valueAtTime(tIn + dur * 0.5, false);
                        if (midVal < 30) {
                            while (op.numKeys > 0) op.removeKey(1);
                            var inD  = Math.min(0.12, dur * 0.25);
                            var outD = Math.min(0.12, dur * 0.25);
                            op.setValueAtTime(tIn, 0);
                            op.setValueAtTime(tIn + inD, 100);
                            if (tOut - outD > tIn + inD) {
                                op.setValueAtTime(tOut - outD, 100);
                            }
                            op.setValueAtTime(tOut, 0);
                            _easeKeys(op);
                            modified = true;
                        }
                    }
                }
            } catch (opErr) {}

            // 2. Restore Text Animators (fix Range Selector End and stuck Opacity=0)
            try {
                var textProp = layer.property('ADBE Text Properties');
                var animators = textProp ? textProp.property('ADBE Text Animators') : null;
                if (animators && animators.numProperties > 0) {
                    var doc = textProp.property('ADBE Text Document').value;
                    var textLen = (doc && doc.text) ? doc.text.length : 1;

                    for (var a = 1; a <= animators.numProperties; a++) {
                        var anim = animators.property(a);
                        var aProps = anim ? anim.property('ADBE Text Animator Properties') : null;
                        if (!aProps) continue;

                        var opProp = aProps.property('ADBE Text Opacity');
                        // If animator has Opacity = 0, check its Range Selectors
                        if (opProp && opProp.value === 0) {
                            var sels = anim.property('ADBE Text Selectors');
                            if (sels && sels.numProperties > 0) {
                                for (var s = 1; s <= sels.numProperties; s++) {
                                    var sel = sels.property(s);
                                    var endProp = sel.property('ADBE Text Index End');
                                    var startProp = sel.property('ADBE Text Index Start');
                                    var pctStart = sel.property('ADBE Text Percent Start');

                                    if (endProp && endProp.value !== textLen) {
                                        endProp.setValue(textLen);
                                        modified = true;
                                    }

                                    if (startProp && startProp.numKeys > 0) {
                                        var lastKeyVal = startProp.keyValue(startProp.numKeys);
                                        if (lastKeyVal < textLen) {
                                            startProp.setValueAtTime(Math.min(tOut, tIn + dur * 0.7), textLen);
                                            modified = true;
                                        }
                                    } else if (pctStart && pctStart.numKeys > 0) {
                                        var lastPct = pctStart.keyValue(pctStart.numKeys);
                                        if (lastPct < 100) {
                                            pctStart.setValueAtTime(Math.min(tOut, tIn + dur * 0.7), 100);
                                            modified = true;
                                        }
                                    } else if (!startProp || startProp.numKeys === 0) {
                                        // Static start = 0 with opacity 0 hides all text permanently — fix by disabling or removing
                                        try { anim.enabled = false; modified = true; } catch (enErr) {}
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (animErr) {}

            // 3. Re-center Anchor Point on layer's own text bounds
            try {
                var r = layer.sourceRectAtTime(tIn, false);
                if (r.width > 0 && r.height > 0) {
                    var desiredX = r.left + r.width / 2;
                    var desiredY = r.top + r.height / 2;
                    var xf2 = layer.property('ADBE Transform Group');
                    var ap = xf2 ? xf2.property('ADBE Anchor Point') : null;
                    if (ap) {
                        var curAp = ap.value;
                        if (Math.abs(curAp[0] - desiredX) > 5 || Math.abs(curAp[1] - desiredY) > 5) {
                            ap.setValue([desiredX, desiredY]);
                            modified = true;
                        }
                    }
                }
            } catch (apErr) {}

            if (modified) fixedCount++;
        }

        app.endUndoGroup();

        return _ckStringify({
            status: 'success',
            message: 'Fixed ' + fixedCount + ' text layer' + (fixedCount !== 1 ? 's' : '') + '. All captions are now visible!'
        });
    } catch (err) {
        try { app.endUndoGroup(); } catch (u) {}
        return _ckStringify({
            status: 'error',
            message: 'fixInvisibleCaptions: ' + err.toString()
        });
    }
}
