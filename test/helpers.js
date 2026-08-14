// Shared by every test/*.test.js file: the same PASS/FAIL check() and
// exit-1-on-failure behaviour that used to be copied verbatim into each one
// (stt.test.js, translate.test.js, budget.test.js all had an identical copy).
//
// Port assignments for tests that spawn the real server (npm test runs them
// serially, but keep each one fixed and distinct so a stray parallel run
// fails loudly instead of colliding silently):
//   3287 budget.test.js       3289 tts-gemini.test.js
//   3288 translate.test.js    3290 translate-errors.test.js
//   3291 limits.test.js (Phase 3)
const path = require('path');
const { spawn } = require('child_process');

const failures = [];

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' -- ' + detail : ''}`);
  if (!cond) failures.push(name);
}

function finish() {
  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

// Spawns the real server as a subprocess with the given env on top of the
// current one, piping stderr through with the [server] prefix every test
// file already used so a crash is visible in the test log.
function startServer(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

// Polls a URL until it answers or the budget runs out -- the server takes a
// moment to bind its port after spawn.
async function waitForServer(url) {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(url);
      return;
    } catch (err) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server never came up: ${url}`);
}

module.exports = { check, finish, startServer, waitForServer, failures };
