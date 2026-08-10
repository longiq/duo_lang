// Drives public/app.js against a stubbed DOM + SpeechRecognition.
//
// Regression guard for the mobile failure mode: recognition delivers only
// interim results and then ends without ever marking one final. The Vietnamese
// text appeared but nothing triggered a translation, and the status label stayed
// frozen on "Đang nghe...".
//
// Run with: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');

function el(id) {
  const listeners = {};
  const classes = new Set();
  return {
    id,
    textContent: '',
    disabled: false,
    hidden: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    _fire: (ev, arg) => (listeners[ev] || []).forEach((f) => f(arg)),
  };
}

// Minimal Web Audio stub that records the graph the app builds.
function fakeAudioContext(record) {
  const node = (kind, extra = {}) => Object.assign({
    kind,
    connectedTo: null,
    connect(target) { this.connectedTo = target; return target; },
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
        started: false,
        start() { this.started = true; record.started.push(this); },
        stop() { this.stopped = true; },
      });
      record.sources.push(source);
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
    decodeAudioData(bytes) {
      record.decoded.push(bytes);
      // Peak of 0.25 so the normalising gain has something to compute from.
      return Promise.resolve({
        numberOfChannels: 1,
        getChannelData: () => new Float32Array([0, 0.25, -0.1]),
      });
    }
  };
}

function loadApp(overrideVoices, audioRecord) {
  const ids = ['micBtn', 'micStatus', 'vietnameseText', 'englishText', 'japaneseText',
               'speakEnBtn', 'speakJaBtn', 'errorMsg'];
  const els = {};
  ids.forEach((i) => { els[i] = el(i); });

  const fetchCalls = [];
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

  const spoken = [];
  // Mirrors what iOS 17 actually offers: character voices and legacy novelty
  // voices sit in the same list as the real ones, and Grandpa comes first.
  const availableVoices = overrideVoices || [
    { name: 'Grandpa', voiceURI: 'com.apple.voice.super-compact.en-US.Grandpa', lang: 'en-US' },
    { name: 'Fred', voiceURI: 'com.apple.speech.synthesis.voice.Fred', lang: 'en-US' },
    { name: 'Samantha (Compact)', voiceURI: 'com.apple.voice.compact.en-US.Samantha', lang: 'en-US', default: true },
    { name: 'Samantha', voiceURI: 'com.apple.voice.enhanced.en-US.Samantha', lang: 'en-US' },
    { name: 'Grandma', voiceURI: 'com.apple.voice.super-compact.ja-JP.Grandma', lang: 'ja-JP' },
    { name: 'Kyoko (Compact)', voiceURI: 'com.apple.voice.compact.ja-JP.Kyoko', lang: 'ja-JP' },
    { name: 'Hattori', voiceURI: 'com.apple.voice.premium.ja-JP.Hattori', lang: 'ja-JP' },
  ];

  const sandbox = {
    document: { getElementById: (id) => els[id] || el(id) },
    window: {
      SpeechRecognition: FakeRecognition,
      speechSynthesis: {
        cancel() {},
        speak(u) { spoken.push(u); },
        getVoices: () => availableVoices,
        addEventListener() {},
      },
      addEventListener() {},
    },
    navigator: {},
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    fetch: (url, opts) => {
      fetchCalls.push({ url, body: opts && opts.body });
      if (url === '/api/tts') {
        return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ en: 'Hello there', ja: 'こんにちは' }),
      });
    },
    console,
  };
  if (audioRecord) {
    sandbox.window.AudioContext = fakeAudioContext(audioRecord);
  }
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), sandbox);

  return { els, fetchCalls, state, spoken };
}

function result(transcript, isFinal) {
  return {
    resultIndex: 0,
    results: [Object.assign([{ transcript }], { isFinal })],
  };
}

