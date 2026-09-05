/**
 * transliterate.js — Devanagari → Casual Roman (Hinglish)
 *
 * Converts Hindi Devanagari to the informal Roman spellings used on
 * Indian social media: "yaar", "kya", "nahi", "bahut", "theek hai".
 *
 * Key fixes over v1
 * ─────────────────
 * • Nukta (़ U+093C) handled as a modifier on the preceding consonant,
 *   so ज + ़ → 'z', फ + ़ → 'f', etc. (fixes "zindagi" → was "jaindagi")
 * • Y-glide and W-glide insertion between adjacent vowels:
 *   ि/ी + any vowel → insert 'y'  (fixes "liye" → was "lie")
 *   ु/ू + any vowel → insert 'w'
 * • Anusvara (ं) and chandrabindu (ँ) after matras correctly output 'n'
 * • Latin characters (English passthrough) never touched
 */

'use strict';

var Transliterate = (function() {

  var NUKTA = '़';   // ़  combines with previous consonant

  // ── Consonant base forms ──────────────────────────────────────────
  var CON = {
    'क':'k',  'ख':'kh', 'ग':'g',  'घ':'gh', 'ङ':'ng',
    'च':'ch', 'छ':'chh','ज':'j',  'झ':'jh', 'ञ':'ny',
    'ट':'t',  'ठ':'th', 'ड':'d',  'ढ':'dh', 'ण':'n',
    'त':'t',  'थ':'th', 'द':'d',  'ध':'dh', 'न':'n',
    'प':'p',  'फ':'ph', 'ब':'b',  'भ':'bh', 'म':'m',
    'य':'y',  'र':'r',  'ल':'l',  'व':'v',
    'श':'sh', 'ष':'sh', 'स':'s',  'ह':'h',
    'ळ':'l',  'ऴ':'r',
  };

  // Nukta-modified consonants (foreign sounds)
  // Keyed as "base + NUKTA" to handle decomposed Unicode
  var CON_NUKTA = {
    'क':'q',  // क़
    'ख':'kh', // ख़ (aspirated k, often still kh in Hinglish)
    'ग':'g',  // ग़ (voiced velar fricative → g in casual)
    'ज':'z',  // ज़  ← fixes zindagi
    'ड':'r',  // ड़
    'ढ':'rh', // ढ़
    'फ':'f',  // फ़  ← fixes 'f' sound words
    'न':'n',  // ऩ
    'य':'y',  // य़
    'र':'r',  // ऱ
    'ल':'l',  // ल़
    'व':'v',  // व़
  };

  // ── Independent vowels ────────────────────────────────────────────
  var VOW = {
    'अ':'a',  'आ':'aa', 'इ':'i',  'ई':'i',
    'उ':'u',  'ऊ':'u',  'ऋ':'ri',
    'ए':'e',  'ऐ':'ai', 'ओ':'o',  'औ':'au',
    'ऑ':'o',  'ॲ':'a',  'ऍ':'e',
  };

  // Vowel "family" for glide insertion
  // front (i/e family) → 'y' glide before next vowel
  // back  (u/o family) → 'w' glide before next vowel
  var GLIDE = {
    'i':'y', 'ee':'y', 'e':'y', 'ai':'y',
    'u':'w', 'oo':'w', 'o':'w', 'au':'w',
  };

  // ── Matra (dependent vowel signs) ────────────────────────────────
  var MAT = {
    'ा':'aa',  // ा  long a  → 'aa' (yaar, baat)
    'ि':'i',   // ि  short i
    'ी':'i',   // ी  long i  → same in casual Hinglish
    'ु':'u',   // ु  short u
    'ू':'u',   // ू  long u  → same in casual Hinglish
    'ृ':'ri',  // ृ  vocalic r
    'े':'e',   // े  e
    'ै':'ai',  // ै  ai
    'ो':'o',   // ो  o
    'ौ':'au',  // ौ  au
    'ॉ':'o',   // ॉ  short o
    'ॅ':'e',   // ॅ  short e
    'ं':'n',   // ं  anusvara
    'ः':'h',   // ः  visarga (rare in Hinglish)
    'ँ':'n',   // ँ  chandrabindu
    '्':'',    // ्  virama — suppresses inherent 'a'
    'ऀ':'',    // ꣲ  various zero-width
  };

  var NUM = {
    '०':'0','१':'1','२':'2','३':'3','४':'4',
    '५':'5','६':'6','७':'7','८':'8','९':'9',
  };

  function isDev(ch) {
    var c = ch.codePointAt(0);
    return c >= 0x0900 && c <= 0x097F;
  }

  // ── Core romanizer ────────────────────────────────────────────────
  function romanizeToken(token) {
    var chars = Array.from(token);
    var out   = '';
    var n     = chars.length;
    var i     = 0;
    var lastVowelOut = '';   // tracks last vowel emitted for glide insertion

    while (i < n) {
      var ch = chars[i];

      // ── Latin / ASCII passthrough ─────────────────────────────────
      if (!isDev(ch)) {
        out += ch;
        lastVowelOut = '';
        i++;
        continue;
      }

      // ── Devanagari numeral ────────────────────────────────────────
      if (NUM[ch]) {
        out += NUM[ch];
        lastVowelOut = '';
        i++;
        continue;
      }

      // ── Punctuation ───────────────────────────────────────────────
      if (ch === '।' || ch === '॥') {
        out += '.';
        lastVowelOut = '';
        i++;
        continue;
      }

      // ── Nukta (modifier) — should have been consumed by consonant block,
      //    but handle stray nuktas gracefully by skipping ──────────────
      if (ch === NUKTA) {
        i++;
        continue;
      }

      // ── Independent vowel ─────────────────────────────────────────
      if (VOW[ch] !== undefined) {
        // Insert glide if previous vowel requires it
        var vRom = VOW[ch];
        if (lastVowelOut && GLIDE[lastVowelOut]) {
          out += GLIDE[lastVowelOut];
        }
        out += vRom;
        lastVowelOut = vRom;
        i++;
        continue;
      }

      // ── Consonant ─────────────────────────────────────────────────
      if (CON[ch] !== undefined) {
        // Peek ahead for nukta modifier
        var conRom;
        if (i + 1 < n && chars[i + 1] === NUKTA) {
          conRom = CON_NUKTA[ch] || CON[ch];
          i += 2;   // consume consonant + nukta
        } else {
          conRom = CON[ch];
          i++;
        }
        out += conRom;
        lastVowelOut = '';

        // Now decide which vowel follows this consonant
        var next = i < n ? chars[i] : null;

        if (next && MAT[next] !== undefined) {
          // Explicit matra (including virama which gives '')
          var matraVal = MAT[next];
          out += matraVal;
          i++;
          lastVowelOut = matraVal;

          // Consume any chained modifiers (anusvara / chandrabindu after matra)
          while (i < n && (chars[i] === 'ं' || chars[i] === 'ँ')) {
            out += MAT[chars[i]];   // 'n'
            i++;
          }

        } else if (next && CON[next] !== undefined) {
          // Next is another consonant (no virama between them)
          // → current consonant keeps inherent 'a'
          out += 'a';
          lastVowelOut = 'a';

        } else if (!next || !isDev(next)) {
          // End of word / Latin follows → schwa deletion (drop inherent 'a')
          // e.g. "कर" → "kar", not "kara"
          lastVowelOut = '';

        } else {
          // Independent vowel or other Devanagari follows
          out += 'a';
          lastVowelOut = 'a';
        }
        continue;
      }

      // ── Standalone matra (anusvara etc. after a matra) ────────────
      if (MAT[ch] !== undefined) {
        out += MAT[ch];
        i++;
        continue;
      }

      // ── Unknown Devanagari — skip ─────────────────────────────────
      i++;
    }

    return out;
  }

  // ── Public API ────────────────────────────────────────────────────
  function romanize(text) {
    if (!text || typeof text !== 'string') return text || '';
    return text.replace(/\S+/g, function(token) {
      // Quick check: any Devanagari in this token?
      for (var i = 0; i < token.length; i++) {
        var c = token.codePointAt(i);
        if (c >= 0x0900 && c <= 0x097F) return romanizeToken(token);
      }
      return token;   // Pure Latin — leave untouched
    });
  }

  // ── Self-test ─────────────────────────────────────────────────────
  var TESTS = [
    // [input_devanagari,      expected_roman]
    ['मैं',          'main'],
    ['यार',          'yaar'],
    ['क्या',         'kya'],
    ['नहीं',         'nahin'],
    ['बहुत',         'bahut'],
    ['रहा',          'rahaa'],
    ['हूँ',          'hun'],
    ['ठीक',          'theek'],
    ['है',           'hai'],
    ['घर',           'ghar'],
    ['लिए',          'liye'],     // y-glide fix ← was "lie"
    ['ज़िंदगी',      'zindagi'],  // nukta fix   ← was "jaindagi"
    ['ज़िन्दगी',     'zindagi'],  // virama form
    ['ज़रूरी',       'zaroori'],
    ['office',       'office'],  // Latin passthrough
    ['मैं office जा रहा हूँ', 'main office jaa rahaa hun'],
  ];

  var pass = 0;
  TESTS.forEach(function(t) {
    var got = romanize(t[0]);
    if (got === t[1]) {
      pass++;
    } else {
      console.warn('[Transliterate] FAIL "' + t[0] +
        '" → got "' + got + '" expected "' + t[1] + '"');
    }
  });
  console.log('[Transliterate] ' + pass + '/' + TESTS.length +
    ' self-tests passed.');

  return { romanize: romanize };

})();
