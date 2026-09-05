/**
 * main.js — Pulse Captions UI Controller
 * Smallest AI
 *
 * Generation flow (batch/REST — no WebSocket):
 *
 *   1. getClipInfo()          → clip path + in/out points (ExtendScript)
 *   2. extractAudioToFile()   → temp WAV on disk (ffmpeg)
 *   3. PulseBatchAPI.transcribe() → full transcript + word timestamps (REST)
 *   4. groupWordsToCaptions() → timed caption objects
 *   5. placeCaptionsFromFile() → AE/PPRO layers (ExtendScript)
 */

'use strict';

/* ── Config ─────────────────────────────────────────────────────── */
// All API access goes through the proxy server (js/config.js) — no secret
// keys live in the plugin. YASHKIT_CONFIG is defined in js/config.js.
var CONFIG = (typeof YASHKIT_CONFIG !== 'undefined') ? YASHKIT_CONFIG
  : { PROXY_BASE_URL: 'http://localhost:8787', APP_TOKEN: '' };

/* ── Globals ────────────────────────────────────────────────────── */
var csInterface = new CSInterface();
var batchAPI = new PulseBatchAPI(CONFIG);
var audioProcessor = new AudioProcessor();

/* ── App State ──────────────────────────────────────────────────── */
var state = {
  isGenerating: false,
  words: [],
  captions: [],
  language: 'English',   // display name of the picked language (summary row)
  captionMode: 'phrase',
  phraseSize: 4,
  appType: null,
  style: {
    preset: 'default',
    fontSize: 60,
    position: 'bottom',
    textColor: '#FFFFFF',
    highlightColor: '#FFE000',   // active-word colour (karaoke / hormozi renderers)
    animation: 'wordappear',  // 'none' | built-in style id | 'ffx' (bundled preset)
    animSpeed: 1,       // word-by-word reveal speed multiplier (Fast .65 / Normal 1 / Slow 1.5)
    emojiOn: false,     // auto-emoji: LLM picks one emoji per caption (js/ai-emoji.js)
    strokeOn: false,    // outline around the text — legibility over busy footage
    strokeColor: '#000000',
    strokeWeight: 'thin',   // 'thin' | 'bold' — scaled from font size at render
    ffxPath: '',        // absolute path of the chosen .ffx preset ('' = none)
    ffxName: '',        // display name of the chosen preset
    font: '',           // PostScript name of the chosen font ('' = comp default)
    pairFont: '',       // Font Pair intro line: PostScript name ('' = Georgia Italic)
    pairFontFamily: '',
    pairFontStyle: '',
    pairColor: '#FFFFFF',   // Font Pair intro line colour
    fontFamily: '',     // family + style (for fallback / display)
    fontStyle: ''
  },
  scope: 'selected',
  hasGenerated: false,   // gates the Generate→Regenerate button label
  tempAudioPath: null,   // cleaned up after upload
  seqWidth: 1920,   // updated from getClipInfo — passed to ExtendScript for MOGRT sizing
  seqHeight: 1080,
  mogrtPath: '',     // selected caption-style .mogrt (Premiere)
  mogrtName: '',     // display name of the picked style (summary row)
  translatedTo: '',        // target code once captions are translated ('' = original)
  exportSource: 'translated'   // which text SRT/VTT writes while translated
};

/* ── Flow config (guided steps) ─────────────────────────────────── */
/* Languages shown in the step-0 dropdown. Codes map to the hidden
   #sourceLanguage select the generation pipeline reads (its <option> list is
   generated from this array, so the two can't drift apart).

   [code, name, description, flag]

   EVERY code below was verified by POSTing a real 0.6s clip to the live
   /api/stt endpoint with ?model=pulse and checking for a 2xx. The API validates
   `language` against an enum AND against what the account's region has
   enabled, so "documented by Pulse" is not the same as "works for our users" —
   see PENDING_LANGS for the ones that are documented but come back 400.

   Note on auto-detect: the transcriber's scoped detection modes (multi-indic /
   multi-eu / multi-asian) do work on our key, but detection is not offered —
   picking the language is one tap and always right, where a wrong guess costs a
   whole re-transcription. If it comes back, it belongs above the named
   languages as its own group. (Pulse's global 'multi' scope is NOT enabled on
   our key, and omitting the parameter defaults to it and fails.) */
var LANGS = [
  ['en',       'English',    'Most common',         '🇺🇸'],
  ['hinglish', 'Hinglish',   'Hindi + English mix', '🇮🇳'],
  ['hi',       'Hindi',      'हिन्दी',                '🇮🇳'],
  ['bn',       'Bengali',    'বাংলা',                 '🇮🇳'],
  ['gu',       'Gujarati',   'ગુજરાતી',               '🇮🇳'],
  ['mr',       'Marathi',    'मराठी',                 '🇮🇳'],
  ['or',       'Odia',       'ଓଡ଼ିଆ',                  '🇮🇳'],
  ['es',       'Spanish',    'Español',             '🇪🇸'],
  ['fr',       'French',     'Français',            '🇫🇷'],
  ['de',       'German',     'Deutsch',             '🇩🇪'],
  ['it',       'Italian',    'Italiano',            '🇮🇹'],
  ['pt',       'Portuguese', 'Português',           '🇵🇹'],
  ['nl',       'Dutch',      'Nederlands',          '🇳🇱'],
  ['ru',       'Russian',    'Русский',             '🇷🇺'],
  ['uk',       'Ukrainian',  'Українська',          '🇺🇦'],
  ['pl',       'Polish',     'Polski',              '🇵🇱'],
  ['cs',       'Czech',      'Čeština',             '🇨🇿'],
  ['sk',       'Slovak',     'Slovenčina',          '🇸🇰'],
  ['ro',       'Romanian',   'Română',              '🇷🇴'],
  ['hu',       'Hungarian',  'Magyar',              '🇭🇺'],
  ['bg',       'Bulgarian',  'Български',           '🇧🇬'],
  ['fi',       'Finnish',    'Suomi',               '🇫🇮'],
  ['sv',       'Swedish',    'Svenska',             '🇸🇪'],
  ['da',       'Danish',     'Dansk',               '🇩🇰'],
  ['et',       'Estonian',   'Eesti',               '🇪🇪'],
  ['lv',       'Latvian',    'Latviešu',            '🇱🇻'],
  ['lt',       'Lithuanian', 'Lietuvių',            '🇱🇹'],
  ['mt',       'Maltese',    'Malti',               '🇲🇹'],
  ['ja',       'Japanese',   '日本語',                '🇯🇵'],
  ['ko',       'Korean',     '한국어',                '🇰🇷'],
  ['zh',       'Chinese',    '中文',                  '🇨🇳']
];

/* Codes Pulse documents but that come back 400
   LANGUAGE_NOT_ENABLED_IN_REGION on our key — so they are NOT offered. Tamil,
   Telugu, Kannada, Malayalam and Punjabi were in the picker before this list
   was verified, and every one of them failed at transcription time. Move a code
   up into LANGS once access is granted; each entry is
   [code, name, native, flag] ready to paste. */
var PENDING_LANGS = [
  ['ta',  'Tamil',      'தமிழ்',     '🇮🇳'],
  ['te',  'Telugu',     'తెలుగు',    '🇮🇳'],
  ['kn',  'Kannada',    'ಕನ್ನಡ',     '🇮🇳'],
  ['ml',  'Malayalam',  'മലയാളം',   '🇮🇳'],
  ['pa',  'Punjabi',    'ਪੰਜਾਬੀ',     '🇮🇳'],
  ['yue', 'Cantonese',  '粵語',       '🇭🇰'],
  ['ms',  'Malay',      'Melayu',   '🇲🇾'],
  ['id',  'Indonesian', 'Bahasa',   '🇮🇩'],
  ['tl',  'Filipino',   'Tagalog',  '🇵🇭']
];

/* The language the panel opens on. */
var DEFAULT_LANG = 'en';


var MODES = [
  { id: 'word',     nm: 'Word',     ds: '1 word / layer' },
  { id: 'phrase',   nm: 'Phrase',   ds: 'best for reels' },
  { id: 'sentence', nm: 'Sentence', ds: 'subtitle style' },
  { id: 'smart',    nm: 'Smart',    ds: 'AI line breaks' }
];

/* Built-in caption styles. Additional styles are still auto-loaded from
   the extension's /presets folder (*.ffx) and appear after these. */
/* Grouped so 20 styles stay scannable: the ones people reach for first, the
   creator looks that carry a strong identity, and the quieter title styles. */
var ANIMS = [
  // ── Word-timed (the default reach) ──
  { id: 'wordappear', nm: 'Word Appear',     ds: 'words pop in instantly',    cls: 'aa-appear',   grp: 'Word by word' },
  { id: 'word',       nm: 'Slide Up',        ds: 'word by word, smooth rise', cls: 'aa-slide',    grp: 'Word by word' },
  { id: 'wordfade',   nm: 'Word Fade',       ds: 'words fade in one by one',  cls: 'aa-wordfade', grp: 'Word by word' },
  { id: 'karaoke',    nm: 'Karaoke',         ds: 'word highlights in sync',   cls: 'aa-karaoke',  grp: 'Word by word' },
  { id: 'spotlight',  nm: 'Spotlight',       ds: 'spoken word zooms, in sync', cls: 'aa-spotlight', grp: 'Word by word' },
  { id: 'flipup',     nm: 'Flip Up',         ds: 'words swing in one by one',  cls: 'aa-flipup',   grp: 'Word by word' },
  { id: 'shuffle',    nm: 'Shuffle',         ds: 'words land in random order', cls: 'aa-shuffle',  grp: 'Word by word' },

  // ── Creator looks (strong identity, heavier type) ──
  { id: 'gaming',     nm: 'Gaming',          ds: 'thick outline, punches in',  cls: 'aa-gaming',   grp: 'Creator looks' },
  { id: 'hormozi',    nm: 'Creator Caps',    ds: 'bold caps, accent per word', cls: 'aa-hormozi',  grp: 'Creator looks' },
  { id: 'neon',       nm: 'Neon',            ds: 'glowing text, soft pulse',   cls: 'aa-neon',     grp: 'Creator looks' },
  { id: 'pulse',      nm: 'Pulse',           ds: 'caption beats with the voice', cls: 'aa-pulse',  grp: 'Creator looks' },
  { id: 'boxed',      nm: 'With Background', ds: 'text on a backing shape',   cls: 'aa-boxed',     grp: 'Creator looks' },
  { id: 'emphasis',   nm: 'Emphasis',        ds: 'AI splits lines by weight',  cls: 'aa-emphasis', grp: 'Creator looks' },
  { id: 'fontpair',   nm: 'Font Pair',       ds: 'two fonts, AI-split lines',  cls: 'aa-fontpair', grp: 'Creator looks' },

  // ── Title / subtitle looks (quiet, no per-word motion) ──
  { id: 'cinematic',  nm: 'Cinematic',       ds: 'tracked caps, slow drift',   cls: 'aa-cinematic', grp: 'Titles' },
  { id: 'minimal',    nm: 'Minimal',         ds: 'small tracked caps',        cls: 'aa-minimal',   grp: 'Titles' },
  { id: 'type',       nm: 'Typewriter',      ds: 'types itself on',           cls: 'aa-type',      grp: 'Titles' },
  { id: 'blur',       nm: 'Blur In',         ds: 'resolves from soft focus',  cls: 'aa-blur',      grp: 'Titles' },
  { id: 'bounce',     nm: 'Bounce',          ds: 'playful overshoot settle',  cls: 'aa-bounce',    grp: 'Titles' },
  { id: 'none',       nm: 'Static',          ds: 'no animation',              cls: 'aa-none',      grp: 'Titles' }
];

/* Premiere motion options. Premiere can't animate inside a single text object,
   so these are the styles host/index.jsx knows how to build out of per-word
   graphic clips plus keyframed Motion (see _tryNativeAnimatedCaptions). The
   chosen .mogrt still supplies the look; this supplies the movement. */
var PPRO_ANIMS = [
  { id: 'none',       nm: 'Static',      ds: 'one caption per clip, no motion' },
  { id: 'wordappear', nm: 'Word Appear', ds: 'words appear as they are spoken' },
  { id: 'word',       nm: 'Slide Up',    ds: 'line rises in, then words appear' },
  { id: 'karaoke',    nm: 'Beat',        ds: 'full line, a pop on each word' }
];

/* Shared inline SVGs for flow rows */
var IC = {
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4 10-11"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5l4 4M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z"/></svg>',
  word: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="9" width="16" height="6" rx="2"/></svg>',
  phrase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="7" width="16" height="4" rx="1.6"/><rect x="4" y="14" width="9" height="4" rx="1.6"/></svg>',
  sentence: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
  smart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74z"/></svg>',
  type: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h16v2M12 5v14M9 19h6"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>'
};
var MODE_ICONS = { word: IC.word, phrase: IC.phrase, sentence: IC.sentence, smart: IC.smart };
var CHECK_SVG = IC.check;   // used by the font-picker option rows

// GitHub link promoted in the footer ("GitHub") & welcome card.
var GITHUB_URL = 'https://github.com/yashverma2628';
var IG_URL = GITHUB_URL;

/* ═══════════════════════════════════════════════════════════════════
   WHO MADE THIS
   The welcome card shows this once, on first install (and again any
   time someone clicks the header logo). Everything a user reads there
   comes from this block — edit these lines and nothing else.

   `personal` is optional and OFF by default: fill in a real handle and
   a second follow button appears. Left empty, the card shows only the
   Yashkit account, so no one is ever sent to a link that doesn't exist.
 ═══════════════════════════════════════════════════════════════════ */
var MAKER = {
  name:   'Yash',
  role:   'Lead Extension Engineer & Creator',
  // Two short lines. First is the greeting, second is the ask.
  blurb:  'I built Yashkit to make captioning instant and beautiful — ' +
          'real word-level timing, 20 animation styles, and 30+ languages.',
  ask:    'New updates and style presets ship regularly. Enjoy your workflow!',
  // Photo, relative to the panel root. Empty string triggers initials fallback "Y".
  photo:  '',
  // The creator GitHub profile.
  github:         GITHUB_URL,
  githubLabel:    'yashverma2628',
  instagram:      GITHUB_URL,
  instagramLabel: 'yashverma2628',
  // Personal account.
  personal:      'https://www.instagram.com/yashhhverma_/',
  personalLabel: '@yashhhverma_'
};

