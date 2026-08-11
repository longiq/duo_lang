const LANGS = {
  vi: {
    label: '🇻🇳 Tiếng Việt',
    bcp47: 'vi-VN',
    prompt: 'Bấm micro và nói tiếng Việt',
    sourcePlaceholder: 'Câu bạn nói sẽ hiện ở đây, sửa được...',
    targetPlaceholder: 'Bản dịch tiếng Việt sẽ hiện ở đây...',
  },
  en: {
    label: '🇬🇧 English',
    bcp47: 'en-US',
    prompt: 'Bấm micro và nói tiếng Anh',
    sourcePlaceholder: 'Your sentence appears here, editable...',
    targetPlaceholder: 'Bản dịch tiếng Anh sẽ hiện ở đây...',
  },
  ja: {
    label: '🇯🇵 日本語',
    bcp47: 'ja-JP',
    prompt: 'Bấm micro và nói tiếng Nhật',
    sourcePlaceholder: '話した文がここに表示されます...',
    targetPlaceholder: '日本語の翻訳がここに表示されます...',
  },
};
// Fixed order so the two target panes never swap position unexpectedly.
const LANG_ORDER = ['vi', 'en', 'ja'];
const SOURCE_STORAGE_KEY = 'duolang.sourceLang';

const micBtn = document.getElementById('micBtn');
const micStatus = document.getElementById('micStatus');
const subtitle = document.getElementById('subtitle');
const langSwitch = document.getElementById('langSwitch');
const sourceInput = document.getElementById('sourceText');
const retranslateBtn = document.getElementById('retranslateBtn');
const errorMsg = document.getElementById('errorMsg');
const targetPanes = [0, 1].map((i) => ({
  label: document.getElementById(`targetLabel${i}`),
  text: document.getElementById(`targetText${i}`),
  speak: document.getElementById(`speakBtn${i}`),
  lang: null,
}));

let sourceLang = 'vi';
let targetLangs = ['en', 'ja'];
let translations = {};
let lastTranslatedText = '';

function showError(message) {
  errorMsg.textContent = message;
  errorMsg.hidden = false;
}

function clearError() {
  errorMsg.hidden = true;
}

function setText(el, text, isPlaceholder) {
  el.textContent = text;
  el.classList.toggle('placeholder', Boolean(isPlaceholder));
}

function idlePrompt() {
  return LANGS[sourceLang].prompt;
}

function autoGrow() {
  sourceInput.style.height = 'auto';
  sourceInput.style.height = `${sourceInput.scrollHeight}px`;
}

function targetsFor(source) {
  return LANG_ORDER.filter((l) => l !== source);
}

function clearTranslations() {
  translations = {};
  lastTranslatedText = '';
  targetPanes.forEach((pane) => {
    setText(pane.text, LANGS[pane.lang].targetPlaceholder, true);
    pane.speak.disabled = true;
  });
}

function refreshRetranslateState() {
  const text = sourceInput.value.trim();
  retranslateBtn.disabled = !text || text === lastTranslatedText;
}

function applySourceLang(lang, { keepText = false } = {}) {
  sourceLang = lang;
  targetLangs = targetsFor(lang);

  langSwitch.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });

  targetPanes.forEach((pane, i) => {
    pane.lang = targetLangs[i];
    pane.label.textContent = LANGS[pane.lang].label;
    pane.speak.setAttribute('aria-label', `Nghe ${LANGS[pane.lang].label}`);
  });

  sourceInput.placeholder = LANGS[lang].sourcePlaceholder;
  subtitle.textContent = `Nói ${LANGS[lang].label.replace(/^\S+\s/, '')} → dịch cùng lúc sang 2 ngôn ngữ còn lại`;
  micStatus.textContent = idlePrompt();

  if (!keepText) sourceInput.value = '';
  clearTranslations();
  refreshRetranslateState();
  autoGrow();

  try { localStorage.setItem(SOURCE_STORAGE_KEY, lang); } catch (err) { /* private mode */ }
}

// Keyed per language so a sentence already translated is shown without a
// round trip -- repeating yourself, or tapping retranslate, costs nothing.
const translationCache = new Map();

function showTranslations(result) {
  translations = {};
  targetPanes.forEach((pane) => {
    const value = result[pane.lang];
    translations[pane.lang] = value;
    setText(pane.text, value, false);
    pane.speak.disabled = !value;
  });
}

