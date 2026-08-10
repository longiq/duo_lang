// Exercises the monthly character budget that stops the app spending money on
// Cloud TTS, by running the real server against a stubbed synthesis endpoint.
//
// Google's budget alerts only notify, they do not stop spending, so this cap is
// the thing actually standing between the app and a bill.
//
// Run with: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3287;
const BASE = `http://127.0.0.1:${PORT}`;
const usageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'duolang-')), 'usage.json');

const failures = [];
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' -- ' + detail : ''}`);
  if (!cond) failures.push(name);
}

// A local stand-in for texttospeech.googleapis.com so no real quota is spent.
function startFakeGoogle() {
  const http = require('http');
  return new Promise((resolve) => {
    let calls = 0;
    const server = http.createServer((req, res) => {
      calls++;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        // 44-byte WAV header plus a little silence, enough to look like audio.
        const wav = Buffer.alloc(64);
        wav.write('RIFF', 0, 'ascii');
        wav.write('WAVE', 8, 'ascii');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ audioContent: wav.toString('base64') }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls: () => calls }));
  });
}

async function main() {
  const fake = await startFakeGoogle();

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      GEMINI_API_KEY: 'unused-in-this-test',
      GOOGLE_TTS_API_KEY: 'fake-cloud-key',
      TTS_MONTHLY_CHAR_LIMIT: '25',
      TTS_USAGE_FILE: usageFile,
      // Point the Cloud TTS client at the local stand-in.
      CLOUD_TTS_ENDPOINT: `http://127.0.0.1:${fake.port}/v1/text:synthesize`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  // Wait for it to accept connections.
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/tts/usage`);
      break;
    } catch (err) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const tts = (text) => fetch(`${BASE}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, lang: 'en' }),
  });
  const usage = () => fetch(`${BASE}/api/tts/usage`).then((r) => r.json());

  try {
    const start = await usage();
    check('reports Cloud TTS as the provider', start.provider === 'google-cloud-tts', start.provider);
    check('starts with the full allowance', start.remaining === 25, `remaining: ${start.remaining}`);

    // 20 characters, inside the 25 limit.
    const first = await tts('12345678901234567890');
    check('synthesis under the cap succeeds', first.status === 200, `status: ${first.status}`);
    check('returned wav audio', first.headers.get('content-type') === 'audio/wav',
          first.headers.get('content-type'));

    const afterFirst = await usage();
    check('usage counted the characters', afterFirst.charsUsed === 20, `used: ${afterFirst.charsUsed}`);

    // Same text again: served from cache, so it must not add to usage.
    const cached = await tts('12345678901234567890');
    check('replay served from cache', cached.headers.get('x-cache') === 'hit', cached.headers.get('x-cache'));
    const afterCache = await usage();
    check('cache hit spends nothing', afterCache.charsUsed === 20, `used: ${afterCache.charsUsed}`);

    // 10 more characters would exceed the 25-character cap.
    const overflow = await tts('abcdefghij');
    check('request over the cap is refused', overflow.status === 429, `status: ${overflow.status}`);
    const refused = await overflow.json();
    check('refusal explains itself', /hạn mức/i.test(refused.error || ''), refused.error);

    const afterOverflow = await usage();
    check('refused request added no usage', afterOverflow.charsUsed === 20, `used: ${afterOverflow.charsUsed}`);
    check('provider was never called for the refused text', fake.calls() === 1, `upstream calls: ${fake.calls()}`);

    // The counter has to survive a restart, or the cap resets for free.
    const saved = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    check('usage persisted to disk', saved.chars === 20, JSON.stringify(saved));
  } finally {
    child.kill();
    fake.server.close();
  }

  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