/* ═══════════════════════════════════════════════════════════════════
   INIT
 ═══════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function () {
  // Previews first: both detectHostApp() (via the Premiere motion rows) and
  // buildFlowRows() build tiles, and both need the preview map populated.
  loadStylePreviews();
  detectHostApp();
  buildFlowRows();
  bindUIEvents();
  initWelcomeCard();
  goToStep(0);
});

window.addEventListener('resize', function () { moveSegThumb(); });

/* ═══════════════════════════════════════════════════════════════════
   WELCOME CARD
   Shown once per install, then never again unless someone clicks the
   header logo. The "seen" flag is versioned, so bumping WELCOME_VERSION
   re-introduces the card to existing users after a big release.
 ═══════════════════════════════════════════════════════════════════ */
var WELCOME_VERSION = 1;
var WELCOME_KEY = 'yashkit.welcome.v' + WELCOME_VERSION;

function _welcomeSeen() {
  // localStorage can throw in a locked-down host — treat any failure as
  // "already seen" so the card can never wedge itself open on every launch.
  try { return window.localStorage.getItem(WELCOME_KEY) === '1'; }
  catch (e) { return true; }
}
function _markWelcomeSeen() {
  try { window.localStorage.setItem(WELCOME_KEY, '1'); } catch (e) { }
}

/* Initials for the little avatar: "Yash Verma" → "YV". */
function _initials(name) {
  var parts = String(name || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').split(' ');
  var out = '';
  for (var i = 0; i < parts.length && out.length < 2; i++) {
    if (parts[i]) out += parts[i].charAt(0).toUpperCase();
  }
  return out || 'YV';
}

function _openExternal(url) {
  if (!url) return;
  try { csInterface.openURLInDefaultBrowser(url); }
  catch (e) { try { window.open(url); } catch (e2) { } }
}

function showWelcomeCard() {
  var wrap = document.getElementById('welcomeCard');
  if (!wrap) return;
  wrap.hidden = false;
}

function hideWelcomeCard() {
  var wrap = document.getElementById('welcomeCard');
  if (wrap) wrap.hidden = true;
  _markWelcomeSeen();
}

function initWelcomeCard() {
  var wrap = document.getElementById('welcomeCard');
  if (!wrap) return;

  // ── Fill from MAKER (textContent throughout — no markup from strings) ──
  var body = document.getElementById('wcBody');
  if (body) body.textContent = MAKER.blurb + ' ' + MAKER.ask;
  var nameEl = document.getElementById('wcName');
  if (nameEl) nameEl.textContent = MAKER.name;
  var roleEl = document.getElementById('wcRole');
  if (roleEl) roleEl.textContent = MAKER.role;
  // Avatar: initials first, then swap in the photo only once it has actually
  // decoded. Doing it in that order means a missing or unreadable file shows
  // "TG" rather than a broken-image glyph.
  var avatar = document.getElementById('wcAvatar');
  if (avatar) {
    avatar.textContent = _initials(MAKER.name);
    if (MAKER.photo) {
      var img = document.createElement('img');
      img.alt = MAKER.name;
      img.addEventListener('load', function () {
        avatar.textContent = '';
        avatar.appendChild(img);
        avatar.classList.add('has-photo');
      });
      img.addEventListener('error', function () {
        console.warn('[Yashkit] welcome photo not found:', MAKER.photo);
      });
      img.src = encodeURI(MAKER.photo);
    }
  }

  var followLb = document.getElementById('welcomeFollowLabel');
  if (followLb) followLb.textContent = MAKER.githubLabel || MAKER.instagramLabel || 'GitHub';

  // Second button only when a real personal link is configured.
  var follow2 = document.getElementById('welcomeFollow2');
  if (follow2) {
    if (MAKER.personal) {
      var lb2 = document.getElementById('welcomeFollow2Label');
      if (lb2) lb2.textContent = MAKER.personalLabel || MAKER.name;
      follow2.hidden = false;
      follow2.addEventListener('click', function () { _openExternal(MAKER.personal); });
    } else {
      follow2.hidden = true;
    }
  }

  var ver = document.getElementById('wcVersion');
  if (ver) {
    // Updater.currentVersion is the version STRING, not a getter.
    var v = (typeof Updater !== 'undefined') ? (Updater.currentVersion || '') : '';
    ver.textContent = v ? ('Yashkit v' + v) : 'Yashkit';
  }

  // ── Wiring ──────────────────────────────────────────────────────
  var followBtn = document.getElementById('welcomeFollow');
  if (followBtn) followBtn.addEventListener('click', function () { _openExternal(MAKER.github || MAKER.instagram || GITHUB_URL); });

  var startBtn = document.getElementById('welcomeStart');
  if (startBtn) startBtn.addEventListener('click', hideWelcomeCard);
  var closeBtn = document.getElementById('welcomeClose');
  if (closeBtn) closeBtn.addEventListener('click', hideWelcomeCard);
  var backdrop = document.getElementById('welcomeBackdrop');
  if (backdrop) backdrop.addEventListener('click', hideWelcomeCard);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !wrap.hidden) hideWelcomeCard();
  });

  // The header logo reopens it, so "who made this" is always findable
  // rather than a one-time thing people miss.
  var logo = document.querySelector('.ck-logo');
  if (logo) {
    logo.style.cursor = 'pointer';
    logo.title = 'About Yashkit';
    logo.addEventListener('click', showWelcomeCard);
  }

  if (!_welcomeSeen()) showWelcomeCard();
}

/* ── Updates permanently disabled ──────────────────────────────── */
function _initUpdateBanner() {
  // Permanently disabled per user request
  return;
}

function detectHostApp() {
  try {
    var env = csInterface.getHostEnvironment();
    state.appType = env ? env.appId : null;
    var appName = state.appType === 'PPRO' ? 'Premiere Pro'
      : state.appType === 'AEFT' ? 'After Effects'
        : 'Adobe CC';
    setStatus('ready', appName + ' · Ready');
    applyHostUI();
  } catch (e) {
    csInterface.evalScript('getHostInfo()', function (result) {
      try {
        var info = JSON.parse(result);
        state.appType = info.appId;
        setStatus('ready', (info.appId === 'PPRO' ? 'Premiere Pro' : 'After Effects') + ' · Ready');
      } catch (e2) { setStatus('ready', 'Ready'); }
      applyHostUI();
    });
  }
}

/* Show the host-appropriate step content:
   After Effects → step 2 = animation styles, step 3 = customize text
   Premiere Pro  → step 2 = MOGRT caption styles, step 3 is skipped
   Falls back to the After Effects layout if the host is unknown. */
function applyHostUI() {
  var b = document.body;
  b.classList.remove('host-aeft', 'host-ppro');
  if (state.appType === 'PPRO') {
    b.classList.add('host-ppro');
    var copy = document.getElementById('styleHeroCopy');
    if (copy) copy.textContent = 'Pick a caption style for your timeline.';
    // Premiere places on the timeline, not an AE comp
    var addLb = document.querySelector('#btnAddToComp span:last-child');
    if (addLb) addLb.textContent = 'Add to Timeline';
    buildPproMotionRows();
    loadMogrtStyles();
  } else {
    b.classList.add('host-aeft');   // AE (and unknown) → caption-style UI
    var copyAE = document.getElementById('styleHeroCopy');
    if (copyAE) copyAE.textContent = 'How should each caption animate onto the screen?';
    var addLbAE = document.querySelector('#btnAddToComp span:last-child');
    if (addLbAE) addLbAE.textContent = 'Add to Comp';
    loadSystemFonts();              // populate the font picker from this machine
    loadFfxPresets();               // style rows from bundled .ffx presets
  }
}

/* Populate the style picker with the .ffx animation presets bundled in the
   extension's /presets folder. Each file becomes a row; picking one stores
   its path so ExtendScript can applyPreset() it on every caption layer.
   Drop a new .ffx in the folder → it appears here, no code changes. */
function loadFfxPresets() {
  var rows = document.getElementById('animRows');
  if (!rows) return;
  // Clear any previously loaded preset rows (keep the built-in "None")
  rows.querySelectorAll('.row[data-ffx]').forEach(function (r) { r.remove(); });
  var note = rows.querySelector('.grouplabel');
  if (note) note.remove();

  var fs, path;
  try { fs = require('fs'); path = require('path'); }
  catch (e) { rows.appendChild(_flowNote('Preset styles unavailable.')); return; }

  var dir = '';
  try {
    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    if (extRoot) dir = path.join(extRoot, 'presets');
  } catch (e) { }

  var files = [];
  try { files = fs.readdirSync(dir).filter(function (f) { return /\.ffx$/i.test(f); }); }
  catch (e) { }

  if (files.length === 0) {
    rows.appendChild(_flowNote('More styles coming soon.'));
    return;
  }

  files.sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); });
  files.forEach(function (f) {
    var full = path.join(dir, f);
    var name = f.replace(/\.ffx$/i, '');

    // A preset can ship its own animated preview as presets/<name>.webp —
    // same convention as the bundled MOGRT thumbnails. Falls back to "Aa".
    var tileMarkup = '<span class="aa aa-none">Aa</span>';
    try {
      if (fs.existsSync(path.join(dir, name + '.webp'))) {
        tileMarkup = '<img src="' + encodeURI('presets/' + name + '.webp') + '" alt="">';
      }
    } catch (e) { }

    var btn = _flowRow(tileMarkup, name, 'animation preset');
    btn.setAttribute('data-ffx', full);
    btn.addEventListener('click', function () {
      state.style.animation = 'ffx';
      state.style.ffxPath = full;
      state.style.ffxName = name;
      _markSelected(rows, btn);
      _updateStyleCtls();
      setTimeout(function () { goToStep(2); }, 240);
    });
    rows.appendChild(btn);
  });
}


/* Populate step 2 with the bundled .mogrt styles from the extension's
   /mogrt folder, rendered as design rows (GIF preview in the tile).
   Selecting one sets the MOGRT used when placing captions in Premiere
   and auto-advances the flow. */
