// Exercises the translation cache by running the real server against a stubbed
// Gemini endpoint, so no quota is spent and every upstream call is counted.
//
// Run with: npm test
const { check, finish, startServer, waitForServer } = require('./helpers');

const PORT = 3288;
const BASE = `http://127.0.0.1:${PORT}`;

// Stand-in for generativelanguage.googleapis.com. Records which targets each
// prompt asked for, which is how we tell a partial cache hit from a full miss.
function startFakeGemini() {
  const http = require('http');
  return new Promise((resolve) => {
    const asked = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const prompt = JSON.parse(body).contents[0].parts[0].text;
        const targets = [];
        if (/"en":/.test(prompt)) targets.push('en');
        if (/"ja":/.test(prompt)) targets.push('ja');
        if (/"vi":/.test(prompt)) targets.push('vi');
        asked.push(targets.join('+'));

        const out = {};
        for (const t of targets) out[t] = `[${t}] translated`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      asked,
      calls: () => asked.length,
    }));
  });
}

const translate = (text, source, targets) => fetch(`${BASE}/api/translate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, source, targets }),
});

async function main() {
  const fake = await startFakeGemini();
  const child = startServer({
    PORT: String(PORT),
    HOST: '127.0.0.1',
    GEMINI_API_KEY: 'fake-key',
    GEMINI_ENDPOINT_BASE: `http://127.0.0.1:${fake.port}/v1beta/models`,
  });
  await waitForServer(`${BASE}/`);

  try {
    // First time: both languages missing, so one call asking for both.
    const first = await translate('câu thứ nhất', 'vi', ['en', 'ja']);
    const firstBody = await first.json();
    check('translated on first request', first.status === 200, `status: ${first.status}`);
    check('reported as a miss', first.headers.get('x-cache') === 'miss', first.headers.get('x-cache'));
    check('both languages returned',
          firstBody.translations.en === '[en] translated' && firstBody.translations.ja === '[ja] translated',
          JSON.stringify(firstBody.translations));
    check('one upstream call asking for both', fake.calls() === 1 && fake.asked[0] === 'en+ja',
          `calls=${fake.calls()} asked=${fake.asked.join(',')}`);

    // Same sentence again: fully cached, no upstream call at all.
    const second = await translate('câu thứ nhất', 'vi', ['en', 'ja']);
    check('repeat served from cache', second.headers.get('x-cache') === 'hit', second.headers.get('x-cache'));
    check('no upstream call for the repeat', fake.calls() === 1, `calls: ${fake.calls()}`);
    const secondBody = await second.json();
    check('cached answer identical', secondBody.translations.en === '[en] translated');

    // Only Japanese is new, so the call must ask for Japanese alone rather than
    // paying for English again.
    const partial = await translate('câu thứ nhất', 'vi', ['ja']);
    check('single cached target is a hit', partial.headers.get('x-cache') === 'hit',
          partial.headers.get('x-cache'));
    check('still no new upstream call', fake.calls() === 1, `calls: ${fake.calls()}`);

    // A different source language for the same text is a different pair.
    const other = await translate('câu thứ nhất', 'en', ['vi', 'ja']);
    check('other source language refetches', other.status === 200 && fake.calls() === 2,
          `calls: ${fake.calls()}`);
    check('asked only for the new pair targets', fake.asked[1] === 'ja+vi' || fake.asked[1] === 'vi+ja',
          `asked: ${fake.asked[1]}`);

    // Now prove the partial path: new sentence, English only, then both.
    const p1 = await translate('câu thứ hai', 'vi', ['en']);
    check('new sentence single target', p1.status === 200 && fake.calls() === 3, `calls: ${fake.calls()}`);
    check('asked for English only', fake.asked[2] === 'en', `asked: ${fake.asked[2]}`);

    const p2 = await translate('câu thứ hai', 'vi', ['en', 'ja']);
    const p2Body = await p2.json();
    check('partial cache still answers both',
          p2Body.translations.en === '[en] translated' && p2Body.translations.ja === '[ja] translated',
          JSON.stringify(p2Body.translations));
    check('asked upstream for Japanese only', fake.asked[3] === 'ja', `asked: ${fake.asked[3]}`);
    check('four calls total, never one per language', fake.calls() === 4, `calls: ${fake.calls()}`);
  } finally {
    child.kill();
    fake.server.close();
  }

  finish();
}

main().catch((err) => { console.error(err); process.exit(1); });
