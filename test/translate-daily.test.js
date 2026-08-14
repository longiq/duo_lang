// Exercises TRANSLATE_DAILY_MAX: the daily cap on Gemini translate calls that
// exists because the app is a public URL with no auth, so nothing else stops
// a caller from spending the whole free-tier day's worth of requests.
//
// Run with: npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, finish, startServer, waitForServer } = require('./helpers');

const PORT = 3292;
const BASE = `http://127.0.0.1:${PORT}`;
const usageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'duolang-daily-')), 'translate-usage.json');

function startFakeGemini() {
  const http = require('http');
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const prompt = JSON.parse(body).contents[0].parts[0].text;
        const targets = [];
        if (/"en":/.test(prompt)) targets.push('en');
        if (/"ja":/.test(prompt)) targets.push('ja');
        const out = {};
        for (const t of targets) out[t] = `[${t}] translated`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
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
    TRANSLATE_USAGE_FILE: usageFile,
    TRANSLATE_DAILY_MAX: '2',
    ...extraEnv,
  });
}

const translate = (text) => fetch(`${BASE}/api/translate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, source: 'vi', targets: ['en'] }),
});

async function main() {
  fs.rmSync(usageFile, { force: true });
  const fake = await startFakeGemini();
  let child = bootServer(fake);
  await waitForServer(`${BASE}/`);

  try {
    console.log('\n# the third distinct call in a day, over TRANSLATE_DAILY_MAX=2, is refused');
    const first = await translate('câu một');
    check('first call succeeds', first.status === 200, `status: ${first.status}`);
    const second = await translate('câu hai');
    check('second call succeeds', second.status === 200, `status: ${second.status}`);

    const third = await translate('câu ba');
    check('third call is refused', third.status === 429, `status: ${third.status}`);
    const thirdBody = await third.json();
    check('refusal is Vietnamese', /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i.test(thirdBody.error || ''),
          thirdBody.error);
    check('the refused call never reached upstream', fake.requests.length === 2, `requests: ${fake.requests.length}`);

    console.log('\n# a cached repeat after the cap is reached still succeeds -- it costs no upstream call');
    const repeat = await translate('câu một');
    check('cached repeat still succeeds', repeat.status === 200, `status: ${repeat.status}`);
    check('cache hit reported', repeat.headers.get('x-cache') === 'hit', repeat.headers.get('x-cache'));
    check('no new upstream call for the cached repeat', fake.requests.length === 2, `requests: ${fake.requests.length}`);

    console.log('\n# the count survives a restart -- that is the entire point of persisting it');
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    const onDisk = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    check('usage file has count 2', onDisk.count === 2, JSON.stringify(onDisk));

    child = bootServer(fake);
    await waitForServer(`${BASE}/`);
    const fourth = await translate('câu bốn');
    check('still refused after a restart', fourth.status === 429, `status: ${fourth.status}`);
    check('still no upstream call for it', fake.requests.length === 2, `requests: ${fake.requests.length}`);
  } finally {
    child.kill();
    fake.server.close();
  }

  finish();
}

main().catch((err) => { console.error(err); process.exit(1); });