function loadMogrtStyles() {
  var grid = document.getElementById('mogrtGrid');
  if (!grid) return;
  while (grid.firstChild) grid.removeChild(grid.firstChild);

  var fs, path;
  try { fs = require('fs'); path = require('path'); }
  catch (e) { grid.appendChild(_flowNote('Styles unavailable.')); return; }

  var dir = '';
  try {
    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    if (extRoot) dir = path.join(extRoot, 'mogrt');
  } catch (e) { }

  var files = [];
  try { files = fs.readdirSync(dir).filter(function (f) { return /\.mogrt$/i.test(f); }); }
  catch (e) { }

  if (files.length === 0) {
    grid.appendChild(_flowNote('No caption styles bundled.'));
    return;
  }

  // Two labelled categories:
  //   "Best for words"   → simple (always first), slide in, scale in characters
  //   "Best for phrases" → every other style (natural-sorted)
  function _base(f) { return f.replace(/\.mogrt$/i, ''); }
  function _wordRank(f) {
    var n = _base(f).toLowerCase();
    if (n === 'simple') return 0;
    if (n === 'slide in') return 1;
    if (n === 'scale in charcters' || n === 'scale in characters') return 2;
    return -1;   // not a word-level style → goes under "Best for phrases"
  }
  var _nat = function (a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); };

  var wordFiles   = files.filter(function (f) { return _wordRank(f) >= 0; })
                         .sort(function (a, b) { return _wordRank(a) - _wordRank(b); });
  var phraseFiles = files.filter(function (f) { return _wordRank(f) < 0; }).sort(_nat);
  var ordered     = wordFiles.concat(phraseFiles);   // overall order → default pick

  function _makeRow(f, hint) {
    var full = path.join(dir, f);
    var name = _base(f);

    // Tile preview: bundled image (mogrt/<name>.png|jpg|gif) if present, else "Aa".
    var tileHTML = '<span class="aa aa-none">Aa</span>';
    var exts = ['.gif', '.png', '.jpg', '.jpeg'];
    for (var k = 0; k < exts.length; k++) {
      try {
        if (fs.existsSync(path.join(dir, name + exts[k]))) {
          tileHTML = '<img src="' + encodeURI('mogrt/' + name + exts[k]) + '" alt="">';
          break;
        }
      } catch (e) { }
    }

    var btn = _flowRow(tileHTML, name, hint);
    btn.setAttribute('data-mogrt', full);
    btn.addEventListener('click', function () {
      state.mogrtPath = full;
      state.mogrtName = name;
      grid.querySelectorAll('.row').forEach(function (r) {
        var is = r === btn;
        r.classList.toggle('sel', is);
        r.querySelector('.go').innerHTML = is ? IC.check : IC.arrow;
      });
      setTimeout(function () { goToStep(2); }, 240);
    });
    return btn;
  }

  function _addGroup(label, arr, hint) {
    if (!arr.length) return;
    var lab = document.createElement('div');
    lab.className = 'grouplabel';
    lab.textContent = label;
    grid.appendChild(lab);
    for (var i = 0; i < arr.length; i++) grid.appendChild(_makeRow(arr[i], hint));
  }

  _addGroup('Best for words', wordFiles, 'word-level style');
  _addGroup('Best for phrases', phraseFiles, 'phrase style');

  // Default to the first style (simple) and mark it selected.
  state.mogrtPath = path.join(dir, ordered[0]);
  state.mogrtName = _base(ordered[0]);
  var first = grid.querySelector('.row[data-mogrt="' + state.mogrtPath.replace(/"/g, '\\"') + '"]') ||
              grid.querySelector('.row');
  if (first) {
    first.classList.add('sel');
    first.querySelector('.go').innerHTML = IC.check;
  }
}

/* Premiere step 1: how captions should move. Sets state.style.animation, which
   is what host/index.jsx routes on — a ported id goes to the native keyframed
   renderer, 'none' (or anything unported) to the plain one-clip-per-caption
   path. Picking a motion does NOT advance the flow: the caption-style row
   below it does that, so both choices get made. */
function buildPproMotionRows() {
  var rows = document.getElementById('pproMotionRows');
  if (!rows) return;
  while (rows.firstChild) rows.removeChild(rows.firstChild);
  if (_anyStylePreviews()) rows.classList.add('previews');

  PPRO_ANIMS.forEach(function (a) {
    var btn = _flowRow(_animTile(a), a.nm, a.ds);
    btn.setAttribute('data-anim', a.id);
    btn.addEventListener('click', function () {
      state.style.animation = a.id;
      state.style.ffxPath = '';
      state.style.ffxName = '';
      _markSelected(rows, btn);
    });
    rows.appendChild(btn);
    if (a.id === state.style.animation) _markSelected(rows, btn);
  });
}

/* Small muted note inside a rows container */
function _flowNote(text) {
  var d = document.createElement('div');
  d.className = 'grouplabel';
  d.textContent = text;
  return d;
}


/* ═══════════════════════════════════════════════════════════════════
   UI EVENT BINDING
═══════════════════════════════════════════════════════════════════ */
function bindUIEvents() {

  // ── Footer nav (Back / Skip) ──────────────────────────────────────
  document.getElementById('backBtn').addEventListener('click', function () {
    goToStep(Math.max(0, _curStep - 1));
  });
  document.getElementById('skipBtn').addEventListener('click', function () {
    goToStep(Math.min(2, _curStep + 1));
  });

  // ── Customize controls (step 3) ───────────────────────────────────
  initStepper();
  initPosSeg();
  initSpeedSeg();
  initEmojiSeg();
  initStrokeSeg();
  initColorControls();
  initFontPicker();
  initPairFontPicker();
  initPhraseSlider();
  _updateStyleCtls();

  // ── Transcript (step 2): click a line to seek, search to filter ───
  initTranscriptSeek();
  initTranscriptSearch();
  initTranslatePicker();
  initExportSourceSeg();

  // ── Apply To segmented (step 4) ───────────────────────────────────
  var seg = document.getElementById('scopeSeg');
  seg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.scope = b.dataset.scope;
    seg.querySelectorAll('button').forEach(function (x) {
      x.setAttribute('aria-selected', x === b ? 'true' : 'false');
    });
    moveSegThumb();
  });

  // ── Actions ───────────────────────────────────────────────────────
  document.getElementById('btnGenerate').addEventListener('click', startGeneration);
  document.getElementById('btnAddToComp').addEventListener('click', placeOnTimeline);
  document.getElementById('btnCancel').addEventListener('click', cancelGeneration);
  document.getElementById('btnEdit').addEventListener('click', toggleTranscriptEdit);
  document.getElementById('btnExportSRT').addEventListener('click', function () { exportSubtitles('srt'); });
  document.getElementById('btnExportVTT').addEventListener('click', function () { exportSubtitles('vtt'); });
  document.getElementById('btnRegen').addEventListener('click', restartFlow);

  // ── Style Tools (Apply Style to All — AE only) ────────────────────
  (function initStyleTools() {
    var stScopeSeg = document.getElementById('stScopeSeg');
    var stScope = 'all';

    // Scope toggle: "All Text Layers" / "Selected Only"
    if (stScopeSeg) {
      stScopeSeg.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        stScope = b.getAttribute('data-st-scope') || 'all';
        stScopeSeg.querySelectorAll('button').forEach(function (x) {
          x.setAttribute('aria-selected', x === b ? 'true' : 'false');
        });
      });
    }

    // Apply Style to All button
    var btnApply = document.getElementById('btnApplyStyle');
    if (btnApply) {
      btnApply.addEventListener('click', function () {
        // Read checkbox states
        var opts = {
          scope: stScope,
          copyText:      !!(document.getElementById('stCopyText') || {}).checked,
          copyAnimators: !!(document.getElementById('stCopyAnimators') || {}).checked,
          copyEffects:   !!(document.getElementById('stCopyEffects') || {}).checked,
          copyTransform: !!(document.getElementById('stCopyTransform') || {}).checked
        };

        // At least one option must be checked
        if (!opts.copyText && !opts.copyAnimators && !opts.copyEffects && !opts.copyTransform) {
          showToast('error', 'Nothing to copy', 'Check at least one styling option.');
          return;
        }

        // Disable button + show spinner while working
        var spanEl = btnApply.querySelector('span');
        var svgEl  = btnApply.querySelector('svg');
        var origLabel = spanEl ? spanEl.textContent : '';
        btnApply.disabled = true;
        if (svgEl) svgEl.style.display = 'none';
        if (spanEl) spanEl.textContent = 'Applying…';

        // Build the escaped JSON string for evalScript
        var optsStr = JSON.stringify(opts).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        csInterface.evalScript("applyStyleToAll('" + optsStr + "')", function (raw) {
          // Restore button
          btnApply.disabled = false;
          if (svgEl) svgEl.style.display = '';
          if (spanEl) spanEl.textContent = origLabel;

          // Handle response
          if (!raw || raw === 'EvalScript error.' || raw === 'undefined') {
            showToast('error', 'Style transfer failed', 'ExtendScript did not respond.');
            return;
          }

          try {
            var res = JSON.parse(raw);
            if (res.status === 'success') {
              showToast('success', res.message);
            } else {
              showToast('error', 'Style transfer failed', res.message || 'Unknown error.');
            }
          } catch (parseErr) {
            showToast('error', 'Unexpected response', String(raw).substring(0, 80));
          }
        });
      });
    }

    // Fix / Reveal Invisible Captions button
    var btnFix = document.getElementById('btnFixCaptions');
    if (btnFix) {
      btnFix.addEventListener('click', function () {
        btnFix.disabled = true;
        var origText = btnFix.querySelector('span') ? btnFix.querySelector('span').textContent : '';
        if (btnFix.querySelector('span')) btnFix.querySelector('span').textContent = 'Fixing…';
        csInterface.evalScript('fixInvisibleCaptions()', function (raw) {
          btnFix.disabled = false;
          if (btnFix.querySelector('span')) btnFix.querySelector('span').textContent = origText;
          if (!raw || raw === 'EvalScript error.' || raw === 'undefined') {
            showToast('error', 'Fix failed', 'ExtendScript did not respond.');
            return;
          }
          try {
            var res = JSON.parse(raw);
            if (res.status === 'success') {
              showToast('success', res.message);
            } else {
              showToast('error', 'Fix failed', res.message || 'Unknown error.');
            }
          } catch (pe) {
            showToast('error', 'Response error', String(raw).substring(0, 80));
          }
        });
      });
    }
  })();

  // Footer "GitHub" in the default browser
  document.getElementById('igLink').addEventListener('click', function (e) {
    e.preventDefault();
    try { csInterface.openURLInDefaultBrowser(GITHUB_URL); }
    catch (err) { try { window.open(GITHUB_URL); } catch (e2) {} }
  });

  // One open menu at a time — clicking elsewhere closes it.
  document.addEventListener('mousedown', function (e) {
    var inField = e.target && e.target.closest && e.target.closest('.ddwrap');
    document.querySelectorAll('.dd-menu.open').forEach(function (m) {
      if (!inField || !inField.contains(m)) {
        m.classList.remove('open');
        var trg = m.parentNode && m.parentNode.querySelector('[aria-expanded]');
        if (trg) trg.setAttribute('aria-expanded', 'false');
      }
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════
   MARKUP HELPERS
   All markup passed through here is trusted, locally-defined template
   strings (inline SVG icons / bundled preview tags) — never user or
   network content. Parsed via DOMParser and appended as nodes.
═══════════════════════════════════════════════════════════════════ */
function _markupNodes(markup) {
  var doc = new DOMParser().parseFromString('<div>' + markup + '</div>', 'text/html');
  return doc.body.firstChild ? Array.prototype.slice.call(doc.body.firstChild.childNodes) : [];
}
function _setMarkup(el, markup) {
  while (el.firstChild) el.removeChild(el.firstChild);
  _markupNodes(markup).forEach(function (n) { el.appendChild(n); });
}

/* ═══════════════════════════════════════════════════════════════════
   GUIDED FLOW — steps, dashes, nav
═══════════════════════════════════════════════════════════════════ */
var _curStep = 0;

function goToStep(n) {
  var stepEls = document.querySelectorAll('#steps .step');
  stepEls.forEach(function (s) {
    var i = parseInt(s.dataset.step, 10);
    s.classList.toggle('on', i === n);
    s.classList.toggle('back', i < n);
  });
  document.querySelectorAll('#dashes i').forEach(function (d, i) {
    d.className = i < n ? 'past' : i === n ? 'now' : '';
  });
  document.getElementById('backBtn').classList.toggle('hidden', n === 0);
  document.getElementById('skipBtn').classList.toggle('hidden', n >= 2);
  if (n === 2) moveSegThumb();
  _curStep = n;
}

/* Regenerate · start over (step 5) — resets transient state, back to step 0 */
function restartFlow() {
  state.hasGenerated = false;
  isEditing = false;
  document.getElementById('btnRegen').style.display = 'none';
  var editBtn = document.getElementById('btnEdit');
  editBtn.setAttribute('aria-pressed', 'false');
  var editLb = editBtn.querySelector('span');
  if (editLb) editLb.textContent = 'Edit';
  setGeneratingUI(false);
  goToStep(0);
}

/* ═══════════════════════════════════════════════════════════════════
   FLOW ROWS — language / mode / animation options (steps 0–2)
═══════════════════════════════════════════════════════════════════ */
/* Build one design row: [tile] name/desc [go]. */
function _flowRow(tileMarkup, nm, ds) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'row';

  var tile = document.createElement('span');
  tile.className = 'tile';
  _setMarkup(tile, tileMarkup);

  var meta = document.createElement('span');
  meta.className = 'rmeta';
  var nmEl = document.createElement('span');
  nmEl.className = 'nm';
  nmEl.textContent = nm;
  var dsEl = document.createElement('span');
  dsEl.className = 'ds';
  dsEl.textContent = ds;
  meta.appendChild(nmEl);
  meta.appendChild(dsEl);

  var go = document.createElement('span');
  go.className = 'go';
  _setMarkup(go, IC.arrow);

  btn.appendChild(tile);
  btn.appendChild(meta);
  btn.appendChild(go);
  return btn;
}

/* Mark the selected row in a container (check on selected, arrow on rest) */
function _markSelected(container, selectedBtn) {
  container.querySelectorAll('.row').forEach(function (r) {
    var is = r === selectedBtn;
    r.classList.toggle('sel', is);
    var go = r.querySelector('.go');
    if (go) _setMarkup(go, is ? IC.check : IC.arrow);
  });
}

function buildFlowRows() {
  // ── Step 0: language dropdown (flag + name, all languages) ──
  initLangDropdown();

  // ── Step 0: caption modes (shares the step with language — no
  //    auto-advance so both choices can be made before Next) ──
  var modeRows = document.getElementById('modeRows');
  MODES.forEach(function (m) {
    var btn = _flowRow(MODE_ICONS[m.id], m.nm, m.ds);
    btn.setAttribute('data-mode', m.id);
    btn.addEventListener('click', function () {
      state.captionMode = m.id;
      _updatePhraseCtl();
      _markSelected(modeRows, btn);
    });
    modeRows.appendChild(btn);
    if (m.id === state.captionMode) _markSelected(modeRows, btn);
  });

  // ── Step 1: animation styles (After Effects) — picking one advances ──
  var animRows = document.getElementById('animRows');
  // Wider tiles once real previews are in play — a 300×80 caption loop needs
  // the room, and the class keeps every row in the list the same shape.
  if (_anyStylePreviews()) animRows.classList.add('previews');
  var lastGrp = '';
  ANIMS.forEach(function (a) {
    if (a.grp && a.grp !== lastGrp) {
      var lab = document.createElement('div');
      lab.className = 'grouplabel';
      lab.textContent = a.grp;
      animRows.appendChild(lab);
      lastGrp = a.grp;
    }
    var btn = _flowRow(_animTile(a), a.nm, a.ds);
    btn.setAttribute('data-anim', a.id);
    btn.addEventListener('click', function () {
      state.style.animation = a.id;
      state.style.ffxPath = '';
      state.style.ffxName = '';
      _markSelected(animRows, btn);
      _updateStyleCtls();
      setTimeout(function () { goToStep(2); }, 240);
    });
    animRows.appendChild(btn);
    if (a.id === state.style.animation) _markSelected(animRows, btn);
  });
}

/* Language dropdown (step 0): flag + name options for every supported
   language, writing through to the hidden #sourceLanguage select. */
function initLangDropdown() {
  var trigger = document.getElementById('langTrigger');
  var menu = document.getElementById('langMenu');
  var flagEl = document.getElementById('langFlag');
  var labEl = document.getElementById('langLab');
  var langSel = document.getElementById('sourceLanguage');
  if (!trigger || !menu) return;

  function paintSelected() {
    menu.querySelectorAll('.dd-opt').forEach(function (o) {
      o.setAttribute('aria-selected', o.getAttribute('data-lang') === langSel.value ? 'true' : 'false');
    });
  }

  // The hidden <select> is the value store the generation pipeline reads. Build
  // its options from LANGS so a language can never be offered in the menu
  // without a matching option — setting .value to a missing option silently
  // leaves it empty, which used to mean transcribing in the wrong language.
  while (langSel.firstChild) langSel.removeChild(langSel.firstChild);
  LANGS.forEach(function (l) {
    var opt = document.createElement('option');
    opt.value = l[0];
    opt.textContent = l[1];
    langSel.appendChild(opt);
  });

  // A <select> defaults to its first option, which is now an auto-detect scope.
  // Pin the default explicitly and paint the trigger from the same entry, so the
  // button and the stored value always agree.
  var def = null;
  for (var d = 0; d < LANGS.length; d++) if (LANGS[d][0] === DEFAULT_LANG) { def = LANGS[d]; break; }
  if (!def) def = LANGS[0];
  langSel.value = def[0];
  state.language = def[1];
  if (flagEl) flagEl.textContent = def[3] || '🌐';
  if (labEl)  labEl.textContent  = def[1];

  LANGS.forEach(function (l) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-opt';
    btn.setAttribute('data-lang', l[0]);

    var fl = document.createElement('span');
    fl.className = 'flag';
    fl.textContent = l[3] || '🌐';
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = l[1];
    var sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = l[2];
    var chk = document.createElement('span');
    chk.className = 'ck-check';
    _setMarkup(chk, IC.check);

    btn.appendChild(fl);
    btn.appendChild(nm);
    btn.appendChild(sub);
    btn.appendChild(chk);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      state.language = l[1];
      langSel.value = l[0];
      langSel.dispatchEvent(new Event('change'));
      flagEl.textContent = l[3] || '🌐';
      labEl.textContent = l[1];
      paintSelected();
      menu.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    });
    menu.appendChild(btn);
  });

  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    var isOpen = menu.classList.contains('open');
    document.querySelectorAll('.dd-menu.open').forEach(function (m) {
      m.classList.remove('open');
      var t = m.parentNode && m.parentNode.querySelector('[aria-expanded]');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
    if (!isOpen) { menu.classList.add('open'); trigger.setAttribute('aria-expanded', 'true'); }
  });

  paintSelected();
}