async function translate(text) {
  clearError();

  const cached = {};
  const allCached = targetLangs.every((lang) => {
    const hit = translationCache.get(`${sourceLang}|${lang}|${text}`);
    if (hit) cached[lang] = hit;
    return Boolean(hit);
  });

  if (allCached) {
    showTranslations(cached);
    lastTranslatedText = text;
    micStatus.textContent = idlePrompt();
    refreshRetranslateState();
    return;
  }

  micStatus.textContent = 'Đang dịch...';
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source: sourceLang, targets: targetLangs }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Lỗi dịch thuật.');
    }

    const result = data.translations || data;
    targetLangs.forEach((lang) => {
      if (result[lang]) translationCache.set(`${sourceLang}|${lang}|${text}`, result[lang]);
    });
    showTranslations(result);
    lastTranslatedText = text;
    micStatus.textContent = idlePrompt();
  } catch (err) {
    showError(err.message || 'Không thể dịch câu này.');
    micStatus.textContent = idlePrompt();
  } finally {
    refreshRetranslateState();
  }
}

langSwitch.addEventListener('click', (event) => {
  const btn = event.target.closest('.lang-btn');
  if (!btn || btn.dataset.lang === sourceLang) return;
  applySourceLang(btn.dataset.lang);
});

sourceInput.addEventListener('input', () => {
  autoGrow();
  refreshRetranslateState();
});

retranslateBtn.addEventListener('click', () => {
  const text = sourceInput.value.trim();
  if (text) translate(text);
});

const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
let voices = [];

function loadVoices() {
  voices = (synth && typeof synth.getVoices === 'function' && synth.getVoices()) || [];
}
loadVoices();
// iOS returns an empty list until the voices finish loading.
if (synth && typeof synth.addEventListener === 'function') {
  synth.addEventListener('voiceschanged', loadVoices);
}

// iOS ships character voices (Grandpa, Grandma, Jester, Rocko...) and legacy
// novelty ones (Fred, Ralph, Zarvox...) right alongside the real ones, so
// "first non-compact match" is not a safe pick -- it lands on those.
const NOVELTY_VOICE = /grandpa|grandma|jester|rocko|sandy|shelley|eddy|\bflo\b|reed|rosa|bahh|albert|bad news|bells|boing|bubbles|cellos|deranged|fred|good news|hysterical|junior|kathy|organ|princess|ralph|trinoids|whisper|zarvox|wobble|superstar|bruce|agnes/i;

const normLang = (l) => (l || '').toLowerCase().replace('_', '-');

// Higher is better; below zero means never use it.
function voiceScore(v) {
  const uri = v.voiceURI || '';
  const name = v.name || '';
  if (NOVELTY_VOICE.test(name)) return -1;
  if (/com\.apple\.speech\.synthesis\.voice/.test(uri)) return -1;
  if (/eloquence/i.test(uri)) return -1;

  let score;
  if (/premium/i.test(uri)) score = 40;
  else if (/enhanced/i.test(uri)) score = 30;
  else if (/siri/i.test(uri)) score = 25;
  else if (/compact/i.test(uri)) score = 5;
  else score = 10;

  if (v.default) score += 8;
  if (v.localService === false) score += 3;
  return score;
}

function pickVoice(lang) {
  const prefix = lang.split('-')[0].toLowerCase();
  const matches = voices.filter((v) => normLang(v.lang).startsWith(prefix));
  if (!matches.length) return null;

  const exact = matches.filter((v) => normLang(v.lang) === lang.toLowerCase());
  const ranked = (exact.length ? exact : matches)
    .map((v) => ({ voice: v, score: voiceScore(v) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score);

  // If every candidate is a novelty voice, leave the choice to the platform
  // rather than forcing a bad one.
  return ranked.length ? ranked[0].voice : null;
}

function speakWithDeviceVoice(text, bcp47) {
  if (!text || !synth) return;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = bcp47;
  utterance.volume = 1;
  utterance.rate = 0.95;
  const voice = pickVoice(bcp47);
  if (voice) utterance.voice = voice;
  synth.speak(utterance);
}

// --- server-synthesised speech ---------------------------------------------
// speechSynthesis on iOS plays back well below what the device can manage and
// its volume is capped at 1. Routing server audio through Web Audio instead
// allows gain above unity, which is the only way to actually get it louder.

let audioCtx = null;
let currentSource = null;
const audioCache = new Map();

// Must be called synchronously from the click handler: iOS only allows a
// context to start or resume inside a user gesture.
function ensureAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
    audioCtx.resume();
  }
  return audioCtx;
}

// Older Safari only has the callback form of decodeAudioData.
function decodeAudio(ctx, bytes) {
  return new Promise((resolve, reject) => {
    const maybePromise = ctx.decodeAudioData(bytes, resolve, reject);
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(resolve, reject);
    }
  });
}

