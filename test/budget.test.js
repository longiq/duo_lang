// Exercises the monthly character budget that stops the app spending money on
// Cloud TTS, by running the real server against a stubbed synthesis endpoint.
//
// Google's budget alerts only notify, they do not stop spending, so this cap is
// the thing actually standing between the app and a bill.
//
// Run with: npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, finish, startServer: spawnServer, waitForServer: pollServer } = require('./helpers');

const PORT = 3287;
const BASE = `http://127.0.0.1:${PORT}`;
const usageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'duolang-')), 'usage.json');

// A local stand-in for texttospeech.googleapis.com so no real quota is spent.
// `quotaOut` names tiers it should answer with 429, imitating Google's own
// per-tier quota running out before our cap does. `delayMs` holds the response
// open, which is what actually gives a race between two concurrent requests
// something to race during -- see concurrentRequestsDoNotOvershootBudget().
function startFakeGoogle(quotaOut = new Set(), delayMs = 0) {
  const http = require('http');
  return new Promise((resolve) => {
    const voicesAsked = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const voice = (JSON.parse(body || '{}').voice || {}).name || '';
        voicesAsked.push(voice);
        const respond = () => {
          const tier = [...quotaOut].find((t) => voice.includes(t));
          if (tier) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 429, message: `Quota exceeded for ${tier}` } }));
            return;
          }
          // 44-byte WAV header plus a little silence, enough to look like audio.
          const wav = Buffer.alloc(64);
          wav.write('RIFF', 0, 'ascii');
          wav.write('WAVE', 8, 'ascii');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ audioContent: wav.toString('base64') }));
        };
        if (delayMs) setTimeout(respond, delayMs);
        else respond();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      voicesAsked,
      calls: () => voicesAsked.length,
    }));
  });
}

function startServer(fake, extraEnv = {}) {
  return spawnServer({
    PORT: String(PORT),
    HOST: '127.0.0.1',
    GEMINI_API_KEY: 'unused-in-this-test',
    GOOGLE_TTS_API_KEY: 'fake-cloud-key',
    TTS_USAGE_FILE: usageFile,
    // Point the Cloud TTS client at the local stand-in.
    CLOUD_TTS_ENDPOINT: `http://127.0.0.1:${fake.port}/v1/text:synthesize`,
    ...extraEnv,
  });
}

const waitForServer = () => pollServer(`${BASE}/api/tts/usage`);

const tts = (text) => fetch(`${BASE}/api/tts`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, lang: 'en' }),
});
const usage = () => fetch(`${BASE}/api/tts/usage`).then((r) => r.json());
const tierOf = (u, name) => u.tiers.find((t) => t.tier === name);

