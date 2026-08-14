// Drives public/app.js against a stubbed DOM, SpeechRecognition and Web Audio.
//
// Regression guards for failures that actually happened on a device:
//  - recognition ends having only ever produced interim results, so nothing
//    triggered a translation and the status label froze on "Đang nghe..."
//  - iOS offers character voices (Grandpa, Fred) next to the real ones, and
//    picking the first non-compact match landed on those
//  - gentle compression measured at under +1 dB, i.e. no louder at all
//
// Run with: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, finish } = require('./helpers');

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');

function el(id, { classes = [], dataset = {}, children = [] } = {}) {
  const listeners = {};
  const classSet = new Set(classes);
  let text = '';
  const node = {
    id,
    dataset,
    children,
    value: '',
    placeholder: '',
    disabled: false,
    hidden: false,
    style: {},
    scrollHeight: 40,
    attributes: {},
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      toggle: (c, on) => (on ? classSet.add(c) : classSet.delete(c)),
      contains: (c) => classSet.has(c),
    },
    setAttribute: (k, v) => { node.attributes[k] = v; },
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    _fire: (ev, arg) => (listeners[ev] || []).forEach((f) => f(arg)),
    querySelectorAll: (sel) => (sel === '.lang-btn'
      ? children.filter((c) => c.classList.contains('lang-btn'))
      : []),
    closest: (sel) => (sel === '.lang-btn' && classSet.has('lang-btn') ? node : null),
    // Only the history list builds children dynamically rather than declaring
    // them up front via the `children` option above.
    appendChild: (child) => { node.children.push(child); return child; },
  };
  Object.defineProperty(node, 'textContent', {
    get: () => text,
    // renderHistoryList() clears the list by assigning '' before rebuilding
    // it -- mirror the real DOM's behaviour of that also dropping children.
    set: (v) => { text = v; if (v === '') node.children.length = 0; },
  });
  return node;
}

function fakeAudioContext(record) {
  const node = (kind, extra = {}) => Object.assign({
    kind,
    connect(target) { return target; },
  }, extra);

  return class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.destination = node('destination');
      record.ctx = this;
    }
    resume() { this.state = 'running'; record.resumed = true; }
    createBufferSource() {
      const source = node('source', {
        buffer: null,
        start() { record.started.push(this); },
        stop() { this.stopped = true; },
      });
      return source;
    }
    createGain() {
      const gain = node('gain', { gain: { value: 1 } });
      record.gains.push(gain);
      return gain;
    }
    createDynamicsCompressor() {
      const c = node('compressor', {
        threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
        attack: { value: 0 }, release: { value: 0 },
      });
      record.compressors.push(c);
      return c;
    }
    decodeAudioData() {
      record.decoded.push(true);
      // Peak 0.25 so the normalising gain has something to compute from.
      return Promise.resolve({
        numberOfChannels: 1,
        getChannelData: () => new Float32Array([0, 0.25, -0.1]),
      });
    }
  };
}

const DEFAULT_VOICES = [
  { name: 'Grandpa', voiceURI: 'com.apple.voice.super-compact.en-US.Grandpa', lang: 'en-US' },
  { name: 'Fred', voiceURI: 'com.apple.speech.synthesis.voice.Fred', lang: 'en-US' },
  { name: 'Samantha (Compact)', voiceURI: 'com.apple.voice.compact.en-US.Samantha', lang: 'en-US', default: true },
  { name: 'Samantha', voiceURI: 'com.apple.voice.enhanced.en-US.Samantha', lang: 'en-US' },
  { name: 'Grandma', voiceURI: 'com.apple.voice.super-compact.ja-JP.Grandma', lang: 'ja-JP' },
  { name: 'Kyoko (Compact)', voiceURI: 'com.apple.voice.compact.ja-JP.Kyoko', lang: 'ja-JP' },
  { name: 'Hattori', voiceURI: 'com.apple.voice.premium.ja-JP.Hattori', lang: 'ja-JP' },
  { name: 'Linh', voiceURI: 'com.apple.voice.enhanced.vi-VN.Linh', lang: 'vi-VN' },
];