/* ═══════════════════════════════════════════════════════════════════
   STYLE PREVIEWS
   Each built-in style ships a pre-rendered animated WebP loop
   (assets/style-previews/<id>.webp, 300×80 · 15fps · 2s) so the picker
   shows the actual caption animation instead of a CSS approximation of it.
   Bundled .ffx presets can bring their own preview the same way, as
   presets/<name>.webp — same convention the MOGRT tiles already use.

   The folder is read once at startup. When it's missing — or when Node isn't
   available at all, as in a browser preview — the map stays empty and every
   tile falls back to the CSS animation it used before.
═══════════════════════════════════════════════════════════════════ */
var _stylePreviews = {};        // style id → src, relative to the panel root

function loadStylePreviews() {
  var fs, path;
  try { fs = require('fs'); path = require('path'); } catch (e) { return; }

  var dir = '';
  try {
    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    if (extRoot) dir = path.join(extRoot, 'assets', 'style-previews');
  } catch (e) { }
  if (!dir) return;

  var files = [];
  try { files = fs.readdirSync(dir).filter(function (f) { return /\.webp$/i.test(f); }); }
  catch (e) { return; }

  files.forEach(function (f) {
    _stylePreviews[f.replace(/\.webp$/i, '')] = 'assets/style-previews/' + f;
  });
}

/* True once at least one row in the style list carries a real preview — the
   list then switches to the wider tile so every row stays aligned. */
function _anyStylePreviews() {
  for (var k in _stylePreviews) { if (_stylePreviews.hasOwnProperty(k)) return true; }
  return false;
}

/* Preview tile markup for an animation style. A pre-rendered WebP wins; the
   CSS tiles below are the fallback. Word Fade gets two parts so the CSS can
   stagger their fade-in (reads as word-by-word at a glance). */
function _animTile(a) {
  if (a && _stylePreviews[a.id]) {
    return '<img src="' + encodeURI(_stylePreviews[a.id]) + '" alt="">';
  }
  if (a && a.id === 'wordfade') return '<span class="aa aa-wordfade"><i>A</i><i>a</i></span>';
  if (a && a.id === 'emphasis') return '<span class="aa aa-emphasis"><i>so</i><b>big</b></span>';
  if (a && a.id === 'fontpair') return '<span class="aa aa-fontpair"><i>Aa</i><b>Aa</b></span>';
  if (a && a.id === 'shuffle')  return '<span class="aa aa-shuffle"><i>A</i><i>a</i></span>';
  return '<span class="aa ' + ((a && a.cls) ? a.cls : 'aa-none') + '">Aa</span>';
}

/* Words-per-caption slider visibility (phrase mode only) */
function _updatePhraseCtl() {
  var ctl = document.getElementById('phraseSizeControl');
  if (ctl) ctl.classList.toggle('visible', state.captionMode === 'phrase');
}

/* ═══════════════════════════════════════════════════════════════════
   CUSTOMIZE CONTROLS (step 3)
═══════════════════════════════════════════════════════════════════ */
function initPosSeg() {
  var seg = document.getElementById('posSeg');
  if (!seg) return;
  seg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.style.position = b.dataset.pos;
    seg.querySelectorAll('button').forEach(function (x) {
      x.setAttribute('aria-selected', x === b ? 'true' : 'false');
    });
  });
}

/* Animation speed segmented (step 1 · Customize): scales how quickly the
   word-by-word styles reveal each word. */
function initSpeedSeg() {
  var seg = document.getElementById('speedSeg');
  if (!seg) return;
  seg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.style.animSpeed = parseFloat(b.dataset.speed) || 1;
    seg.querySelectorAll('button').forEach(function (x) {
      x.setAttribute('aria-selected', x === b ? 'true' : 'false');
    });
  });
}

/* Auto-emoji segmented (step 1 · Customize): when On, the LLM picks one emoji
   per caption at placement time and the renderer prepends it. Off by default —
   emoji are a look, not a default. */
function initEmojiSeg() {
  var seg = document.getElementById('emojiSeg');
  if (!seg) return;
  seg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.style.emojiOn = b.dataset.emoji === '1';
    // Re-picking the toggle should re-ask the LLM on the next placement.
    state._emojiDone = false;
    seg.querySelectorAll('button').forEach(function (x) {
      x.setAttribute('aria-selected', x === b ? 'true' : 'false');
    });
  });
}

/* Outline segmented (Off / Thin / Bold). An outline is the single biggest
   legibility win over busy footage, so it's a first-class control rather than
   something buried in a style. */
function initStrokeSeg() {
  var seg = document.getElementById('strokeSeg');
  if (!seg) return;
  seg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var v = b.dataset.stroke;
    state.style.strokeOn = (v !== 'off');
    if (state.style.strokeOn) state.style.strokeWeight = v;
    seg.querySelectorAll('button').forEach(function (x) {
      x.setAttribute('aria-selected', x === b ? 'true' : 'false');
    });
  });
}

/* Show only the controls the selected style actually uses, so Customize stays
   short instead of listing every knob the renderer has. */
var HIGHLIGHT_STYLES = { karaoke: 1, hormozi: 1 };

function _updateStyleCtls() {
  var anim = state.style.animation;

  var pair = document.getElementById('pairCtls');
  if (pair) pair.classList.toggle('visible', anim === 'fontpair');

  // Active-word colour: only the styles that tint one word at a time.
  var hl = document.getElementById('highlightCtl');
  if (hl) hl.classList.toggle('visible', !!HIGHLIGHT_STYLES[anim]);

  // Gaming owns its outline (it IS the look), so the manual control steps
  // aside and the renderer supplies the weight.
  var stroke = document.getElementById('strokeCtl');
  if (stroke) stroke.classList.toggle('visible', anim !== 'gaming');
  var strokeNote = document.getElementById('strokeAuto');
  if (strokeNote) strokeNote.hidden = anim !== 'gaming';
}

/* Pair-font dropdown (Font Pair intro line). Options are filled by
   _renderFontList() once the system fonts are scanned; this wires the
   trigger + search. */
function initPairFontPicker() {
  var trigger = document.getElementById('pairFontTrigger');
  var menu    = document.getElementById('pairFontMenu');
  var search  = document.getElementById('pairFontSearch');
  if (!trigger || !menu) return;

  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    var isOpen = menu.classList.contains('open');
    document.querySelectorAll('.dd-menu.open').forEach(function (m) {
      m.classList.remove('open');
      var t = m.parentNode && m.parentNode.querySelector('[aria-expanded]');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
    if (!isOpen) {
      menu.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      if (search) { search.value = ''; _filterList('pairFontList', ''); setTimeout(function () { search.focus(); }, 0); }
    }
  });
  if (search) {
    search.addEventListener('click', function (e) { e.stopPropagation(); });
    search.addEventListener('input', function () { _filterList('pairFontList', search.value); });
  }
}

/* Generic search filter for a font option list. */
function _filterList(listId, q) {
  q = (q || '').trim().toLowerCase();
  var list = document.getElementById(listId);
  if (!list) return;
  list.querySelectorAll('.dd-opt').forEach(function (o) {
    // Pinned rows stay reachable whatever the query — the font picker's
    // "Default" and the translate list's "Original language" are the escape
    // hatches, so hiding them behind a search term would be hostile.
    if (o.hasAttribute('data-pin')) { o.style.display = ''; return; }
    var hay = o.getAttribute('data-search') || (o.textContent || '').toLowerCase();
    o.style.display = (!q || hay.indexOf(q) >= 0) ? '' : 'none';
  });
}

/* ═══════════════════════════════════════════════════════════════════
   FONT PAIRINGS
   Picking two fonts that work together is the hard part of the Font Pair
   look, so these are ready-made: one sets the small intro line and the big
   payoff line together.

   Each slot is a list of CANDIDATE [family, style] pairs, tried in order
   against the fonts actually installed on this machine — no pairing is ever
   offered unless BOTH of its faces resolve here, so nothing silently falls
   back to a face the user doesn't have. Candidates run macOS-first then the
   Windows equivalent, which is why most slots list several.
═══════════════════════════════════════════════════════════════════ */
var FONT_PAIRINGS = [
  {
    name: 'Editorial',
    hint: 'serif intro · grotesk payoff',
    intro: [['Georgia', 'Italic'], ['Times New Roman', 'Italic'], ['Palatino', 'Italic']],
    main:  [['Helvetica Neue', 'Bold'], ['Helvetica', 'Bold'], ['Arial', 'Bold'], ['Segoe UI', 'Bold']]
  },
  {
    name: 'Impact',
    hint: 'quiet intro · heavy payoff',
    intro: [['Helvetica Neue', 'Light'], ['Helvetica', 'Regular'], ['Segoe UI', 'Light'], ['Arial', 'Regular']],
    main:  [['Impact', 'Regular'], ['Arial Black', 'Regular'], ['Haettenschweiler', 'Regular']]
  },
  {
    name: 'Geometric',
    hint: 'clean intro · rounded payoff',
    intro: [['Avenir Next', 'Regular'], ['Futura', 'Medium'], ['Century Gothic', 'Regular'], ['Segoe UI', 'Regular']],
    main:  [['Avenir Next', 'Bold'], ['Futura', 'Bold'], ['Century Gothic', 'Bold'], ['Segoe UI', 'Bold']]
  },
  {
    name: 'Classic Serif',
    hint: 'italic intro · serif payoff',
    intro: [['Baskerville', 'Italic'], ['Georgia', 'Italic'], ['Garamond', 'Italic'], ['Cambria', 'Italic']],
    main:  [['Baskerville', 'Bold'], ['Georgia', 'Bold'], ['Cambria', 'Bold']]
  },
  {
    name: 'Technical',
    hint: 'mono intro · grotesk payoff',
    intro: [['Menlo', 'Regular'], ['Consolas', 'Regular'], ['Courier New', 'Bold'], ['Monaco', 'Regular']],
    main:  [['Helvetica Neue', 'Bold'], ['Arial', 'Bold'], ['Segoe UI', 'Bold']]
  },
  {
    name: 'Elegant',
    hint: 'high-contrast intro · light payoff',
    intro: [['Didot', 'Italic'], ['Bodoni 72', 'Italic'], ['Georgia', 'Italic']],
    main:  [['Optima', 'Regular'], ['Gill Sans', 'Regular'], ['Gill Sans MT', 'Regular'], ['Palatino', 'Regular']]
  }
];

/* Find an installed face for a [family, style] candidate list. Style match is
   loose ("Bold" also matches "Bold Italic"-free variants like "Heavy") only in
   the sense that Regular is accepted as a fallback within the same family —
   never across families, which would defeat the point of the pairing. */
function _resolveFace(candidates) {
  if (!_fonts || _fonts.length === 0) return null;

  for (var i = 0; i < candidates.length; i++) {
    var wantFam = candidates[i][0].toLowerCase();
    var wantSt  = candidates[i][1].toLowerCase();
    var famHit  = null;

    for (var j = 0; j < _fonts.length; j++) {
      var f = _fonts[j];
      var fam = String(f.fam || '').toLowerCase();
      if (fam !== wantFam) continue;
      var st = String(f.st || '').toLowerCase() || 'regular';
      if (st === wantSt) return f;                    // exact family + style
      if (!famHit && st === 'regular') famHit = f;    // same family, plainer face
    }
    if (famHit) return famHit;
  }
  return null;
}

/* Pairings whose BOTH faces exist on this machine, resolved once. */
function _availablePairings() {
  var out = [];
  FONT_PAIRINGS.forEach(function (p) {
    var intro = _resolveFace(p.intro);
    var main  = _resolveFace(p.main);
    if (intro && main) out.push({ name: p.name, hint: p.hint, intro: intro, main: main });
  });
  return out;
}

/* Build the "Pairing" row of chips inside the Font Pair controls. Picking one
   sets BOTH fonts at once and updates the two font pickers to match, so the
   manual controls stay the source of truth and can be tweaked afterwards. */
function buildPairingChips() {
  var wrap = document.getElementById('pairingChips');
  var row  = document.getElementById('pairingRow');
  if (!wrap) return;
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

  var pairings = _availablePairings();
  if (pairings.length === 0) {
    if (row) row.hidden = true;   // no complete pairing installed — manual only
    return;
  }
  if (row) row.hidden = false;

  pairings.forEach(function (p) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('data-pairing', p.name);
    b.title = p.hint + ' — ' + p.intro.fam + ' + ' + p.main.fam;

    var nm = document.createElement('span');
    nm.className = 'chip-nm';
    nm.textContent = p.name;
    // Preview each chip in its own payoff face.
    if (p.main.fam) nm.style.fontFamily = '"' + p.main.fam + '"';
    b.appendChild(nm);

    b.addEventListener('click', function () {
      _selectPairFont(p.intro);   // small intro line
      _selectFont(p.main);        // big payoff line
      wrap.querySelectorAll('.chip').forEach(function (c) {
        c.setAttribute('aria-selected', c === b ? 'true' : 'false');
      });
    });
    wrap.appendChild(b);
  });
}

