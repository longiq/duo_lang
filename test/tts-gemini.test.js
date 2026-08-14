// Exercises synthesiseWithGemini(), the TTS fallback path that runs whenever
// GOOGLE_TTS_API_KEY is absent -- currently the only untested provider, since
// budget.test.js exercises Cloud TTS exclusively.
//
// Run with: npm test
const { check, finish, startServer, waitForServer } = require('./helpers');

const PORT = 3289;
const BASE = `http://127.0.0.1:${PORT}`;

// Real diacritics only -- lets every check below assert "this string is
// actually Vietnamese", locking in the Phase 1 all-Vietnamese-errors rule.
const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

// A local stand-in for generativelanguage.googleapis.com's TTS models. `queue`
// is consumed one item per request, in order, so a test can script exactly
// what each model in the cascade answers.
function startFakeGemini(queue) {
  const http = require('http');
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      req.on('data', () => {});
      req.on('end', () => {
        const item = queue.shift() || { status: 200 };
        if (item.status !== 200) {
          res.writeHead(item.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: item.status, message: item.message || 'stub error' } }));
          return;
        }
        const parts = item.noInlineData
          ? [{ text: 'the model answered the prompt instead of reading it' }]
          : [{ inlineData: { mimeType: item.mimeType, data: (item.pcm || Buffer.from([0, 0])).toString('base64') } }];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { parts } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

function bootServer(fake, extraEnv = {}) {
  return startServer({
    PORT: String(PORT),
    HOST: '127.0.0.1',
    GEMINI_API_KEY: 'fake-key',
    GEMINI_ENDPOINT_BASE: `http://127.0.0.1:${fake.port}/v1beta/models`,
    // No GOOGLE_TTS_API_KEY: forces the Gemini TTS branch of /api/tts.
    ...extraEnv,
  });
}

const tts = (text, lang = 'en') => fetch(`${BASE}/api/tts`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, lang }),
});

async function basicSynthesisAndCache() {
  console.log('\n# a successful Gemini TTS call is wrapped as WAV and then cached');
  const fake = await startFakeGemini([
    { status: 200, pcm: Buffer.from([1, 2, 3, 4]), mimeType: 'audio/L16;codec=pcm;rate=16000' },
  ]);
  const child = bootServer(fake, { GEMINI_TTS_MODELS: 'model-a' });
  await waitForServer(`${BASE}/api/tts/usage`);

  try {
    const res = await tts('xin chào');
    check('responds with wav audio', res.headers.get('content-type') === 'audio/wav', res.headers.get('content-type'));
    check('tier header names gemini', res.headers.get('x-tts-tier') === 'gemini', res.headers.get('x-tts-tier'));
    check('reported as a miss', res.headers.get('x-cache') === 'miss', res.headers.get('x-cache'));

    const buf = Buffer.from(await res.arrayBuffer());
    check('the mime type\'s sample rate reaches the WAV header, not the 24000 default',
          buf.readUInt32LE(24) === 16000, `got ${buf.readUInt32LE(24)}`);
    check('asked model-a', fake.requests[0].includes('model-a'), fake.requests[0]);

    const replay = await tts('xin chào');
    check('replay is served from cache', replay.headers.get('x-cache') === 'hit', replay.headers.get('x-cache'));
    check('replay made no new upstream call', fake.requests.length === 1, `requests: ${fake.requests.length}`);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function modelFallbackOn429() {
  console.log('\n# a 429 from one Gemini TTS model falls through to the next');
  const fake = await startFakeGemini([
    { status: 429 },
    { status: 200, pcm: Buffer.from([9, 9]), mimeType: 'audio/L16;rate=24000' },
  ]);
  const child = bootServer(fake, { GEMINI_TTS_MODELS: 'model-a,model-b' });
  await waitForServer(`${BASE}/api/tts/usage`);

  try {
    const res = await tts('câu khác');
    check('eventually succeeds', res.status === 200, `status: ${res.status}`);
    check('two models were tried', fake.requests.length === 2, `requests: ${fake.requests.length}`);
    check('model-a asked first', fake.requests[0].includes('model-a'), fake.requests[0]);
    check('model-b asked second', fake.requests[1].includes('model-b'), fake.requests[1]);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function nonQuotaErrorStopsCascade() {
  console.log('\n# a non-429 error is not worth retrying on another model');
  const fake = await startFakeGemini([{ status: 400 }]);
  const child = bootServer(fake, { GEMINI_TTS_MODELS: 'model-a,model-b' });
  await waitForServer(`${BASE}/api/tts/usage`);

  try {
    const res = await tts('câu ba');
    check('client sees a 502', res.status === 502, `status: ${res.status}`);
    const body = await res.json();
    check('error is Vietnamese', VIETNAMESE.test(body.error || ''), body.error);
    check('model-b was never asked', fake.requests.length === 1, `requests: ${fake.requests.length}`);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function missingInlineDataIsHandled() {
  console.log('\n# a response with parts but no audio is a clean 502, not a crash');
  const fake = await startFakeGemini([{ status: 200, noInlineData: true }]);
  const child = bootServer(fake, { GEMINI_TTS_MODELS: 'model-a' });
  await waitForServer(`${BASE}/api/tts/usage`);

  try {
    const res = await tts('câu bốn');
    check('client sees a 502, not a hang or 500', res.status === 502, `status: ${res.status}`);
    const body = await res.json();
    check('error is Vietnamese', VIETNAMESE.test(body.error || ''), body.error);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function validationChecks() {
  console.log('\n# /api/tts validation: length cap, unsupported language');
  const fake = await startFakeGemini([]);
  const child = bootServer(fake, { GEMINI_TTS_MODELS: 'model-a' });
  await waitForServer(`${BASE}/api/tts/usage`);

  try {
    const tooLong = await tts('a'.repeat(601));
    check('over the length cap is 413', tooLong.status === 413, `status: ${tooLong.status}`);
    const tooLongBody = await tooLong.json();
    check('length error is Vietnamese', VIETNAMESE.test(tooLongBody.error || ''), tooLongBody.error);

    const badLang = await tts('hello', 'de');
    check('unsupported language is 400', badLang.status === 400, `status: ${badLang.status}`);
    const badLangBody = await badLang.json();
    check('language error is Vietnamese', VIETNAMESE.test(badLangBody.error || ''), badLangBody.error);

    check('nothing reached the upstream stub', fake.requests.length === 0, `requests: ${fake.requests.length}`);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function noCredentialsIs500() {
  console.log('\n# no speech credentials at all is a clear 500, not a silent failure');
  const child = startServer({
    PORT: String(PORT),
    HOST: '127.0.0.1',
    // Explicitly blanked, not just omitted: dotenv.config() does not override
    // a variable already present in the environment, so if the shell running
    // this test happened to export a real key, omitting it here would leak
    // straight through to a real API call.
    GEMINI_API_KEY: '',
    GOOGLE_TTS_API_KEY: '',
  });
  await waitForServer(`${BASE}/api/tts/usage`);

  try {
    const res = await tts('anything');
    check('server reports 500', res.status === 500, `status: ${res.status}`);
    const body = await res.json();
    check('error is Vietnamese', VIETNAMESE.test(body.error || ''), body.error);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  await basicSynthesisAndCache();
  await modelFallbackOn429();
  await nonQuotaErrorStopsCascade();
  await missingInlineDataIsHandled();
  await validationChecks();
  await noCredentialsIs500();

  finish();
}

main().catch((err) => { console.error(err); process.exit(1); });