function loadApp({
  voices = DEFAULT_VOICES, audio = null, storedLang = null, ttsStatus = 200,
  translateFail = null, throwOnStorageWrite = false, storedHistory = null,
} = {}) {
  const langButtons = ['vi', 'en', 'ja'].map((lang) =>
    el(`lang-${lang}`, { classes: ['lang-btn'], dataset: { lang } }));

  const els = {
    micBtn: el('micBtn'),
    micStatus: el('micStatus'),
    subtitle: el('subtitle'),
    langSwitch: el('langSwitch', { children: langButtons }),
    sourceText: el('sourceText'),
    retranslateBtn: el('retranslateBtn'),
    errorMsg: el('errorMsg'),
    targetLabel0: el('targetLabel0'),
    targetLabel1: el('targetLabel1'),
    targetText0: el('targetText0'),
    targetText1: el('targetText1'),
    speakBtn0: el('speakBtn0'),
    speakBtn1: el('speakBtn1'),
    historyBtn: el('historyBtn'),
    historySheet: el('historySheet', { classes: [], dataset: {} }),
    historyList: el('historyList'),
    historyEmpty: el('historyEmpty'),
    historyClearBtn: el('historyClearBtn'),
    historyCloseBtn: el('historyCloseBtn'),
  };

  const fetchCalls = [];
  const spoken = [];
  const stored = new Map();
  if (storedLang) stored.set('duolang.sourceLang', storedLang);
  if (storedHistory) stored.set('duolang.history', JSON.stringify(storedHistory));
  const state = { recognition: null };

  class FakeRecognition {
    constructor() {
      this._l = {};
      state.recognition = this;
      this.started = false;
    }
    addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn); }
    fire(ev, arg) { (this._l[ev] || []).forEach((f) => f(arg)); }
    start() { this.started = true; this.fire('start'); }
    stop() { this.started = false; this.fire('end'); }
  }

  const translationsByLang = { vi: 'Xin chào', en: 'Hello there', ja: 'こんにちは' };

  const historyState = { pushed: 0 };
  const sandbox = {
    // addEventListener is a no-op: the Escape-key handler it registers is not
    // exercised here, unlike the click-driven paths below, which the el()
    // stub's own addEventListener/_fire handle.
    document: {
      getElementById: (id) => els[id] || el(id),
      addEventListener() {},
      // renderHistoryList() builds rows dynamically; el() already provides
      // everything a created node needs (textContent, appendChild, classList,
      // addEventListener), so reuse it rather than a second stub shape.
      createElement: (tag) => el(tag),
    },
    window: {
      SpeechRecognition: FakeRecognition,
      speechSynthesis: {
        cancel() {},
        speak(u) { spoken.push(u); },
        getVoices: () => voices,
        addEventListener() {},
      },
      addEventListener() {},
    },
    localStorage: {
      getItem: (k) => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => {
        if (throwOnStorageWrite) throw new Error('QuotaExceededError');
        stored.set(k, v);
      },
    },
    // Real pushState/back would navigate the vm context nowhere in particular;
    // just count them so a test can assert the sheet opened/closed pushed and
    // popped a history entry, matching the Android-back-button contract.
    history: {
      pushState: () => { historyState.pushed += 1; },
      back: () => { historyState.pushed = Math.max(0, historyState.pushed - 1); },
    },
    navigator: {},
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    // app.js's fetchWithTimeout() needs these; a vm context is an isolated
    // global object and does not inherit the outer Node process's own.
    // setTimeout is capped short: the only thing app.js uses it for is the
    // fetchWithTimeout abort timer, so translateFail: 'hang' below can prove
    // the real abort path fires without the test waiting out the real 12s.
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 50)),
    clearTimeout,
    AbortController,
    fetch: (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      fetchCalls.push({ url, body });
      if (url === '/api/translate' && translateFail === 'reject') {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      if (url === '/api/translate' && translateFail === 'hang') {
        // Never resolves on its own -- only the real AbortSignal, fired by
        // fetchWithTimeout's timer above, ever settles this promise, the same
        // way a genuinely hung fetch() only ever settles via its signal.
        return new Promise((resolve, reject) => {
          if (opts && opts.signal) {
            opts.signal.addEventListener('abort', () => {
              const err = new Error('The user aborted a request.');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }
      if (url === '/api/tts') {
        if (ttsStatus !== 200) {
          return Promise.resolve({
            ok: false,
            status: ttsStatus,
            json: () => Promise.resolve({ error: 'Đã dùng hết hạn mức giọng đọc tháng này.' }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
      }
      const translations = {};
      for (const target of body.targets || []) translations[target] = translationsByLang[target];
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ source: body.source, translations }),
      });
    },
    console,
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.localStorage = sandbox.localStorage;
  if (audio) sandbox.window.AudioContext = fakeAudioContext(audio);

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), sandbox);

  return { els, fetchCalls, spoken, state, stored, langButtons, historyState };
}

function result(transcript, isFinal) {
  return { resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal })] };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const newAudioRecord = () => ({ gains: [], compressors: [], decoded: [], started: [], resumed: false });

async function endsWithoutFinalResult() {
  console.log('\n# recognition ends with only an interim result (mobile)');
  const { els, fetchCalls, state } = loadApp();

  els.micBtn._fire('click');
  check('recognition started', state.recognition && state.recognition.started);
  check('recognition uses the source language', state.recognition.lang === 'vi-VN',
        `lang: ${state.recognition.lang}`);

  state.recognition.fire('result', result('xin chào bạn', false));
  const sourceValue = els.sourceText.value;
  const listeningStatus = els.micStatus.textContent;

  state.recognition.fire('end');
  await tick();

  check('source box filled from interim result', sourceValue === 'xin chào bạn', `got "${sourceValue}"`);
  check('status said listening', listeningStatus === 'Đang nghe...');
  const translateCalls = fetchCalls.filter((c) => c.url === '/api/translate');
  check('translation requested on end', translateCalls.length === 1, `calls: ${translateCalls.length}`);
  if (translateCalls.length) {
    check('sent the interim transcript', translateCalls[0].body.text === 'xin chào bạn');
    check('sent source and both targets',
          translateCalls[0].body.source === 'vi' &&
          translateCalls[0].body.targets.join(',') === 'en,ja',
          JSON.stringify(translateCalls[0].body));
  }
  check('first target filled', els.targetText0.textContent === 'Hello there', `got "${els.targetText0.textContent}"`);
  check('second target filled', els.targetText1.textContent === 'こんにちは');
  check('speak buttons enabled', !els.speakBtn0.disabled && !els.speakBtn1.disabled);
  check('status not stuck on listening', els.micStatus.textContent !== 'Đang nghe...',
        `got "${els.micStatus.textContent}"`);
}

async function noSpeechKeepsItsMessage() {
  console.log('\n# a no-speech error keeps its own message');
  const { els, fetchCalls, state } = loadApp();

  els.micBtn._fire('click');
  state.recognition.fire('error', { error: 'no-speech' });
  state.recognition.fire('end');
  await tick();

  check('nothing translated', fetchCalls.filter((c) => c.url === '/api/translate').length === 0);
  check('error message preserved', els.micStatus.textContent === 'Không nghe thấy gì, thử lại nhé.',
        `got "${els.micStatus.textContent}"`);
}

// The browser's own fetch rejection message is English ("Failed to fetch"),
// which has no business reaching a screen that's otherwise all Vietnamese --
// this is the regression app.js's networkMessage() exists to prevent.
const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

async function networkFailureShowsVietnameseMessage() {
  console.log('\n# a rejected fetch (offline, DNS failure, ...) shows a Vietnamese message, not "Failed to fetch"');
  const { els, state } = loadApp({ translateFail: 'reject' });

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();

  check('an error is shown', !els.errorMsg.hidden);
  check('it is Vietnamese, not the raw browser message', VIETNAMESE.test(els.errorMsg.textContent),
        `got "${els.errorMsg.textContent}"`);
  check('the raw "Failed to fetch" string never reached the screen',
        !/Failed to fetch/i.test(els.errorMsg.textContent), `got "${els.errorMsg.textContent}"`);
  check('status line recovered rather than staying stuck', els.micStatus.textContent === 'Bấm micro và nói tiếng Việt',
        `got "${els.micStatus.textContent}"`);
}

async function hungRequestTimesOutAndRecovers() {
  console.log('\n# a translate call that never answers times out instead of leaving "Đang dịch..." forever');
  const { els, state } = loadApp({ translateFail: 'hang' });

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  // The sandbox's setTimeout above is capped at 50ms, so the real abort
  // timer inside fetchWithTimeout fires almost immediately; a couple of
  // ticks is enough for the abort -> catch -> showError chain to settle.
  await tick();
  await tick();
  await tick();

  check('status line is not stuck on "Đang dịch..."', els.micStatus.textContent !== 'Đang dịch...',
        `got "${els.micStatus.textContent}"`);
  check('an error is shown', !els.errorMsg.hidden);
  check('the timeout message is Vietnamese', VIETNAMESE.test(els.errorMsg.textContent),
        `got "${els.errorMsg.textContent}"`);
}

async function historyRecordsACompletedTranslation() {
  console.log('\n# a completed translation is recorded in history');
  const { els, state, stored, historyState } = loadApp();

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();

  const saved = JSON.parse(stored.get('duolang.history') || '[]');
  check('one entry recorded', saved.length === 1, `length: ${saved.length}`);
  check('entry has the source text and language', saved[0] && saved[0].text === 'xin chào bạn' && saved[0].source === 'vi',
        JSON.stringify(saved[0]));
  check('entry has both translations', saved[0] && saved[0].tr.en === 'Hello there' && saved[0].tr.ja === 'こんにちは',
        JSON.stringify(saved[0] && saved[0].tr));
  check('nothing opened the sheet (no pushState) just from translating', historyState.pushed === 0,
        historyState.pushed);
}

async function historyDoesNotDuplicateARepeatInANewSession() {
  console.log('\n# the same sentence translated again in a new session does not add a duplicate row');
  // A fresh loadApp() is a fresh session: translationCache starts empty, so
  // this goes through the real fetch path again rather than the client-cache
  // early-return in translate() -- exactly the case addHistoryEntry's
  // dedupe-against-the-newest-entry exists for.
  const existing = [{ at: 1000, source: 'vi', text: 'xin chào bạn', tr: { en: 'Hello there', ja: 'こんにちは' } }];
  const { els, state, stored } = loadApp({ storedHistory: existing });

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();

  const saved = JSON.parse(stored.get('duolang.history') || '[]');
  check('still exactly one entry, not two', saved.length === 1, `length: ${saved.length}`);
}

async function historyEvictsTheOldestEntryPastFifty() {
  console.log('\n# the 51st entry evicts the oldest, not a random one');
  // Newest-first, matching how addHistoryEntry stores them (unshift): index 0
  // is "câu số 49" (the most recent of the 50 already saved), index 49 is
  // "câu số 0" (the oldest), which a 51st entry should push out.
  const existing = [];
  for (let i = 49; i >= 0; i--) {
    existing.push({ at: i, source: 'vi', text: `câu số ${i}`, tr: { en: 'e', ja: 'j' } });
  }
  const { els, state, stored } = loadApp({ storedHistory: existing });

  els.micBtn._fire('click');
  state.recognition.fire('result', result('câu mới nhất', true));
  await tick();

  const saved = JSON.parse(stored.get('duolang.history') || '[]');
  check('list stays capped at 50', saved.length === 50, `length: ${saved.length}`);
  check('the new entry is newest (first)', saved[0].text === 'câu mới nhất', saved[0].text);
  check('the oldest entry was evicted', !saved.some((e) => e.text === 'câu số 0'));
  check('the second-oldest survives', saved.some((e) => e.text === 'câu số 1'));
}

async function restoringAHistoryEntryNeedsNoNetworkCall() {
  console.log('\n# tapping a history row from a different source language repaints everything with zero network calls');
  const existing = [{
    at: 1000, source: 'en', text: 'Hello world', tr: { vi: 'Xin chào thế giới', ja: 'こんにちは世界' },
  }];
  const { els, fetchCalls, historyState } = loadApp({ storedHistory: existing, storedLang: 'vi' });

  check('starts on Vietnamese', els.langSwitch.children[0].classList.contains('active'));

  els.historyBtn._fire('click');
  check('sheet opened', els.historySheet.hidden === false);
  check('opening pushed a history state (for the Android back button)', historyState.pushed === 1, historyState.pushed);
  check('one row rendered', els.historyList.children.length === 1, `rows: ${els.historyList.children.length}`);

  const row = els.historyList.children[0].children[0]; // <li><button class="history-row">
  row._fire('click');

  check('source switched to English', els.langSwitch.children[1].classList.contains('active'));
  check('source text restored', els.sourceText.value === 'Hello world', els.sourceText.value);
  check('first pane filled (Vietnamese)', els.targetText0.textContent === 'Xin chào thế giới', els.targetText0.textContent);
  check('second pane filled (Japanese)', els.targetText1.textContent === 'こんにちは世界', els.targetText1.textContent);
  check('both speak buttons enabled', !els.speakBtn0.disabled && !els.speakBtn1.disabled);
  check('sheet closed after restoring', els.historySheet.hidden === true);
  check('closing popped the pushed history state', historyState.pushed === 0, historyState.pushed);
  check('no network call was made to restore it', fetchCalls.length === 0, `calls: ${fetchCalls.length}`);
}

async function historyClearRemovesEverything() {
  console.log('\n# "Xoá hết" empties the list and shows the empty state');
  const existing = [{ at: 1, source: 'vi', text: 'một câu', tr: { en: 'e', ja: 'j' } }];
  const { els, stored } = loadApp({ storedHistory: existing });

  els.historyBtn._fire('click');
  check('one row before clearing', els.historyList.children.length === 1);

  els.historyClearBtn._fire('click');

  check('list empties in storage', (stored.get('duolang.history') || '[]') === '[]', stored.get('duolang.history'));
  check('list re-renders empty', els.historyList.children.length === 0, els.historyList.children.length);
  check('empty-state message shown', els.historyEmpty.hidden === false);
}

async function storageWriteFailureDoesNotBreakTranslation() {
  console.log('\n# localStorage throwing (private mode) does not break the translate flow');
  const { els, state } = loadApp({ throwOnStorageWrite: true });

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();

  check('translation still completed despite storage failing',
        els.targetText0.textContent === 'Hello there', els.targetText0.textContent);
  check('no error shown to the user over a storage-only failure', els.errorMsg.hidden);
}

async function switchingSourceLanguage() {
  console.log('\n# switching the source language repoints everything');
  const { els, fetchCalls, state, langButtons, stored } = loadApp();

  check('starts on Vietnamese', els.langSwitch.children[0].classList.contains('active'));
  check('targets start as English and Japanese',
        els.targetLabel0.textContent.includes('English') && els.targetLabel1.textContent.includes('日本語'),
        `${els.targetLabel0.textContent} / ${els.targetLabel1.textContent}`);

  // Switch to Japanese as the spoken language.
  els.langSwitch._fire('click', { target: langButtons[2] });

  check('Japanese button active', langButtons[2].classList.contains('active'));
  check('Vietnamese button no longer active', !langButtons[0].classList.contains('active'));
  check('targets became Vietnamese and English',
        els.targetLabel0.textContent.includes('Tiếng Việt') && els.targetLabel1.textContent.includes('English'),
        `${els.targetLabel0.textContent} / ${els.targetLabel1.textContent}`);
  check('choice persisted', stored.get('duolang.sourceLang') === 'ja', stored.get('duolang.sourceLang'));
  // Without a per-pane lang attribute, a screen reader narrates every
  // language in whatever voice its own UI is set to.
  check('source textarea lang follows the spoken language', els.sourceText.lang === 'ja-JP', els.sourceText.lang);
  check('first pane lang matches its (new) language', els.targetText0.lang === 'vi-VN', els.targetText0.lang);
  check('second pane lang matches its (new) language', els.targetText1.lang === 'en-US', els.targetText1.lang);

  els.micBtn._fire('click');
  check('recognition switched language', state.recognition.lang === 'ja-JP', `lang: ${state.recognition.lang}`);

  state.recognition.fire('result', result('お手洗いはどこですか', true));
  await tick();

  const call = fetchCalls.filter((c) => c.url === '/api/translate').pop();
  check('translate called with Japanese source', call && call.body.source === 'ja', JSON.stringify(call && call.body));
  check('targets are the other two', call && call.body.targets.join(',') === 'vi,en',
        call && call.body.targets.join(','));
  check('Vietnamese pane filled', els.targetText0.textContent === 'Xin chào', `got "${els.targetText0.textContent}"`);
}

async function restoresStoredSourceLanguage() {
  console.log('\n# the previous source language is restored on load');
  const { els, langButtons } = loadApp({ storedLang: 'en' });

  check('English button active', langButtons[1].classList.contains('active'));
  check('targets are Vietnamese and Japanese',
        els.targetLabel0.textContent.includes('Tiếng Việt') && els.targetLabel1.textContent.includes('日本語'),
        `${els.targetLabel0.textContent} / ${els.targetLabel1.textContent}`);
  check('prompt mentions English', els.micStatus.textContent.includes('Anh'), els.micStatus.textContent);
}

async function editingSourceText() {
  console.log('\n# the source text can be corrected and retranslated');
  const { els, fetchCalls, state } = loadApp();

  check('retranslate disabled while empty', els.retranslateBtn.disabled === true);

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();

  check('retranslate disabled right after translating', els.retranslateBtn.disabled === true,
        'text matches what was translated');

  // STT misheard: the user fixes the text by hand.
  els.sourceText.value = 'xin chào bạn nhé';
  els.sourceText._fire('input');

  check('retranslate enabled once the text differs', els.retranslateBtn.disabled === false);

  const before = fetchCalls.filter((c) => c.url === '/api/translate').length;
  els.retranslateBtn._fire('click');
  await tick();

  const calls = fetchCalls.filter((c) => c.url === '/api/translate');
  check('retranslated', calls.length === before + 1, `${before} -> ${calls.length}`);
  check('sent the corrected text', calls[calls.length - 1].body.text === 'xin chào bạn nhé',
        calls[calls.length - 1].body.text);
  check('retranslate disabled again afterwards', els.retranslateBtn.disabled === true);
}

async function repeatedSentenceIsNotRefetched() {
  console.log('\n# a sentence already translated is shown without a round trip');
  const { els, fetchCalls, state } = loadApp();

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();
  const first = fetchCalls.filter((c) => c.url === '/api/translate').length;
  check('translated once', first === 1, `calls: ${first}`);

  // Say the same thing again.
  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();

  const after = fetchCalls.filter((c) => c.url === '/api/translate').length;
  check('no second request for the same sentence', after === first, `${first} -> ${after}`);
  check('panes still filled from cache', els.targetText0.textContent === 'Hello there',
        `got "${els.targetText0.textContent}"`);
  check('speak buttons re-enabled', !els.speakBtn0.disabled && !els.speakBtn1.disabled);
  check('status back to idle', els.micStatus.textContent !== 'Đang dịch...', els.micStatus.textContent);
}

async function switchingSourceRefetches() {
  console.log('\n# the cache is per language pair, not per sentence alone');
  const { els, fetchCalls, state, langButtons } = loadApp();

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();
  const before = fetchCalls.filter((c) => c.url === '/api/translate').length;

  // Same text, but now treated as English rather than Vietnamese.
  els.langSwitch._fire('click', { target: langButtons[1] });
  els.sourceText.value = 'xin chào bạn';
  els.sourceText._fire('input');
  els.retranslateBtn._fire('click');
  await tick();

  const after = fetchCalls.filter((c) => c.url === '/api/translate').length;
  check('refetched for the new source language', after === before + 1, `${before} -> ${after}`);
  const last = fetchCalls.filter((c) => c.url === '/api/translate').pop();
  check('asked with the new source', last.body.source === 'en', JSON.stringify(last.body));
}

async function ttsPicksBestVoiceAndGain() {
  console.log('\n# TTS: best device voice as fallback, real gain on the server path');
  const audio = newAudioRecord();
  const { els, fetchCalls, state } = loadApp({ audio });

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();
  els.speakBtn0._fire('click');
  els.speakBtn1._fire('click');
  await tick();

  const ttsCalls = fetchCalls.filter((c) => c.url === '/api/tts');
  check('synthesis requested per language', ttsCalls.length === 2, `tts calls: ${ttsCalls.length}`);
  if (ttsCalls.length === 2) {
    check('English request well formed', ttsCalls[0].body.lang === 'en' && ttsCalls[0].body.text === 'Hello there',
          JSON.stringify(ttsCalls[0].body));
    check('Japanese request well formed', ttsCalls[1].body.lang === 'ja' && ttsCalls[1].body.text === 'こんにちは',
          JSON.stringify(ttsCalls[1].body));
  }
  check('audio context resumed inside the gesture', audio.resumed === true);
  check('audio started for both', audio.started.length === 2, `starts: ${audio.started.length}`);

  const gains = audio.gains.map((g) => g.gain.value);
  check('normalising gain lifts the quiet clip', gains.some((v) => v > 3.5 && v < 4.5), `gains: ${gains.join(', ')}`);
  check('make-up gain above unity', gains.some((v) => v === 3), `gains: ${gains.join(', ')}`);
  check('limiting, not gentle compression',
        audio.compressors.every((c) => c.ratio.value >= 20 && c.threshold.value === -12),
        audio.compressors.map((c) => `t=${c.threshold.value} r=${c.ratio.value}`).join(', '));
  check('no spinner left behind',
        !els.speakBtn0.classList.contains('loading') && !els.speakBtn1.classList.contains('loading'));
}

async function ttsCachesPerSentence() {
  console.log('\n# replaying a sentence spends no extra request');
  const audio = newAudioRecord();
  const { els, fetchCalls, state } = loadApp({ audio });

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();
  els.speakBtn0._fire('click');
  await tick();

  const before = fetchCalls.filter((c) => c.url === '/api/tts').length;
  els.speakBtn0._fire('click');
  await tick();
  const after = fetchCalls.filter((c) => c.url === '/api/tts').length;

  check('no new synthesis request', after === before, `${before} -> ${after}`);
  check('but it played again', audio.started.length === 2, `starts: ${audio.started.length}`);
}

async function quotaExhaustedFallsBack() {
  console.log('\n# a 429 falls back to the device voice and says so');
  const audio = newAudioRecord();
  const { els, spoken, state } = loadApp({ audio, ttsStatus: 429 });

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();
  els.speakBtn0._fire('click');
  await tick();

  check('device voice used instead', spoken.length === 1, `utterances: ${spoken.length}`);
  check('spoke the translation', spoken.length && spoken[0].text === 'Hello there');
  check('showed the reason the server gave',
        els.errorMsg.hidden === false && /hạn mức/i.test(els.errorMsg.textContent),
        els.errorMsg.textContent);
  check('English avoided the character voices',
        spoken.length && spoken[0].voice && !/grandpa|fred/i.test(spoken[0].voice.name),
        spoken.length && spoken[0].voice && spoken[0].voice.name);
}

async function withoutWebAudioUsesDeviceVoice() {
  console.log('\n# without Web Audio it uses the device voice directly');
  const { els, fetchCalls, spoken, state } = loadApp();

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();
  els.speakBtn1._fire('click');
  await tick();

  check('no synthesis requests', fetchCalls.filter((c) => c.url === '/api/tts').length === 0);
  check('device voice used', spoken.length === 1, `utterances: ${spoken.length}`);
  check('Japanese avoided Grandma',
        spoken.length && spoken[0].voice && spoken[0].voice.name === 'Hattori',
        spoken.length && spoken[0].voice && spoken[0].voice.name);
}

(async () => {
  await endsWithoutFinalResult();
  await noSpeechKeepsItsMessage();
  await networkFailureShowsVietnameseMessage();
  await hungRequestTimesOutAndRecovers();
  await switchingSourceLanguage();
  await restoresStoredSourceLanguage();
  await editingSourceText();
  await repeatedSentenceIsNotRefetched();
  await switchingSourceRefetches();
  await ttsPicksBestVoiceAndGain();
  await ttsCachesPerSentence();
  await quotaExhaustedFallsBack();
  await withoutWebAudioUsesDeviceVoice();
  await historyRecordsACompletedTranslation();
  await historyDoesNotDuplicateARepeatInANewSession();
  await historyEvictsTheOldestEntryPastFifty();
  await restoringAHistoryEntryNeedsNoNetworkCall();
  await historyClearRemovesEverything();
  await storageWriteFailureDoesNotBreakTranslation();

  finish();
})();