function _selectPairFont(f) {
  state.style.pairFont       = f.ps || '';
  state.style.pairFontFamily = f.fam || '';
  state.style.pairFontStyle  = f.st || '';
  var lab = document.getElementById('pairFontLab');
  if (lab) {
    var hasStyle = f.st && f.st.toLowerCase() !== 'regular';
    lab.textContent = f.ps ? (f.fam + (hasStyle ? ' ' + f.st : '')) : 'Georgia Italic';
    lab.style.fontFamily = (f.ps && f.fam) ? '"' + f.fam + '"' : '';
  }
  var list = document.getElementById('pairFontList');
  if (list) {
    list.querySelectorAll('.dd-opt').forEach(function (o) {
      o.setAttribute('aria-selected', (o.getAttribute('data-ps') === (f.ps || '')) ? 'true' : 'false');
    });
  }
  var menu = document.getElementById('pairFontMenu');
  var trigger = document.getElementById('pairFontTrigger');
  if (menu) menu.classList.remove('open');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

/* Text color: CEP's embedded Chromium has no native colour dialog, so the
   swatch opens an in-panel preset popover; the hex field takes any custom
   colour. */
var COLOR_PRESETS = ['#FFFFFF', '#000000', '#FFE600', '#3FD98B', '#FF5A52', '#3B82F6',
  '#F5A623', '#FF7AC6', '#9B7BFF', '#00D2FF', '#B2B2B2', '#0A0A0B'];

/* One colour control: the swatch opens a preset popover, the hex field takes
   any custom value. Every colour in Customize uses this — they differ only in
   which state.style key they write, so one implementation serves all four
   (text, outline, active word, and the Font Pair intro line). */
function _initColorPicker(opts) {
  var sw   = document.getElementById(opts.swatch);
  var hex  = document.getElementById(opts.input);
  var pop  = document.getElementById(opts.pop);
  var grid = document.getElementById(opts.grid);
  if (!sw || !hex || !pop || !grid) return;

  var key = opts.key;

  function paintSelected() {
    grid.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-selected',
        b.getAttribute('data-c') === state.style[key] ? 'true' : 'false');
    });
  }

  function setColor(c) {
    state.style[key] = c.toUpperCase();
    sw.style.background = state.style[key];
    hex.value = state.style[key];
    paintSelected();
  }

  COLOR_PRESETS.forEach(function (c) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('data-c', c);
    b.style.background = c;
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      setColor(c);
      pop.classList.remove('open');
    });
    grid.appendChild(b);
  });

  sw.addEventListener('click', function (e) {
    e.stopPropagation();
    pop.classList.toggle('open');
  });
  // Clicking anywhere outside this field closes its popover.
  document.addEventListener('mousedown', function (e) {
    if (!e.target.closest || !e.target.closest('#' + opts.field)) pop.classList.remove('open');
  });

  hex.addEventListener('input', function () {
    var v = hex.value.trim();
    if (v && v.charAt(0) !== '#') v = '#' + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      state.style[key] = v.toUpperCase();
      sw.style.background = v;
      paintSelected();
    }
  });
  hex.addEventListener('blur', function () {
    if (/^#[0-9a-fA-F]{6}$/.test(hex.value.trim())) setColor(hex.value.trim());
    else setColor(state.style[key]);   // revert invalid input
  });

  setColor(state.style[key] || opts.fallback);
}

function initColorControls() {
  _initColorPicker({ field: 'colorField',       swatch: 'swFill',       input: 'hexIn',
                     pop: 'cpPop',              grid: 'cpSwatches',
                     key: 'textColor',           fallback: '#FFFFFF' });
  _initColorPicker({ field: 'strokeColorField', swatch: 'strokeSwFill', input: 'strokeHexIn',
                     pop: 'strokeCpPop',        grid: 'strokeCpSwatches',
                     key: 'strokeColor',         fallback: '#000000' });
  _initColorPicker({ field: 'hlColorField',     swatch: 'hlSwFill',     input: 'hlHexIn',
                     pop: 'hlCpPop',            grid: 'hlCpSwatches',
                     key: 'highlightColor',      fallback: '#FFE000' });
  _initColorPicker({ field: 'pairColorField',   swatch: 'pairSwFill',   input: 'pairHexIn',
                     pop: 'pairCpPop',          grid: 'pairCpSwatches',
                     key: 'pairColor',           fallback: '#FFFFFF' });
}

/* Words-per-caption slider (step 1, phrase mode only) — 1 to 4 words */
function initPhraseSlider() {
  var input = document.getElementById('phraseSize');
  var val = document.getElementById('phraseSizeVal');
  if (!input) return;
  function set(n) {
    state.phraseSize = Math.min(4, Math.max(1, n | 0));
    input.value = state.phraseSize;
    if (val) val.textContent = state.phraseSize;
  }
  input.addEventListener('input', function () { set(parseInt(input.value, 10)); });
  set(state.phraseSize);
  _updatePhraseCtl();
}

/* ── Apply-To segmented thumb ────────────────────────────────────── */
function moveSegThumb() {
  var seg = document.getElementById('scopeSeg');
  var thumb = document.getElementById('segThumb');
  if (!seg || !thumb) return;
  var idx = (state.scope === 'sequence') ? 1 : 0;
  var w = (seg.clientWidth - 6) / 2;
  thumb.style.width = w + 'px';
  thumb.style.transform = 'translateX(' + (idx * w) + 'px)';
}


/* ═══════════════════════════════════════════════════════════════════
   FONT-SIZE STEPPER
   ±2 buttons, direct numeric typing, ↑/↓ keys; clamps 8–400.
═══════════════════════════════════════════════════════════════════ */
function initStepper() {
  var input = document.getElementById('fontSize');
  if (!input) return;

  function setSize(v) {
    v = Math.min(400, Math.max(8, v | 0));
    state.style.fontSize = v;
    input.value = v;
  }

  document.getElementById('szUp').addEventListener('click', function () {
    setSize((state.style.fontSize || 60) + 2);
  });
  document.getElementById('szDn').addEventListener('click', function () {
    setSize((state.style.fontSize || 60) - 2);
  });

  input.addEventListener('input', function () {
    var n = parseInt(input.value.replace(/\D/g, ''), 10);
    if (!isNaN(n)) state.style.fontSize = n;   // commit raw while typing; clamp on blur
  });
  input.addEventListener('blur', function () { setSize(parseInt(input.value, 10) || 60); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowUp') { e.preventDefault(); setSize((state.style.fontSize || 60) + 2); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSize((state.style.fontSize || 60) - 2); }
    else if (e.key === 'Enter') { input.blur(); }
  });
}



/* ═══════════════════════════════════════════════════════════════════
   FONT PICKER (After Effects) — searchable list of installed fonts.
   Fonts come from the host via getSystemFonts(); each option previews in
   its own typeface. Selecting one stores the PostScript name (style.font)
   used to set the AE text layer's font exactly.
═══════════════════════════════════════════════════════════════════ */
var _fonts = [];

function initFontPicker() {
  var trigger = document.getElementById('fontTrigger');
  var menu    = document.getElementById('fontMenu');
  var search  = document.getElementById('fontSearch');
  if (!trigger || !menu) return;

  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    var isOpen = menu.classList.contains('open');
    document.querySelectorAll('.dd-menu.open').forEach(function (m) {
      m.classList.remove('open');
      var t = m.parentNode && m.parentNode.querySelector('[aria-expanded]');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
    if (!isOpen) {
      menu.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      if (search) { search.value = ''; _filterFonts(''); setTimeout(function () { search.focus(); }, 0); }
    }
  });

  if (search) {
    search.addEventListener('click', function (e) { e.stopPropagation(); });
    search.addEventListener('input', function () { _filterFonts(search.value); });
  }
}

// Build the font list. Primary source is the Node font scanner (reads the OS
// font folders directly — works on every AE version). If that yields nothing,
// fall back to AE's app.fonts API (2022+) via the host.
function loadSystemFonts() {
  var fromNode = [];
  try { if (typeof FontScanner !== 'undefined') fromNode = FontScanner.list() || []; } catch (e) {}

  if (fromNode.length) {
    _fonts = fromNode;
    _renderFontList(false);
    buildPairingChips();
    return;
  }

  // Fallback: AE app.fonts (After Effects 2022+)
  try {
    csInterface.evalScript('getSystemFonts()', function (raw) {
      var res = null;
      try { res = JSON.parse(raw); } catch (e) {}
      _fonts = (res && res.fonts) ? res.fonts : [];
      _renderFontList(_fonts.length === 0);
      buildPairingChips();
    });
  } catch (e) { _renderFontList(true); }
}

function _renderFontList(unsupported) {
  var list = document.getElementById('fontList');
  if (!list) return;
  list.innerHTML = '';

  // "Default" → leave the composition / AE default font untouched.
  list.appendChild(_fontOption({ ps: '', fam: 'Default', st: '' }, true));

  if (unsupported && _fonts.length === 0) {
    var note = document.createElement('div');
    note.className = 'ck-fontempty';
    note.textContent = 'Font list needs After Effects 2022 or newer — using the composition font.';
    list.appendChild(note);
    return;
  }
  for (var i = 0; i < _fonts.length; i++) list.appendChild(_fontOption(_fonts[i], false));
  _markSelectedFont();

  // Mirror the same options into the Font Pair intro-line picker; its
  // "default" entry is the built-in Georgia Italic pairing.
  var pairList = document.getElementById('pairFontList');
  if (pairList) {
    while (pairList.firstChild) pairList.removeChild(pairList.firstChild);
    pairList.appendChild(_fontOption({ ps: '', fam: 'Georgia Italic (default)', st: '' }, true, _selectPairFont));
    for (var k = 0; k < _fonts.length; k++) pairList.appendChild(_fontOption(_fonts[k], false, _selectPairFont));
  }
}

function _fontOption(f, isDefault, onPick) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-opt';
  btn.setAttribute('data-ps', f.ps);
  btn.setAttribute('data-search', (f.fam + ' ' + f.st).toLowerCase());
  if (isDefault) btn.setAttribute('data-pin', '1');   // never filtered out

  var nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = f.fam;
  if (!isDefault && f.fam) nm.style.fontFamily = '"' + f.fam + '"';   // preview in its own face
  btn.appendChild(nm);

  if (f.st && f.st.toLowerCase() !== 'regular') {
    var sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = f.st;
    btn.appendChild(sub);
  }

  var chk = document.createElement('span');
  chk.className = 'ck-check';
  chk.innerHTML = CHECK_SVG;
  btn.appendChild(chk);

  btn.addEventListener('click', function (e) { e.stopPropagation(); (onPick || _selectFont)(f); });
  return btn;
}