function peakAmplitude(buffer) {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) {
      const value = Math.abs(samples[i]);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

function playBuffer(ctx, buffer) {
  if (currentSource) {
    try { currentSource.stop(); } catch (err) { /* already finished */ }
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  // Normalise first so the limiter below sees a predictable level whatever the
  // service returns (its output already sits near full scale, around -1 dBFS).
  const normalise = ctx.createGain();
  normalise.gain.value = Math.min(8, 0.99 / Math.max(peakAmplitude(buffer), 0.001));

  // Speech has a wide crest factor: peaks near full scale over an average
  // around -16 dBFS. Limiting the peaks hard and then making up the level is
  // what raises loudness -- gentle compression measured at under +1 dB, i.e.
  // nothing. These values were measured against real output at +8 dB average
  // with peaks landing near 0.81, so they stay clear of clipping.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 0;
  compressor.ratio.value = 20;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.15;

  const makeUp = ctx.createGain();
  makeUp.gain.value = 3;

  source.connect(normalise);
  normalise.connect(compressor);
  compressor.connect(makeUp);
  makeUp.connect(ctx.destination);
  source.start();
  currentSource = source;
}

async function speakViaServer(ctx, text, lang) {
  const key = `${lang}|${text}`;
  let buffer = audioCache.get(key);

  if (!buffer) {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang }),
    });
    if (!res.ok) {
      const err = new Error('speech request failed');
      // Distinguish the budget cap so the user is told why it sounds different.
      err.quotaExhausted = res.status === 429;
      if (err.quotaExhausted) {
        err.serverMessage = await res.json().then((d) => d && d.error).catch(() => null);
      }
      throw err;
    }
    buffer = await decodeAudio(ctx, await res.arrayBuffer());
    audioCache.set(key, buffer);
  }

  playBuffer(ctx, buffer);
}

async function speak(text, lang, button) {
  if (!text) return;
  const ctx = ensureAudioContext();
  button.classList.add('loading');

  try {
    if (!ctx) throw new Error('Web Audio unavailable');
    await speakViaServer(ctx, text, lang);
  } catch (err) {
    // Offline, out of daily quota, or the service is unhappy: the device voice
    // is quieter but better than silence.
    if (err && err.quotaExhausted) {
      showError(err.serverMessage || 'Hết hạn mức giọng đọc, đang dùng giọng máy.');
    }
    speakWithDeviceVoice(text, LANGS[lang].bcp47);
  } finally {
    button.classList.remove('loading');
  }
}

targetPanes.forEach((pane) => {
  pane.speak.addEventListener('click', () => {
    speak(translations[pane.lang], pane.lang, pane.speak);
  });
});

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognitionImpl) {
  micBtn.disabled = true;
  showError('Trình duyệt này không hỗ trợ nhận diện giọng nói. Hãy dùng Chrome trên Android/desktop.');
} else {
  const recognition = new SpeechRecognitionImpl();
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let isRecording = false;
  // Best transcript seen this session, final or not. Mobile browsers routinely
  // end recognition without ever marking a result final -- especially when the
  // user taps the button to stop -- so the interim text is all we get.
  let lastTranscript = '';
  let translationStarted = false;
  let sessionFailed = false;

  recognition.addEventListener('start', () => {
    isRecording = true;
    lastTranscript = '';
    translationStarted = false;
    sessionFailed = false;
    micBtn.classList.add('recording');
    micStatus.textContent = 'Đang nghe...';
    clearError();
  });

  recognition.addEventListener('end', () => {
    isRecording = false;
    micBtn.classList.remove('recording');
    if (!translationStarted && lastTranscript) {
      translationStarted = true;
      translate(lastTranscript);
    } else if (!translationStarted && !sessionFailed) {
      micStatus.textContent = idlePrompt();
    }
  });

  recognition.addEventListener('error', (event) => {
    isRecording = false;
    sessionFailed = true;
    micBtn.classList.remove('recording');
    if (event.error === 'no-speech') {
      micStatus.textContent = 'Không nghe thấy gì, thử lại nhé.';
    } else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      showError('Cần cấp quyền micro cho trang này.');
    } else if (event.error === 'aborted') {
      micStatus.textContent = idlePrompt();
    } else {
      showError('Lỗi nhận diện giọng nói: ' + event.error);
    }
  });

  recognition.addEventListener('result', (event) => {
    let finalTranscript = '';
    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }

    const text = (finalTranscript || interimTranscript).trim();
    if (!text) return;

    lastTranscript = text;
    sourceInput.value = text;
    autoGrow();
    refreshRetranslateState();
    if (finalTranscript) {
      translationStarted = true;
      translate(text);
    }
  });

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      recognition.stop();
      return;
    }
    clearTranslations();
    refreshRetranslateState();
    clearError();
    // Set per start: the user can switch source language between recordings.
    recognition.lang = LANGS[sourceLang].bcp47;
    try {
      recognition.start();
    } catch (err) {
      showError('Không thể bắt đầu ghi âm: ' + err.message);
    }
  });
}

// Restore the last source language before anything else reads the state.
let storedLang = null;
try { storedLang = localStorage.getItem(SOURCE_STORAGE_KEY); } catch (err) { /* private mode */ }
applySourceLang(LANGS[storedLang] ? storedLang : 'vi');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
