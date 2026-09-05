# Yashkit

> **AI-powered caption generation, animation, and styling extension for Adobe After Effects & Premiere Pro.**  
> Crafted with care by **[Yash Verma](https://github.com/yashverma2628)**.

---

## ⚡ Overview

**Yashkit** is an Adobe CEP extension designed for video editors and creators who want professional captions in seconds. It bridges automatic AI speech-to-text transcription with motion graphics design, allowing you to generate perfectly synced captions, animate them with 20+ viral styles (Hormozi, Karaoke, Typewriter, etc.), and batch-style entire timelines in a single click.

---

## ✨ Key Features

### 🎙️ AI Speech-to-Text & Word-Level Timing
- **Microsecond Audio Sync**: Automatically transcribes your sequence or composition audio down to individual word start and end times.
- **30+ Supported Languages**: Transcribe in English, Hindi/Hinglish, Spanish, French, German, Japanese, and more.
- **Smart Line Breaking & Word Modes**: Choose between Single Word, Short Phrase, Sentence, or Smart AI line breaks.

### 🎨 20+ High-Engagement Animation Styles
- **Hormozi**: Punch-in scale animations with active-word pop and accent color highlighting.
- **Karaoke**: Smooth word-by-word color highlight sweeps matching spoken pace.
- **Typewriter**: Character-by-character mechanical typewriter reveal.
- **Bounce & Elastic**: Dynamic scale overshoot for playful, energetic hooks.
- **Word Fade & Slide**: Clean, sleek editorial entrance animations for talking-head videos.
- **Gaming & Neon**: High-contrast, outlined styles tailored for streaming and gameplay clips.
- **Cinematic & Minimal**: Subtle, elegant title and documentary styling.

### 🔄 Adaptive Keyframe Timing (Dual-Duration Engine)
- **Automatic Keyframe Scaling**: When target text is shorter than the reference text, animator keyframes scale proportionally so short clips (e.g. 10–15 frames) never cut off or disappear.
- **Fixed Reference Speed**: When target text is longer than the reference text, animations maintain their punchy reference speed without stretching into slow motion.
- **Character Count Synchronization**: Dynamically adjusts Range Selector bounds to match the exact length of each individual caption string.

### 🪄 Style Tools ("Apply Style to All")
- **1-Click Batch Replication**: Select a single styled text layer and transfer its typography, text animators, layer effects, and transform keyframes across all captions in the composition.
- **Fix / Reveal Invisible Captions**: Built-in recovery tool that restores crushed keyframes, resets stuck animators, and unhides invisible text layers across your timeline.

---

## 🛠️ Architecture

```
Yashkit/
├── CSXS/
│   └── manifest.xml          # CEP extension manifest and configuration
├── host/
│   └── index.jsx             # ExtendScript (JSX) engine for After Effects & Premiere Pro
├── js/
│   ├── main.js               # UI controller, step navigation, and event dispatcher
│   ├── config.js             # Runtime endpoint and worker proxy settings
│   ├── pulse-batch-api.js    # Speech-to-text batch transcription pipeline
│   ├── audio-processor.js    # Audio extraction and FFmpeg invocation
│   ├── font-scanner.js       # System font discovery and filtering
│   ├── ai-emoji.js           # Context-aware emoji generation
│   ├── ai-emphasis.js        # Automatic two-line emphasis splitting
│   ├── ai-linebreak.js       # Natural language line-break optimization
│   └── ai-translate.js       # Multi-language translation engine
├── css/
│   └── style.css             # High-performance vanilla CSS design system
├── assets/
│   └── style-previews/       # Visual WebP previews for animation presets
├── fonts/                    # Bundled Geist typography
├── icons/                    # Panel icons and brand assets
├── ffmpeg-bin/               # Cross-platform FFmpeg binaries (macOS / Windows)
└── index.html                # Main CEP panel interface
```

---

## 🚀 Installation

### Prerequisites
- **Adobe After Effects**: CC 2019 (v16.0) or higher (AE 2020–2026+ supported)
- **Adobe Premiere Pro**: CC 2019 (v13.0) or higher
- Windows 10/11 or macOS (Intel & Apple Silicon)

### Step 1: Enable Unsigned CEP Extensions (PlayerDebugMode)

Because Yashkit runs in developer mode without an Adobe commercial certificate:

- **Windows**:
  1. Press `Win + R`, type `regedit`, and hit Enter.
  2. Navigate to `HKEY_CURRENT_USER\Software\Adobe\CSXS.7` (also check `CSXS.8`, `CSXS.9`, `CSXS.10`, `CSXS.11` if present).
  3. Right-click in the right pane, select **New** > **String Value**, name it `PlayerDebugMode`, and set its value to `1`.

- **macOS**:
  Open Terminal and run:
  ```bash
  defaults write com.adobe.CSXS.7 PlayerDebugMode 1
  defaults write com.adobe.CSXS.8 PlayerDebugMode 1
  defaults write com.adobe.CSXS.9 PlayerDebugMode 1
  defaults write com.adobe.CSXS.10 PlayerDebugMode 1
  defaults write com.adobe.CSXS.11 PlayerDebugMode 1
  ```

### Step 2: Install Extension Files

Copy the `Yashkit` directory into your Adobe CEP extensions folder:

- **Windows**:
  ```
  %APPDATA%\Adobe\CEP\extensions\Yashkit
  ```
  *(Full path: `C:\Users\<YourUsername>\AppData\Roaming\Adobe\CEP\extensions\Yashkit`)*

- **macOS**:
  ```
  ~/Library/Application Support/Adobe/CEP/extensions/Yashkit
  ```

### Step 3: Launch in Adobe

1. Open **After Effects** or **Premiere Pro**.
2. Navigate to the top menu bar: **Window** > **Extensions** > **Yashkit**.
3. The panel is ready to use!

---

## 📖 How to Use

1. **Step 0 · Set Up Your Captions**:
   - Choose your audio language.
   - Select your grouping mode (*Word*, *Phrase*, or *Sentence*).
   - Pick your desired font family, size, fill color, and outline.
2. **Step 1 · Pick an Animation Style**:
   - Browse through 20 visual presets with live hover previews.
   - Configure secondary options (e.g. highlight accent color, dual fonts).
3. **Step 2 · Generate Captions**:
   - Click **Generate Captions** to transcribe and analyze the audio.
   - Review and edit the generated transcript directly inside the panel.
   - Click **Add to Comp** to place keyframed, animated caption layers directly onto your timeline.
4. **Style Tools**:
   - Tweak one layer to perfection, then use **Apply Style to All** to propagate typography, animators, and keyframes across every other caption layer.

---

## 🔒 Security & Privacy

- **No Secret Keys Stored Locally**: All AI speech recognition and LLM inference run via an external proxy server configured in `js/config.js`. No private API keys or personal cloud credentials are embedded in this repository.
- **Local Audio Processing**: Audio extraction uses bundled local FFmpeg binaries; your raw project files remain on your machine.

---

## 👨‍💻 Author

**Yash Verma**  
- GitHub: [@yashverma2628](https://github.com/yashverma2628)  
- Instagram: [@yashhhverma_](https://www.instagram.com/yashhhverma_/)

---

## 📄 License

This project is licensed under the **MIT License** — feel free to use, customize, and build upon it!