function _selectFont(f) {
  state.style.font       = f.ps || '';
  state.style.fontFamily = f.fam || '';
  state.style.fontStyle  = f.st || '';
  var lab = document.getElementById('fontLab');
  if (lab) {
    var hasStyle = f.st && f.st.toLowerCase() !== 'regular';
    lab.textContent = f.ps ? (f.fam + (hasStyle ? ' ' + f.st : '')) : 'Default';
    lab.style.fontFamily = (f.ps && f.fam) ? '"' + f.fam + '"' : '';
  }
  _markSelectedFont();
  var menu = document.getElementById('fontMenu');
  var trigger = document.getElementById('fontTrigger');
  if (menu) menu.classList.remove('open');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function _markSelectedFont() {
  var list = document.getElementById('fontList');
  if (!list) return;
  var cur = state.style.font || '';
  list.querySelectorAll('.dd-opt').forEach(function (o) {
    o.setAttribute('aria-selected', (o.getAttribute('data-ps') === cur) ? 'true' : 'false');
  });
}

function _filterFonts(q) {
  q = (q || '').trim().toLowerCase();
  var list = document.getElementById('fontList');
  if (!list) return;
  list.querySelectorAll('.dd-opt').forEach(function (o) {
    var ps = o.getAttribute('data-ps');
    var hay = o.getAttribute('data-search') || '';
    // Always keep the "Default" entry (empty ps) visible.
    o.style.display = (!ps || !q || hay.indexOf(q) >= 0) ? '' : 'none';
  });
}

/* ═══════════════════════════════════════════════════════════════════
   GENERATION FLOW
   Step 1 → getClipInfo (ExtendScript)
   Step 2 → extractAudioToFile (ffmpeg → temp WAV)
   Step 3 → PulseBatchAPI.transcribe (REST upload)
   Step 4 → finaliseTranscript (build + show captions)
═══════════════════════════════════════════════════════════════════ */
function startGeneration() {
  if (state.isGenerating) return;

  // Cancel and clean up any previous run
  batchAPI.cancel();
  audioProcessor.cancel();
  cleanupTempAudio();

  state.isGenerating = true;
  state.words = [];
  state.captions = [];
  state._emphasisSplitDone = false;
  state._emojiDone = false;
  state.emojiAssets = {};
  _seekWarned = false;
  _resetTranslation();   // a new transcript starts in its own language

  document.getElementById('btnAddToComp').disabled = true;

  setGeneratingUI(true);
  setStatus('busy', 'Getting clip info…');
  showProgress('Reading clip information…', 5);

  var selectedLang = document.getElementById('sourceLanguage').value;
  var isHinglish = selectedLang === 'hinglish';
  var language = isHinglish ? 'hi' : selectedLang;


  // ── Step 1: Get clip info ─────────────────────────────────────────
  csInterface.evalScript('getClipInfo("' + state.scope + '")', function (result) {
    console.log('[Main] getClipInfo raw result:', result);

    // Empty / "EvalScript error." / "undefined" means the ExtendScript didn't
    // run or returned nothing — a host-side load/runtime problem, NOT a missing
    // selection. Surface the raw value so we can see what the host returned.
    if (!result || result === 'EvalScript error.' || result === 'undefined') {
      showError('Host script did not respond (got: "' + (result || 'empty') +
        '"). In Premiere, make sure a sequence is open and a clip is selected, ' +
        'then try again.');
      return;
    }

    var clipInfo;
    try { clipInfo = JSON.parse(result); } catch (e) {
      showError('Unexpected clip-info response: ' + String(result).substring(0, 160));
      return;
    }
    if (clipInfo.error) { showError(clipInfo.error); return; }

    // ── Full sequence: clips array; Single clip: mediaPath ────────
    var isMultiClip = clipInfo.isFullSequence && Array.isArray(clipInfo.clips) && clipInfo.clips.length > 0;
    if (!isMultiClip && !clipInfo.mediaPath) {
      showError('Could not find media file for this clip.');
      return;
    }

    if (isMultiClip) {
      console.log('[Main] Full sequence:', clipInfo.clips.length, 'clips');
      clipInfo.clips.forEach(function (c, i) {
        console.log('  [' + i + ']', c.mediaPath, '| src', c.startTime + '–' + c.endTime + 's',
          '| timeline@' + c.timelineStart + 's');
      });
    } else {
      var duration = (clipInfo.endTime || 0) - (clipInfo.startTime || 0);
      console.log('[Main] Clip:', clipInfo.mediaPath,
        '| range:', clipInfo.startTime + '–' + clipInfo.endTime + 's',
        '| duration:', duration.toFixed(1) + 's');
    }

    setStatus('busy', 'Exporting audio…');
    showProgress('Exporting audio… (0%)', 8);

    // ── Step 2: Extract audio to temp WAV ──────────────────────────
    var os = require('os');
    var path = require('path');
    var tmpWav = path.join(os.homedir(), '.pulse_captions_temp.wav');
    state.tempAudioPath = tmpWav;

    var audioExtractProgress = function (pct) {
      if (!state.isGenerating) return;
      showProgress('Exporting audio… (' + pct + '%)', 8 + Math.round(pct * 0.25));
    };

    var audioExtractDone = function () {
      if (!state.isGenerating) return;
      var fs = require('fs');
      var sizeMB = (fs.statSync(tmpWav).size / 1024 / 1024).toFixed(1);
      console.log('[Main] WAV ready:', tmpWav, '(' + sizeMB + ' MB)');
      setStatus('busy', 'Transcribing…');
      showProgress('Preparing upload…', 34);

      // ── Step 3: Upload & transcribe ──────────────────────────
      batchAPI.transcribe(tmpWav, language, {

        onProgress: function (p) {
          if (!state.isGenerating) return;
          var mapped = 34 + Math.round((p.pct / 100) * 58);
          showProgress(p.label, mapped);
        },

        onFinal: function (result) {
          cleanupTempAudio();
          if (!state.isGenerating) return;

          var words = result.words;

          // For full-sequence multi-clip: remap STT timestamps back to
          // correct timeline positions, accounting for gaps between clips.
          if (isMultiClip && clipInfo.clips && clipInfo.clips.length > 0) {
            words = _adjustSequenceTimestamps(words, clipInfo.clips);
          }

          if (isHinglish) {
            setStatus('busy', 'Converting to Hinglish…');
            showProgress('Converting to Hinglish…', 93);
            var _llmSucceeded = false;
            LLMCleanup.clean(
              words,
              function (cleanedWords) {
                if (!state.isGenerating) return;
                if (_llmSucceeded) showToast('success', 'Hinglish cleanup done');
                else showToast('error', 'AI cleanup unavailable', 'Used phonetic transliteration instead.');
                finaliseTranscript(cleanedWords, clipInfo);
              },
              function (p) {
                if (!state.isGenerating) return;
                showProgress(p.label, 93 + Math.round(p.pct * 0.06));
                if (p.pct === 100) _llmSucceeded = true;
              },
              function (rawWords) {
                return rawWords.map(function (w) {
                  return { word: Transliterate.romanize(w.word), start: w.start, end: w.end };
                });
              }
            );
            return;
          }

          finaliseTranscript(words, clipInfo);
        },

        onError: function (msg) {
          cleanupTempAudio();
          showError(msg);
        }
      });
    };  // end audioExtractDone

    var audioExtractError = function (msg) {
      showError('Audio export failed: ' + msg);
    };

    // ── Dispatch: single clip vs multi-clip full sequence ─────────
    if (isMultiClip) {
      showProgress('Concatenating ' + clipInfo.clips.length + ' clips…', 8);
      audioProcessor.extractSequenceAudioToFile(
        clipInfo.clips, tmpWav, audioExtractProgress, audioExtractDone, audioExtractError
      );
    } else {
      audioProcessor.extractAudioToFile(
        clipInfo.mediaPath, clipInfo.startTime || 0, clipInfo.endTime || 0,
        tmpWav, audioExtractProgress, audioExtractDone, audioExtractError
      );
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════
   SEQUENCE TIMESTAMP REMAPPING
   After STT transcribes the concatenated audio, timestamps are
   relative to the stitched audio (0 = start of first clip).
   This maps them back to actual timeline positions, including any
   gaps between clips in the sequence.

   clips = [{mediaPath, startTime, endTime, timelineStart}, ...]
            sorted by timelineStart, same order as the concat.
═══════════════════════════════════════════════════════════════════ */
function _adjustSequenceTimestamps(words, clips) {
  if (!words || words.length === 0) return words;
  if (!clips || clips.length === 0) return words;

  // Build lookup table: for each clip, record its audio offset
  // (cumulative duration of all previous clips in the concat)
  var segments = [];
  var audioOffset = 0;
  clips.forEach(function (clip) {
    var dur = (clip.endTime || 0) - (clip.startTime || 0);
    if (dur < 0) dur = 0;
    segments.push({
      audioStart: audioOffset,          // when this clip starts in the concat audio
      audioEnd: audioOffset + dur,    // when it ends
      timelineStart: clip.timelineStart    // where it sits on the timeline
    });
    audioOffset += dur;
  });

  return words.map(function (w) {
    var audioMid = ((w.start || 0) + (w.end || 0)) / 2;

    // Find the segment that contains this word's midpoint
    var seg = segments[segments.length - 1]; // default: last segment
    for (var i = 0; i < segments.length; i++) {
      if (audioMid >= segments[i].audioStart && audioMid < segments[i].audioEnd) {
        seg = segments[i];
        break;
      }
    }

    // Timeline time = clip's timeline position + offset within that clip's audio
    var offsetInClip = Math.max(0, (w.start || 0) - seg.audioStart);
    var tlStart = seg.timelineStart + offsetInClip;
    var tlEnd = tlStart + Math.max(0, (w.end || 0) - (w.start || 0));

    return { word: w.word, start: tlStart, end: tlEnd };
  });
}

/* ═══════════════════════════════════════════════════════════════════
   FINALISE TRANSCRIPT
   Builds captions from word list and enables the UI.
═══════════════════════════════════════════════════════════════════ */
function finaliseTranscript(words, clipInfo) {
  if (!state.isGenerating) return;

  // Capture sequence dimensions + frame rate (PP only)
  if (clipInfo.seqWidth) state.seqWidth = clipInfo.seqWidth;
  if (clipInfo.seqHeight) state.seqHeight = clipInfo.seqHeight;

  state.words = words;
  var timeOffset = clipInfo.timelineStartTime || 0;

  // ── Smart mode: let the LLM decide line breaks (async, timing-safe) ──
  // Words keep their original timestamps; the model only returns groupings.
  if (state.captionMode === 'smart' && typeof AILineBreak !== 'undefined') {
    setStatus('busy', 'AI phrasing captions…');
    showProgress('AI phrasing captions…', 95);
    AILineBreak.group(
      words,
      function (groups, aiSucceeded) {
        if (!state.isGenerating) return;
        state.captions = buildCaptionsFromGroups(groups, timeOffset);
        if (aiSucceeded) showToast('success', 'AI line breaks applied');
        else showToast('error', 'AI unreachable', 'Used sentence-based line breaks instead.');
        _renderFinalCaptions(words, clipInfo);
      },
      function (p) {
        if (!state.isGenerating) return;
        showProgress(p.label, 95 + Math.round(p.pct * 0.04));
      }
    );
    return;
  }

  showProgress('Building captions…', 95);
  state.captions = groupWordsToCaptions(words, state.captionMode, state.phraseSize, timeOffset);
  _renderFinalCaptions(words, clipInfo);
}

/* Shared tail for finaliseTranscript: clamps captions to the timeline end,
   renders the transcript, and flips the UI back to its ready state. Runs after
   grouping completes — synchronously for word/phrase/sentence, or in the LLM
   callback for Smart mode. */
function _renderFinalCaptions(words, clipInfo) {
  state.isGenerating = false;

  // Clamp captions to the media/sequence end so the last word never lingers
  // past where the video ends. STT timestamps can slightly overrun the clip;
  // this drops captions that start after the end and trims any that overrun.
  var tlEnd = (typeof clipInfo.timelineEndTime === 'number') ? clipInfo.timelineEndTime : 0;
  if (tlEnd > 0) {
    state.captions = state.captions.filter(function (c) { return c.startTime < tlEnd; });
    state.captions.forEach(function (c) { if (c.endTime > tlEnd) c.endTime = tlEnd; });
  }

  // Render timed transcript lines (replaces the empty state)
  state.hasGenerated = true;
  isEditing = false;
  renderTranscriptWords(state.captions);

  hideProgress();
  setGeneratingUI(false);
  setStatus('ready', state.captions.length + ' captions ready · ' +
    words[words.length - 1].end.toFixed(1) + 's transcribed');
  setTranscriptStatus();

  document.getElementById('btnAddToComp').disabled = false;
  document.getElementById('btnRegen').style.display = 'none';

  // Make sure the final step is showing (it should already be)
  goToStep(2);

  console.log('[Main] Done.', words.length, 'words →', state.captions.length, 'captions.',
    'Last word ends at', words[words.length - 1].end.toFixed(2) + 's');
}

/* ═══════════════════════════════════════════════════════════════════
   CAPTION GROUPING
═══════════════════════════════════════════════════════════════════ */
/* Caption-timing knobs (seconds). STT word timestamps are tight and gappy;
   these turn raw [start,end] pairs into on-screen captions that don't flicker,
   don't cut off the trailing audio, and don't feel late.
     LEAD_IN      – show each caption slightly BEFORE the word starts (kills "delay")
     TAIL_PAD     – linger after the word ends so the last phoneme isn't clipped
     MAX_GAP_FILL – if the silence to the next caption is ≤ this, hold the current
                    one until the next begins (no blank frames). Longer pauses
                    (real silence) only get TAIL_PAD so a word doesn't linger for
                    seconds during a deliberate gap.
     MIN_DUR      – floor so very short words stay readable. */
var CAPTION_TIMING = {
  LEAD_IN:      0.08,
  TAIL_PAD:     0.15,
  MAX_GAP_FILL: 0.60,
  MIN_DUR:      0.30
};

/* Post-process raw captions ([start,end] straight off the STT word stamps) into
   smooth on-screen timing. Mutates and returns the same array. */
function applyCaptionTiming(captions) {
  var T = CAPTION_TIMING;
  if (!captions || captions.length === 0) return captions;

  // Pull each start a touch earlier so captions don't feel late (clamped ≥ 0).
  captions.forEach(function (c) {
    c.startTime = Math.max(0, c.startTime - T.LEAD_IN);
  });

  for (var i = 0; i < captions.length; i++) {
    var cur = captions[i];
    var next = captions[i + 1];

    if (next) {
      var gap = next.startTime - cur.endTime;
      if (gap > 0 && gap <= T.MAX_GAP_FILL) {
        // Small silence → hold the current caption until the next appears.
        cur.endTime = next.startTime;
      } else {
        // Real pause (or overlap from lead-in) → just pad, never cross the next.
        cur.endTime = Math.min(cur.endTime + T.TAIL_PAD, next.startTime);
      }
    } else {
      // Last caption: nothing to butt against, so just give it the tail.
      cur.endTime += T.TAIL_PAD;
    }

    // Enforce a readable floor without ever overrunning the next caption.
    if (cur.endTime - cur.startTime < T.MIN_DUR) {
      var floored = cur.startTime + T.MIN_DUR;
      cur.endTime = next ? Math.min(floored, next.startTime) : floored;
    }
  }

  return captions;
}

function groupWordsToCaptions(words, mode, phraseSize, timeOffset) {
  if (!words || words.length === 0) return [];
  timeOffset = timeOffset || 0;
  var captions = [];

  if (mode === 'word') {
    words.forEach(function (w, i) {
      captions.push({
        id: i + 1,
        text: w.word,
        startTime: (w.start || 0) + timeOffset,
        endTime: (w.end || (w.start || 0) + 0.4) + timeOffset,
        words: _capWords([w], timeOffset)
      });
    });

  } else if (mode === 'phrase') {
    for (var i = 0; i < words.length; i += phraseSize) {
      var chunk = words.slice(i, i + phraseSize);
      var last = chunk[chunk.length - 1];
      captions.push({
        id: captions.length + 1,
        text: chunk.map(function (w) { return w.word; }).join(' '),
        startTime: (chunk[0].start || 0) + timeOffset,
        endTime: (last.end || last.start || 0) + timeOffset,
        words: _capWords(chunk, timeOffset)
      });
    }

  } else if (mode === 'sentence') {
    var current = [];
    words.forEach(function (w, i) {
      current.push(w);
      var isLast = i === words.length - 1;
      var isBoundary = /[.?!]/.test(w.word);
      var isPause = /[,;:]/.test(w.word) && current.length >= 5;
      if (isLast || isBoundary || isPause || current.length >= 12) {
        var last2 = current[current.length - 1];
        captions.push({
          id: captions.length + 1,
          text: current.map(function (x) { return x.word; }).join(' '),
          startTime: (current[0].start || 0) + timeOffset,
          endTime: (last2.end || last2.start || 0) + timeOffset,
          words: _capWords(current, timeOffset)
        });
        current = [];
      }
    });
  }

  return applyCaptionTiming(captions);
}

/* Map raw word objects onto a caption's `words` array with the timeline
   offset baked in. Kept as absolute timeline seconds so After Effects can
   key per-word animations (karaoke highlight, Hormozi pop) to actual speech
   timing. Falls back to a small default duration when `end` is missing. */
function _capWords(chunk, timeOffset) {
  timeOffset = timeOffset || 0;
  return chunk.map(function (w) {
    var s = (w.start || 0) + timeOffset;
    var e = (w.end != null ? w.end : (w.start || 0) + 0.3) + timeOffset;
    return { word: w.word, start: s, end: e };
  });
}

/* Build captions from pre-decided word groups (Smart mode). Each group is an
   array of the ORIGINAL word objects, so timestamps are untouched — identical
   to the phrase builder, only the grouping comes from the LLM instead of a
   fixed step. */
function buildCaptionsFromGroups(groups, timeOffset) {
  if (!groups || groups.length === 0) return [];
  timeOffset = timeOffset || 0;
  var captions = [];
  groups.forEach(function (chunk) {
    if (!chunk || chunk.length === 0) return;
    var last = chunk[chunk.length - 1];
    captions.push({
      id: captions.length + 1,
      text: chunk.map(function (w) { return w.word; }).join(' '),
      startTime: (chunk[0].start || 0) + timeOffset,
      endTime: (last.end || last.start || 0) + timeOffset,
      words: _capWords(chunk, timeOffset)
    });
  });
  return applyCaptionTiming(captions);
}

/* ═══════════════════════════════════════════════════════════════════
   TRANSCRIPT UI
═══════════════════════════════════════════════════════════════════ */
// mm:ss timecode for transcript lines (e.g. 14.2 → "0:14")
function tcShort(s) {
  var m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function renderTranscriptWords(captions) {
  var body = document.getElementById('transcriptBody');
  body.classList.toggle('editing', isEditing);
  while (body.firstChild) body.removeChild(body.firstChild);
  captions.forEach(function (cap) {
    var line = document.createElement('div');
    line.className = 'tl';
    line.dataset.id = cap.id;
    line.title = formatTime(cap.startTime) + ' – ' + formatTime(cap.endTime) +
      '  ·  click to jump here';

    var tc = document.createElement('span');
    tc.className = 'tc';
    tc.textContent = tcShort(cap.startTime);

    var tx = document.createElement('span');
    tx.className = 'tx';
    tx.textContent = cap.text;
    if (isEditing) tx.contentEditable = 'true';

    line.appendChild(tc);
    line.appendChild(tx);
    body.appendChild(line);
  });

  // Search and Translate only make sense once there are lines, and any active
  // query has to be re-applied over the lines we just rebuilt.
  var empty = captions.length === 0;
  var wrap = document.getElementById('transcriptSearchWrap');
  if (wrap) wrap.hidden = empty;
  var tCtl = document.getElementById('translateField');
  if (tCtl) tCtl.hidden = empty;
  _filterTranscript(_transcriptQuery);
}

/* ── Click-to-seek ────────────────────────────────────────────────
   Delegated once on the container, so it survives every re-render. */
function initTranscriptSeek() {
  var body = document.getElementById('transcriptBody');
  if (!body) return;

  body.addEventListener('click', function (e) {
    // While editing, a click is placing the caret in the text — not seeking.
    if (isEditing) return;
    var line = e.target.closest ? e.target.closest('.tl') : null;
    if (!line || !line.dataset.id) return;

    var id  = parseInt(line.dataset.id, 10);
    var cap = null;
    for (var i = 0; i < state.captions.length; i++) {
      if (state.captions[i].id === id) { cap = state.captions[i]; break; }
    }
    if (!cap) return;

    body.querySelectorAll('.tl.active').forEach(function (l) { l.classList.remove('active'); });
    line.classList.add('active');
    seekHostTo(cap.startTime);
  });
}

/* Move the AE comp / Premiere sequence playhead to `t` seconds.

   A failed seek is told to the user ONCE per session: someone clicking down a
   transcript with no comp open would otherwise collect a toast per line, and
   the status chip isn't in the header any more so setStatus() would say it to
   nobody. After the first warning it stays in the console. */
var _seekWarned = false;

function seekHostTo(t) {
  var secs = Math.max(0, parseFloat(t) || 0);
  csInterface.evalScript('setPlayhead(' + secs.toFixed(3) + ')', function (raw) {
    function fail(detail) {
      console.warn('[Main] setPlayhead:', detail);
      if (_seekWarned) return;
      _seekWarned = true;
      showToast('info', 'Couldn’t move the playhead', detail);
    }
    if (!raw || raw === 'EvalScript error.' || raw === 'undefined') {
      fail('The host didn’t respond — reopen the panel and try again.');
      return;
    }
    var res;
    try { res = JSON.parse(raw); } catch (e) { return; }
    if (!res.success) fail(res.error || 'Open a composition or sequence first.');
  });
}

/* ── Transcript search ────────────────────────────────────────────
   Plain case-insensitive substring match on the visible text. Non-matching
   lines get .hidden (display:none) rather than being removed, so clearing the
   query restores the list without a re-render. */
var _transcriptQuery = '';

function initTranscriptSearch() {
  var input = document.getElementById('transcriptSearch');
  var clear = document.getElementById('transcriptSearchClear');
  if (!input) return;

  input.addEventListener('input', function () { _filterTranscript(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { input.value = ''; _filterTranscript(''); }
  });
  if (clear) clear.addEventListener('click', function () {
    input.value = '';
    _filterTranscript('');
    input.focus();
  });
}

function _filterTranscript(q) {
  _transcriptQuery = q || '';
  var needle = _transcriptQuery.trim().toLowerCase();
  var body = document.getElementById('transcriptBody');
  if (!body) return;

  var lines = body.querySelectorAll('.tl');
  var shown = 0;
  lines.forEach(function (line) {
    var tx  = line.querySelector('.tx');
    var hay = (tx ? tx.textContent : '').toLowerCase();
    var hit = !needle || hay.indexOf(needle) >= 0;
    line.classList.toggle('hidden', !hit);
    if (hit) shown++;
  });

  var clear = document.getElementById('transcriptSearchClear');
  if (clear) clear.hidden = needle.length === 0;

  // "No matches" note — added and removed, never left sitting empty.
  var note = document.getElementById('transcriptNoMatch');
  if (needle && shown === 0 && lines.length > 0) {
    if (!note) {
      note = document.createElement('div');
      note.className = 'tr-nomatch';
      note.id = 'transcriptNoMatch';
      body.appendChild(note);
    }
    note.textContent = 'No lines match "' + _transcriptQuery.trim() + '".';
  } else if (note && note.parentNode) {
    note.parentNode.removeChild(note);
  }
}

/* The line above the transcript: caption count, plus which language it came out
   in. "Detected: Hindi · 42 captions" after an auto-detect run, and
   "Translated to Spanish · 42 captions" once a translation is applied. */
function setTranscriptStatus() {
  var el = document.getElementById('captionCount');
  if (!el) return;

  var n = state.captions.length;
  var count = n + (n === 1 ? ' caption' : ' captions');

  if (state.translatedTo) {
    el.textContent = 'Translated to ' + AITranslate.targetName(state.translatedTo) + ' · ' + count;
    return;
  }

  el.textContent = count;
}

var isEditing = false;
function toggleTranscriptEdit() {
  if (state.captions.length === 0) return;
  isEditing = !isEditing;
  var body = document.getElementById('transcriptBody');
  var btn = document.getElementById('btnEdit');
  var labelEl = btn.querySelector('span');
  if (isEditing) {
    body.classList.add('editing');
    btn.setAttribute('aria-pressed', 'true');
    if (labelEl) labelEl.textContent = 'Done';
    renderTranscriptWords(state.captions);
    var first = body.querySelector('.tx');
    if (first) first.focus();
  } else {
    btn.setAttribute('aria-pressed', 'false');
    if (labelEl) labelEl.textContent = 'Edit';
    rebuildCaptionsFromEdit();
    body.classList.remove('editing');
  }
}

function rebuildCaptionsFromEdit() {
  var lines = document.querySelectorAll('#transcriptBody .tl');
  lines.forEach(function (line, i) {
    if (!state.captions[i]) return;
    var tx = line.querySelector('.tx');
    var txt = (tx ? tx.textContent : '').trim();
    if (txt) state.captions[i].text = txt;
  });
  renderTranscriptWords(state.captions);
}

/* ═══════════════════════════════════════════════════════════════════
   TRANSLATION  (step 2)
   Translating rewrites cap.text and leaves cap.startTime/endTime alone, so a
   translated caption lands on exactly the same frames as the original. The
   source text is kept on cap.textOriginal, which is what makes "back to
   Original" and the export toggle possible without re-transcribing.
═══════════════════════════════════════════════════════════════════ */
function initTranslatePicker() {
  var trigger = document.getElementById('translateTrigger');
  var menu    = document.getElementById('translateMenu');
  var list    = document.getElementById('translateList');
  var search  = document.getElementById('translateSearch');
  if (!trigger || !menu || !list || typeof AITranslate === 'undefined') return;

  function addOption(code, name, sub, flag) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-opt';
    btn.setAttribute('data-target', code);
    btn.setAttribute('data-search', (name + ' ' + sub + ' ' + code).toLowerCase());
    if (!code) btn.setAttribute('data-pin', '1');   // "Original language" always shows

    var fl = document.createElement('span');
    fl.className = 'flag';
    fl.textContent = flag;
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = name;
    var sb = document.createElement('span');
    sb.className = 'sub';
    sb.textContent = sub;
    var ck = document.createElement('span');
    ck.className = 'ck-check';
    _setMarkup(ck, IC.check);

    btn.appendChild(fl);
    btn.appendChild(nm);
    btn.appendChild(sb);
    btn.appendChild(ck);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      applyTranslation(code, name, flag);
    });
    list.appendChild(btn);
  }

  addOption('', 'Original language', 'no translation', '🗣️');
  AITranslate.targets.forEach(function (t) {
    addOption(t[0], t[1], t[2], t[3]);
  });
  _paintTranslateSelection();

  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    var isOpen = menu.classList.contains('open');
    document.querySelectorAll('.dd-menu.open').forEach(function (m) {
      m.classList.remove('open');
      var t = m.parentNode && m.parentNode.querySelector('[aria-expanded]');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
    if (!isOpen) {
      menu.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      if (search) { search.value = ''; _filterList('translateList', ''); setTimeout(function () { search.focus(); }, 0); }
    }
  });
  if (search) {
    search.addEventListener('click', function (e) { e.stopPropagation(); });
    search.addEventListener('input', function () { _filterList('translateList', search.value); });
  }
}

/* Drop back to "no translation" — called when a fresh transcript arrives, so a
   language chosen for the previous clip doesn't silently apply to the new one. */
function _resetTranslation() {
  state.translatedTo = '';
  state.exportSource = 'translated';
  var flagEl = document.getElementById('translateFlag');
  var labEl  = document.getElementById('translateLab');
  if (flagEl) flagEl.textContent = '🗣️';
  if (labEl)  labEl.textContent  = 'Original';
  var exCtl = document.getElementById('exportSrcCtl');
  if (exCtl) exCtl.hidden = true;
  var seg = document.getElementById('exportSrcSeg');
  if (seg) {
    seg.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.src === 'translated' ? 'true' : 'false');
    });
  }
  _paintTranslateSelection();
}

function _paintTranslateSelection() {
  var list = document.getElementById('translateList');
  if (!list) return;
  var current = state.translatedTo || '';
  list.querySelectorAll('.dd-opt').forEach(function (o) {
    o.setAttribute('aria-selected', o.getAttribute('data-target') === current ? 'true' : 'false');
  });
}

/* Which text SRT/VTT export writes when a translation is in play. */
function initExportSourceSeg() {
  var seg = document.getElementById('exportSrcSeg');
  if (!seg) return;
  seg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.exportSource = b.dataset.src;
    seg.querySelectorAll('button').forEach(function (x) {
      x.setAttribute('aria-selected', x === b ? 'true' : 'false');
    });
  });
}