async function budgetCascade() {
  console.log('\n# spending works down the tiers, then refuses');
  fs.rmSync(usageFile, { force: true });
  const fake = await startFakeGoogle();
  // Tiny per-tier budgets: 20 chars for the top tier, 30 for the next.
  const child = startServer(fake, {
    TTS_TIER_ORDER: 'Chirp3-HD,Neural2',
    TTS_BUDGET_CHIRP3_HD: '20',
    TTS_BUDGET_NEURAL2: '30',
  });
  await waitForServer();

  try {
    const start = await usage();
    check('reports Cloud TTS as the provider', start.provider === 'google-cloud-tts', start.provider);
    check('budgets are per tier', tierOf(start, 'Chirp3-HD').budget === 20 && tierOf(start, 'Neural2').budget === 30,
          JSON.stringify(start.tiers.map((t) => `${t.tier}:${t.budget}`)));
    check('total budget adds the tiers up', start.totalBudget === 50, `total: ${start.totalBudget}`);

    // 20 chars: fits the top tier exactly.
    const first = await tts('12345678901234567890');
    check('served by the best tier', first.headers.get('x-tts-tier') === 'Chirp3-HD', first.headers.get('x-tts-tier'));
    check('returned wav audio', first.headers.get('content-type') === 'audio/wav', first.headers.get('content-type'));
    check('asked Google for the Chirp3-HD voice', /Chirp3-HD/.test(fake.voicesAsked[0]), fake.voicesAsked[0]);

    const afterFirst = await usage();
    check('charged to the tier that served it', tierOf(afterFirst, 'Chirp3-HD').used === 20,
          `used: ${tierOf(afterFirst, 'Chirp3-HD').used}`);
    check('other tier untouched', tierOf(afterFirst, 'Neural2').used === 0);

    // Replay: cache, so no spend and no upstream call.
    const cachedRes = await tts('12345678901234567890');
    check('replay served from cache', cachedRes.headers.get('x-cache') === 'hit', cachedRes.headers.get('x-cache'));
    check('cache hit spends nothing', totalOf(await usage()) === 20);

    // Top tier now has no room, so this must drop to the next tier.
    const second = await tts('abcdefghijklmnopqrstuvwxyzabcd');
    check('fell through to the next tier', second.headers.get('x-tts-tier') === 'Neural2',
          second.headers.get('x-tts-tier'));
    const afterSecond = await usage();
    check('charged to the second tier', tierOf(afterSecond, 'Neural2').used === 30,
          `used: ${tierOf(afterSecond, 'Neural2').used}`);
    check('top tier unchanged', tierOf(afterSecond, 'Chirp3-HD').used === 20);

    // Both tiers are now full.
    const callsBefore = fake.calls();
    const overflow = await tts('this text has nowhere left to go');
    check('refused once every tier is full', overflow.status === 429, `status: ${overflow.status}`);
    const refused = await overflow.json();
    check('refusal explains itself', /hạn mức/i.test(refused.error || ''), refused.error);
    check('never called Google for the refused text', fake.calls() === callsBefore,
          `${callsBefore} -> ${fake.calls()}`);
    check('refused request added no usage', totalOf(await usage()) === 50, `total: ${totalOf(await usage())}`);

    // The counters have to survive a restart, or the cap resets for free.
    const saved = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    check('per-tier usage persisted to disk', saved.tiers['Chirp3-HD'] === 20 && saved.tiers.Neural2 === 30,
          JSON.stringify(saved));
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function googleQuotaCascade() {
  console.log('\n# a 429 from Google drops to the next tier even with budget left');
  fs.rmSync(usageFile, { force: true });
  // Google refuses Chirp3-HD outright, though our own budget says there is room.
  const fake = await startFakeGoogle(new Set(['Chirp3-HD']));
  const child = startServer(fake, { TTS_TIER_ORDER: 'Chirp3-HD,Neural2,Wavenet' });
  await waitForServer();

  try {
    const res = await tts('hello there');
    check('still produced audio', res.status === 200, `status: ${res.status}`);
    check('served by the tier below', res.headers.get('x-tts-tier') === 'Neural2', res.headers.get('x-tts-tier'));
    check('tried the top tier first', /Chirp3-HD/.test(fake.voicesAsked[0]), fake.voicesAsked[0]);
    check('then asked for Neural2', /Neural2/.test(fake.voicesAsked[1]), fake.voicesAsked[1]);

    const u = await usage();
    check('nothing charged to the refused tier', tierOf(u, 'Chirp3-HD').used === 0);
    check('charged to the tier that served it', tierOf(u, 'Neural2').used === 11,
          `used: ${tierOf(u, 'Neural2').used}`);
    check('refused tier marked exhausted', tierOf(u, 'Chirp3-HD').quotaExhausted === true);

    // A second request should skip the dead tier entirely now.
    const before = fake.calls();
    const again = await tts('a different sentence');
    check('second request skips the dead tier', again.headers.get('x-tts-tier') === 'Neural2',
          again.headers.get('x-tts-tier'));
    check('only one upstream call for it', fake.calls() === before + 1, `${before} -> ${fake.calls()}`);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function overallCeiling() {
  console.log('\n# an overall ceiling caps the tiers combined');
  fs.rmSync(usageFile, { force: true });
  const fake = await startFakeGoogle();
  const child = startServer(fake, {
    TTS_TIER_ORDER: 'Chirp3-HD,Neural2',
    TTS_MONTHLY_CHAR_LIMIT: '15',
  });
  await waitForServer();

  try {
    const ok = await tts('1234567890');
    check('under the ceiling succeeds', ok.status === 200, `status: ${ok.status}`);
    // Different text, or the cache would serve it without spending anything.
    const over = await tts('abcdefghij');
    check('over the ceiling is refused despite tier room', over.status === 429, `status: ${over.status}`);
    const u = await usage();
    check('ceiling reported', u.overallLimit === 15, `limit: ${u.overallLimit}`);
    check('usage stopped at the ceiling', totalOf(u) === 10, `total: ${totalOf(u)}`);
  } finally {
    child.kill();
    fake.server.close();
  }
}

const totalOf = (u) => u.totalUsed;

// pickTier() used to run before the upstream await and recordUsage() only
// after it returned, with no lock between them: two requests arriving close
// together could both see room in the same tier and both spend it, together
// overshooting the budget. reserveTtsTier() (server/index.js) closes that gap
// by charging synchronously, before any await -- this test fails against the
// old pickTier()/recordUsage() pair and passes against the fix.
async function concurrentRequestsDoNotOvershootBudget() {
  console.log('\n# two concurrent requests cannot both spend the same last slice of budget');
  fs.rmSync(usageFile, { force: true });
  // Delayed response widens the window the old code would have raced in.
  const fake = await startFakeGoogle(new Set(), 50);
  // Exactly one request's worth of budget -- room for one winner, not two.
  const child = startServer(fake, { TTS_TIER_ORDER: 'Chirp3-HD', TTS_BUDGET_CHIRP3_HD: '10' });
  await waitForServer();

  try {
    // Distinct text (distinct cache keys), same length, fired together.
    const [a, b] = await Promise.all([tts('aaaaaaaaaa'), tts('bbbbbbbbbb')]);
    const statuses = [a.status, b.status].sort();
    check('exactly one of the two succeeds', statuses[0] === 200 && statuses[1] === 429,
          `statuses: ${statuses.join(',')}`);

    const u = await usage();
    check('total usage never exceeds the budget', totalOf(u) <= 10, `total: ${totalOf(u)}`);
    check('usage matches exactly one charge, not a partial or double one', totalOf(u) === 10,
          `total: ${totalOf(u)}`);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  await budgetCascade();
  await googleQuotaCascade();
  await overallCeiling();
  await concurrentRequestsDoNotOvershootBudget();

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
