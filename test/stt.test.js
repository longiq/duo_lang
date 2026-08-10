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

function loadApp() {
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

  const sandbox = {
    document: { getElementById: (id) => els[id] || el(id) },
    window: {
      SpeechRecognition: FakeRecognition,
      speechSynthesis: { cancel() {}, speak() {} },
      addEventListener() {},
    },
    navigator: {},
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    fetch: (url, opts) => {
      fetchCalls.push({ url, body: opts && opts.body });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ en: 'Hello there', ja: 'こんにちは' }),
      });
    },
    console,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), sandbox);

  return { els, fetchCalls, state };
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

(async () => {
  await endsWithoutFinalResult();
  await finalResultTranslatesOnce();
  await noSpeechKeepsItsMessage();

  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
})();