const failures = [];
function check(name, cond, detail) {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' -- ' + detail : ''}`;
  console.log(line);
  if (!cond) failures.push(name);
}

async function tick() {
  await new Promise((r) => setTimeout(r, 20));
}

async function endsWithoutFinalResult() {
  console.log('\n# recognition ends with only an interim result (mobile)');
  const { els, fetchCalls, state } = loadApp();

  els.micBtn._fire('click');
  check('recognition started', state.recognition && state.recognition.started);

  state.recognition.fire('result', result('xin chào bạn', false));
  const vnText = els.vietnameseText.textContent;
  const listeningStatus = els.micStatus.textContent;

  state.recognition.fire('end');
  await tick();

  check('Vietnamese text shown from interim result', vnText === 'xin chào bạn', `got "${vnText}"`);
  check('status said listening during recognition', listeningStatus === 'Đang nghe...');
  check('translation was requested on end', fetchCalls.length === 1, `fetch calls: ${fetchCalls.length}`);
  if (fetchCalls.length) {
    check('sent the interim transcript', JSON.parse(fetchCalls[0].body).text === 'xin chào bạn');
    check('hit /api/translate', fetchCalls[0].url === '/api/translate');
  }
  check('English filled in', els.englishText.textContent === 'Hello there', `got "${els.englishText.textContent}"`);
  check('Japanese filled in', els.japaneseText.textContent === 'こんにちは');
  check('speak buttons enabled', !els.speakEnBtn.disabled && !els.speakJaBtn.disabled);
  check('status not stuck on listening', els.micStatus.textContent !== 'Đang nghe...',
        `got "${els.micStatus.textContent}"`);
}

async function finalResultTranslatesOnce() {
  console.log('\n# a final result translates exactly once');
  const { els, fetchCalls, state } = loadApp();

  els.micBtn._fire('click');
  state.recognition.fire('result', result('xin chào bạn', true));
  await tick();
  state.recognition.fire('end');
  await tick();

  check('translated once, not twice', fetchCalls.length === 1, `fetch calls: ${fetchCalls.length}`);
  check('English filled in', els.englishText.textContent === 'Hello there');
}

async function noSpeechKeepsItsMessage() {
  console.log('\n# a no-speech error keeps its own message');
  const { els, fetchCalls, state } = loadApp();

  els.micBtn._fire('click');
  state.recognition.fire('error', { error: 'no-speech' });
  state.recognition.fire('end');
  await tick();

  check('nothing translated', fetchCalls.length === 0, `fetch calls: ${fetchCalls.length}`);
  check('error message preserved', els.micStatus.textContent === 'Không nghe thấy gì, thử lại nhé.',
        `got "${els.micStatus.textContent}"`);
}

async function speakBoth(voiceList, audioRecord) {
  const app = loadApp(voiceList, audioRecord);
  app.els.micBtn._fire('click');
  app.state.recognition.fire('result', result('xin chào bạn', true));
  await tick();
  app.els.speakEnBtn._fire('click');
  app.els.speakJaBtn._fire('click');
  return app;
}

async function ttsPicksBestVoice() {
  console.log('\n# TTS picks the best voice, never a character voice');
  const { spoken } = await speakBoth();

  check('both languages spoken', spoken.length === 2, `utterances: ${spoken.length}`);
  if (spoken.length === 2) {
    const [en, ja] = spoken;
    check('English at full volume', en.volume === 1, `volume: ${en.volume}`);
    check('English is not Grandpa or Fred',
          en.voice && !/grandpa|fred/i.test(en.voice.name), `picked: ${en.voice && en.voice.name}`);
    check('English prefers enhanced over compact',
          en.voice && en.voice.voiceURI.includes('enhanced'), `picked: ${en.voice && en.voice.voiceURI}`);
    check('Japanese is not Grandma',
          ja.voice && !/grandma/i.test(ja.voice.name), `picked: ${ja.voice && ja.voice.name}`);
    check('Japanese prefers premium',
          ja.voice && ja.voice.voiceURI.includes('premium'), `picked: ${ja.voice && ja.voice.voiceURI}`);
    check('Japanese spoke the translated text', ja.text === 'こんにちは', `got "${ja.text}"`);
  }
}

async function ttsDefersToPlatformWhenOnlyNoveltyVoices() {
  console.log('\n# TTS lets the platform choose when every voice is a novelty one');
  const { spoken } = await speakBoth([
    { name: 'Grandpa', voiceURI: 'com.apple.voice.super-compact.en-US.Grandpa', lang: 'en-US' },
    { name: 'Zarvox', voiceURI: 'com.apple.speech.synthesis.voice.Zarvox', lang: 'en-US' },
  ]);

  check('still spoke', spoken.length === 2, `utterances: ${spoken.length}`);
  if (spoken.length) {
    check('no voice forced', !spoken[0].voice, `voice: ${spoken[0].voice && spoken[0].voice.name}`);
    check('lang still set for the platform to use', spoken[0].lang === 'en-US', `lang: ${spoken[0].lang}`);
  }
}

function newAudioRecord() {
  return { sources: [], gains: [], compressors: [], decoded: [], started: [], resumed: false };
}

async function serverTtsPlaysThroughWebAudio() {
  console.log('\n# server TTS plays through Web Audio with gain above unity');
  const audio = newAudioRecord();
  const { fetchCalls, els } = await speakBoth(undefined, audio);
  await tick();

  const ttsCalls = fetchCalls.filter((c) => c.url === '/api/tts');
  check('requested synthesis for both languages', ttsCalls.length === 2, `tts calls: ${ttsCalls.length}`);
  if (ttsCalls.length === 2) {
    const bodies = ttsCalls.map((c) => JSON.parse(c.body));
    check('English request well formed',
          bodies[0].lang === 'en' && bodies[0].text === 'Hello there', c$(bodies[0]));
    check('Japanese request well formed',
          bodies[1].lang === 'ja' && bodies[1].text === 'こんにちは', c$(bodies[1]));
  }
  check('audio context resumed inside the gesture', audio.resumed === true);
  check('audio actually started', audio.started.length === 2, `starts: ${audio.started.length}`);
  check('decoded the returned wav', audio.decoded.length === 2, `decodes: ${audio.decoded.length}`);

  // peak 0.25 -> normalising gain 0.99/0.25 = 3.96, then a make-up stage.
  const gainValues = audio.gains.map((g) => g.gain.value);
  check('normalising gain lifts the quiet clip', gainValues.some((v) => v > 3.5 && v < 4.5),
        `gains: ${gainValues.join(', ')}`);
  check('make-up gain above unity applied', gainValues.some((v) => v === 1.8),
        `gains: ${gainValues.join(', ')}`);
  check('compressor in the chain', audio.compressors.length === 2);
  check('no loading spinner left behind',
        !els.speakEnBtn.classList.contains('loading') && !els.speakJaBtn.classList.contains('loading'));
}

async function serverTtsCachesPerSentence() {
  console.log('\n# replaying the same sentence spends no extra request');
  const audio = newAudioRecord();
  const app = await speakBoth(undefined, audio);
  await tick();

  const before = app.fetchCalls.filter((c) => c.url === '/api/tts').length;
  app.els.speakEnBtn._fire('click');
  await tick();
  const after = app.fetchCalls.filter((c) => c.url === '/api/tts').length;

  check('no new synthesis request', after === before, `${before} -> ${after}`);
  check('but it played again', audio.started.length === 3, `starts: ${audio.started.length}`);
}

async function fallsBackToDeviceVoiceWithoutWebAudio() {
  console.log('\n# without Web Audio it falls back to the device voice');
  const { spoken, fetchCalls } = await speakBoth();
  await tick();

  check('no synthesis requests', fetchCalls.filter((c) => c.url === '/api/tts').length === 0);
  check('device voice used instead', spoken.length === 2, `utterances: ${spoken.length}`);
}

const c$ = (o) => JSON.stringify(o);

(async () => {
  await endsWithoutFinalResult();
  await finalResultTranslatesOnce();
  await noSpeechKeepsItsMessage();
  await ttsPicksBestVoice();
  await ttsDefersToPlatformWhenOnlyNoveltyVoices();
  await serverTtsPlaysThroughWebAudio();
  await serverTtsCachesPerSentence();
  await fallsBackToDeviceVoiceWithoutWebAudio();

  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
})();