function applyTranslation(code, name, flag) {
  if (state.captions.length === 0) return;
  if (typeof AITranslate === 'undefined') return;
  if ((state.translatedTo || '') === (code || '')) return;   // already there
  // One run at a time. Two overlapping runs would race each other's captions
  // and finish with contradictory toasts.
  if (state._translating) return;

  var flagEl = document.getElementById('translateFlag');
  var labEl  = document.getElementById('translateLab');

  // ── Back to the original transcript ────────────────────────────
  if (!code) {
    AITranslate.restore(state.captions);
    state.translatedTo = '';
    if (flagEl) flagEl.textContent = '🗣️';
    if (labEl)  labEl.textContent  = 'Original';
    var exCtl = document.getElementById('exportSrcCtl');
    if (exCtl) exCtl.hidden = true;
    _paintTranslateSelection();
    renderTranscriptWords(state.captions);
    setTranscriptStatus();
    return;
  }

  state._translating = true;
  setStatus('busy', 'Translating to ' + name + '…');
  showProgress('Translating to ' + name + '…', 5);

  AITranslate.translate(
    state.captions,
    code,
    function (caps, translated, lastError) {
      state._translating = false;
      hideProgress();
      setGeneratingUI(false);

      if (translated === 0) {
        // Nothing came back — the captions are untouched, so just say so, and
        // say WHICH failure it was: a count mismatch (the model merged or split
        // captions, so applying it would slide every later timecode) is a
        // different problem from the service being unreachable.
        setStatus('ready', 'Translation unavailable');
        var hint = /count mismatch/i.test(lastError || '')
          ? 'The AI returned the wrong number of lines — captions are unchanged. Try again.'
          : 'The AI service didn’t respond — captions are unchanged.';
        showToast('error', 'Couldn’t translate', hint);
        _paintTranslateSelection();
        return;
      }

      state.translatedTo = code;
      if (flagEl) flagEl.textContent = flag;
      if (labEl)  labEl.textContent  = name;

      var exCtl2 = document.getElementById('exportSrcCtl');
      if (exCtl2) exCtl2.hidden = false;

      _paintTranslateSelection();
      renderTranscriptWords(state.captions);
      setTranscriptStatus();
      setStatus('ready', 'Translated to ' + name);

      if (translated < caps.length) {
        showToast('info', 'Partly translated',
          translated + ' of ' + caps.length + ' captions — the rest kept the original text.');
      } else {
        showToast('success', 'Translated to ' + name, 'Timing unchanged — ' + caps.length + ' captions.');
      }
    },
    function (p) { showProgress(p.label, 5 + Math.round(p.pct * 0.9)); }
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PLACE ON TIMELINE  (Premiere Pro / After Effects)

   Single-phase: write JSON payload → evalScript → handle result.

   PP: places captions as MOGRT graphic clip instances on a new track.
       If placement fails, the diagnostic card surfaces the MOGRT prop dump.
   AE: always creates text layers directly.
═══════════════════════════════════════════════════════════════════ */

// ─── DEAD CODE REMOVED ───────────────────────────────────────────
// _renderCaptionPNGs, _renderCaptionAnimFrames, _rimrafSync and the
// Strategy 3 (PNG overlays) / Strategy 0 (animated stills) paths in
// ExtendScript have all been removed.  PP imports captions as an SRT
// transcript — either via QE DOM scripting or manually via the
// Text panel (Window → Text → Import Captions from File).
// ─────────────────────────────────────────────────────────────────


/* Placement runs after a short chain of optional AI passes — each one enriches
   the captions in place, each one is skippable, and none of them may block
   placement when the LLM is unreachable. Results are cached on state so the
   second "Add to Comp" doesn't pay for the same round trip twice. */
function placeOnTimeline() {
  if (state.captions.length === 0) return;
  _prepEmphasisSplit(function () {
    _prepEmoji(function () {
      _doPlaceOnTimeline();
    });
  });
}

/* Two-line looks (Emphasis / Font Pair): let the AI decide where each caption
   splits into intro + payoff before placing. Heuristic values are applied
   immediately, so a failed/offline LLM never blocks placement. */
function _prepEmphasisSplit(next) {
  var twoLine = (state.style.animation === 'emphasis' || state.style.animation === 'fontpair');
  if (!twoLine || state._emphasisSplitDone || typeof AIEmphasis === 'undefined') { next(); return; }

  setStatus('busy', 'AI weighing emphasis…');
  showProgress('AI weighing emphasis…', 10);
  AIEmphasis.split(
    state.captions,
    function (caps, aiSucceeded) {
      state._emphasisSplitDone = true;
      hideProgress();
      if (!aiSucceeded) showToast('info', 'AI unavailable', 'Used smart word-weight fallback for line splits.');
      next();
    },
    function (p) { showProgress(p.label, 10 + Math.round(p.pct * 0.5)); }
  );
}

/* Auto-emoji: one emoji per caption, chosen by the LLM. Runs at placement (not
   at transcription) so toggling it doesn't mean re-transcribing, and so the
   transcript stays the clean words. No offline fallback — every caption keeps
   emoji '' and the captions place unchanged.

   Two phases: pick the emoji, then rasterise each one to a PNG. The PNG step is
   what makes emoji actually visible — After Effects can't render colour-emoji
   fonts, so the glyph goes into the comp as footage, not as text. */
function _prepEmoji(next) {
  if (!state.style.emojiOn || state._emojiDone || typeof AIEmoji === 'undefined') { next(); return; }

  setStatus('busy', 'AI picking emoji…');
  showProgress('AI picking emoji…', 10);
  AIEmoji.annotate(
    state.captions,
    function (caps, aiSucceeded) {
      state._emojiDone = true;
      if (!aiSucceeded) {
        hideProgress();
        showToast('info', 'Emoji unavailable', 'Placing captions without emoji this time.');
        next();
        return;
      }

      showProgress('Rendering emoji…', 62);
      AIEmoji.renderAssets(state.captions, function (assets) {
        state.emojiAssets = assets || {};
        hideProgress();

        var wanted = 0;
        state.captions.forEach(function (c) { if (c.emoji) wanted++; });
        var have = 0;
        for (var k in state.emojiAssets) { if (state.emojiAssets.hasOwnProperty(k)) have++; }

        // No PNG means no emoji font on this machine. Say so rather than
        // placing captions that silently lost their emoji.
        if (wanted > 0 && have === 0) {
          showToast('info', 'Emoji couldn’t be rendered',
            'No emoji font found on this machine — captions will place without them.');
        }
        next();
      });
    },
    function (p) { showProgress(p.label, 10 + Math.round(p.pct * 0.5)); }
  );
}

function _doPlaceOnTimeline() {

  var fs = require('fs');
  var os = require('os');
  var path = require('path');

  // Use the caption style selected in "Style your caption"; fall back to the
  // first bundled .mogrt in the folder if none was picked.
  var mogrPath = state.mogrtPath || '';
  if (!mogrPath) {
    try {
      var mdir = path.join(csInterface.getSystemPath(SystemPath.EXTENSION), 'mogrt');
      var mfiles = fs.readdirSync(mdir).filter(function (f) { return /\.mogrt$/i.test(f); });
      if (mfiles.length) mogrPath = path.join(mdir, mfiles[0]);
    } catch (e) { }
  }

  var seqW = state.seqWidth || 1920;
  var seqH = state.seqHeight || 1080;

  var payload = {
    captions: state.captions,
    style: state.style,
    mogrPath: mogrPath,
    seqWidth: seqW,
    seqHeight: seqH,
    // emoji → PNG path on disk (see AIEmoji.renderAssets). Empty when the
    // toggle is off or nothing could be rendered.
    emojiAssets: state.emojiAssets || {}
  };

  var tmpFile = path.join(os.homedir(), '.pulse_captions_data.json');
  var safePath = tmpFile.replace(/\\/g, '/');
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf8');
  } catch (we) {
    showError('Could not write data file: ' + we.message);
    return;
  }

  setStatus('busy', 'Placing captions on timeline…');

  csInterface.evalScript('placeCaptionsFromFile("' + safePath + '")', function (raw) {
    try { fs.unlinkSync(tmpFile); } catch (e) { }

    if (!raw || raw === 'EvalScript error.' || raw === 'undefined') {
      showError('ExtendScript failed. Check Preferences → Scripting.');
      return;
    }

    var res;
    try { res = JSON.parse(raw); } catch (e) {
      showError('Unexpected response: ' + String(raw).substring(0, 120));
      return;
    }

    if (!res.success) {
      showError('Placement failed: ' + (res.error || 'unknown'));
      return;
    }

    if (res.placed) {
      _handlePlacementSuccess(res);
    } else {
      setStatus('error', 'Placement failed: ' + (res.method || 'unknown'));
    }
  });
}

function _handlePlacementSuccess(res) {
  var btn = document.getElementById('btnAddToComp');
  btn.disabled = true;

  // Flash "Added ✓" on the button, then reveal the start-over pill (design v3)
  var lb = btn.querySelector('span:last-child');
  if (lb) {
    var orig = lb.textContent;
    lb.textContent = 'Added ✓';
    setTimeout(function () { lb.textContent = orig; }, 1100);
  }
  document.getElementById('btnRegen').style.display = 'inline-flex';

  showToast('success', res.captionCount + ' captions placed', 'Editable layers on your timeline.');
  setStatus('ready', 'Ready');
}


/* ═══════════════════════════════════════════════════════════════════
   EXPORT
═══════════════════════════════════════════════════════════════════ */
function exportSubtitles(format) {
  if (state.captions.length === 0) return;

  // With a translation applied, cap.text IS the translation and the source sits
  // on cap.textOriginal — the Export toggle picks between them. Timecodes are
  // identical either way, so both files stay in sync with the same video.
  var wantOriginal = state.translatedTo && state.exportSource === 'original';

  var content = format === 'srt' ? '' : 'WEBVTT\n\n';
  state.captions.forEach(function (cap, i) {
    var text = (wantOriginal && cap.textOriginal != null) ? cap.textOriginal : cap.text;
    content += (i + 1) + '\n';
    if (format === 'srt') {
      content += toSRTTime(cap.startTime) + ' --> ' + toSRTTime(cap.endTime) + '\n';
    } else {
      content += toVTTTime(cap.startTime) + ' --> ' + toVTTTime(cap.endTime) + '\n';
    }
    content += text + '\n\n';
  });

  // Ask the host for a Save As location via ExtendScript so the user picks
  // where the file lands. Falls back to the Documents folder if cancelled.
  var defaultName = 'Yashkit_' + Date.now() + '.' + format;
  var script =
    '(function() {' +
    'var f = File.saveDialog("Save ' + format.toUpperCase() + ' file", ' +
    '"' + defaultName + '"); ' +
    'return f ? f.fsName : "";' +
    '})()';

  csInterface.evalScript(script, function (chosenPath) {
    if (!chosenPath || chosenPath === 'undefined' || chosenPath === 'EvalScript error.') {
      setStatus('ready', 'Export cancelled');
      return;
    }
    try {
      require('fs').writeFileSync(chosenPath, content, 'utf8');
      var name = chosenPath.replace(/\\/g, '/').split('/').pop();
      showToast('success', 'Exported ' + name);
      setStatus('ready', 'Exported');
    } catch (e) {
      showError('Export failed: ' + e.message);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════
   CANCEL
═══════════════════════════════════════════════════════════════════ */
function cancelGeneration() {
  batchAPI.cancel();
  audioProcessor.cancel();
  cleanupTempAudio();
  state.isGenerating = false;
  setGeneratingUI(false);
  hideProgress();
  setStatus('ready', 'Cancelled');
}

function cleanupTempAudio() {
  if (state.tempAudioPath) {
    try { require('fs').unlinkSync(state.tempAudioPath); } catch (e) { }
    state.tempAudioPath = null;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════════════════════════════════ */
var BOLT_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.2 2.2 4.6 12.9c-.5.6-.1 1.5.7 1.5H10l-1.4 7.1c-.2.9 1 1.4 1.5.6l8.6-10.7c.5-.6.1-1.5-.7-1.5H13l1.4-7.1c.2-.9-1-1.4-1.5-.6Z"/></svg>';

function setGeneratingUI(val) {
  var btn = document.getElementById('btnGenerate');
  var progress = document.getElementById('topProgress');   // the 2px .ck-prog bar
  var fill = document.getElementById('progressFill');
  btn.disabled = val;
  if (val) {
    btn.innerHTML = '<span class="spin"></span><span>Transcribing…</span>';
    if (fill) fill.style.width = '0%';
    if (progress) progress.classList.add('on');
  } else {
    var label = state.hasGenerated ? 'Regenerate' : 'Generate Captions';
    btn.innerHTML = BOLT_SVG + '<span>' + label + '</span>';
    if (progress) progress.classList.remove('on');
    if (fill) fill.style.width = '0%';
    hideProgress();
  }
}
function showProgress(label, pct) {
  document.getElementById('progressWrap').classList.add('visible');
  document.getElementById('progressLabel').textContent = label;
  document.getElementById('progressFill').style.width = Math.min(100, pct) + '%';
}
function hideProgress() {
  document.getElementById('progressWrap').classList.remove('visible');
}
/* Status chip: short uppercase state (READY / WORKING / ERROR) + animated
   equalizer. Detailed messages live in the progress label / toasts; the full
   text is kept on the chip's title for accessibility. */
function setStatus(type, text) {
  var pill = document.getElementById('statusPill');
  var labelEl = document.getElementById('statusText');
  var cls = (type === 'busy') ? 'busy' : (type === 'error') ? 'error' : 'ready';
  if (pill) {
    pill.className = 'status ' + cls;
    if (text) pill.title = text;
  }
  if (labelEl) labelEl.textContent = (cls === 'busy') ? 'WORKING' : (cls === 'error') ? 'ERROR' : 'READY';
}
function showError(msg) {
  var f = _friendlyError(msg);
  setStatus('error', f.title);
  hideProgress();
  setGeneratingUI(false);
  state.isGenerating = false;
  showToast('error', f.title, f.hint);
  console.error('[Pulse Captions]', msg);   // full technical detail for debugging
}

/* Map raw technical failures to a plain-English title + what-to-do hint.
   The raw message is still logged to the console; users only see these. */
function _friendlyError(raw) {
  var m = String(raw || '');

  var MAP = [
    [/no (active )?(clip|sequence)|select a clip|nothing (is )?selected|no comp/i,
      'No clip selected', 'Select a clip in your timeline, then try again.'],
    [/unexpected clip-info response|unexpected response/i,
      'Another extension interfered', 'Close other panels (or restart the app) and try again — a conflicting extension corrupted the response.'],
    [/host script did not respond|evalscript|extendscript/i,
      'Can\u2019t reach the editor', 'Close and reopen the panel. If it persists, restart the app.'],
    [/ffmpeg|audio export failed/i,
      'Couldn\u2019t read the audio', 'The clip\u2019s audio couldn\u2019t be exported. Try another clip or re-render this one.'],
    [/could not find media|media file|file not found|path is incorrect|offline/i,
      'Media file not found', 'The clip\u2019s source file is missing \u2014 relink it and try again.'],
    [/timed out|timeout/i,
      'Transcription timed out', 'The clip may be too long \u2014 try a shorter section.'],
    [/network|curl|enotfound|econnrefused|econnreset/i,
      'Connection problem', 'Check your internet connection and try again.'],
    [/authentication|app token|http 40[13]/i,
      'Authentication failed', 'Update the plugin to the latest version, or contact support.'],
    [/too large|http 413/i,
      'Clip is too long', 'Try a shorter clip or a smaller selection.'],
    [/server is busy|http 429/i,
      'Server is busy', 'Lots of transcriptions right now \u2014 try again in a minute.'],
    [/no word timestamps|no speech|parse api response/i,
      'No speech found', 'The audio came back empty \u2014 check the clip has clear dialogue.'],
    // The transcriber validates `language` against an enum and against what the
    // account's region has enabled \u2014 two different failures, same fix for the user.
    [/language_not_enabled_in_region|has not been enabled in this region/i,
      'Language not available yet', 'That language isn\u2019t enabled on this plan \u2014 pick another, or contact support.'],
    [/invalid_enum_value|invalid query parameters/i,
      'Language not supported', 'Pick a different language from the list and try again.'],
    [/placement failed|placecaptions/i,
      'Couldn\u2019t place captions', 'Make sure your sequence or comp is open and active, then try again.'],
    [/write data file|response file|export failed|permission denied|eacces/i,
      'Couldn\u2019t save the file', 'Check folder permissions and free disk space, then try again.'],
    [/node modules unavailable|child_process/i,
      'Plugin needs a reinstall', 'A component is missing \u2014 reinstall Yashkit to fix it.']
  ];

  for (var i = 0; i < MAP.length; i++) {
    if (MAP[i][0].test(m)) return { title: MAP[i][1], hint: MAP[i][2] };
  }

  // Unknown failure: generic title, and a trimmed version of the raw
  // message as the hint so the user can still report something useful.
  var hint = m.replace(/\s+/g, ' ').substring(0, 90);
  if (m.length > 90) hint += '\u2026';
  return { title: 'Something went wrong', hint: hint || 'Please try again.' };
}

/* Toast: icon + left-aligned text block (semibold title, muted detail line).
   showToast(type, title[, detail]) \u2014 type: 'success' | 'info' | 'error'. */
var _toastTimeout = null;
function showToast(type, title, detail) {
  if (_toastTimeout) { clearTimeout(_toastTimeout); _toastTimeout = null; }
  var t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.classList.toggle('toast-error', type === 'error');

  while (t.firstChild) t.removeChild(t.firstChild);

  var ic = document.createElement('span');
  ic.className = 'ic';
  _setMarkup(ic, type === 'error'
    ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 6v8M12 18v.5"/></svg>'
    : '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>');
  t.appendChild(ic);

  var body = document.createElement('span');
  body.className = 'tmsg';
  var tt = document.createElement('b');
  tt.textContent = title;
  body.appendChild(tt);
  if (detail) {
    var dt = document.createElement('i');
    dt.textContent = detail;
    body.appendChild(dt);
  }
  t.appendChild(body);

  // Remove then re-add .show so the transition re-fires on repeat toasts
  t.classList.remove('show');
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      t.classList.add('show');
    });
  });

  var delay = (type === 'error') ? 6500 : (type === 'info') ? 6000 : 3500;
  _toastTimeout = setTimeout(function () {
    t.classList.remove('show');
  }, delay);
}


/* ═══════════════════════════════════════════════════════════════════
   TIME HELPERS
═══════════════════════════════════════════════════════════════════ */
function formatTime(s) {
  var m = Math.floor(s / 60);
  var sec = (s % 60).toFixed(1);
  return m + ':' + (parseFloat(sec) < 10 ? '0' : '') + sec;
}
function toSRTTime(s) {
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var se = Math.floor(s % 60);
  var ms = Math.round((s % 1) * 1000);
  return pad(h) + ':' + pad(m) + ':' + pad(se) + ',' + pad(ms, 3);
}
function toVTTTime(s) { return toSRTTime(s).replace(',', '.'); }
function pad(n, len) { return String(n).padStart(len || 2, '0'); }

