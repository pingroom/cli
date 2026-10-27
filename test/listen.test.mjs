import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CLI, baseEnv, runAsync, startServer } from './helpers.mjs';

test('listen delivers every printed ping before a fatal 401 ends it', async () => {
  const batch = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, message: 'x'.repeat(4096), room: { name: 'R' } }));
  let calls = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    calls += 1;
    res.writeHead(calls === 1 ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(calls === 1 ? { notifications: batch, cursor: 'n99' } : { message: 'Unauthenticated.' }));
  });
  try {
    // A consumer that does not read for the first 1.5 s: everything past the
    // pipe's own buffer has to wait in the child, which used to exit on the
    // 401 and drop it.
    const { status, stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'listen', '--json', '--from', 'n0', '--token', 'tok', '--api', baseUrl], {
        env: baseEnv(),
      });
      let out = '';
      let err = '';
      const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
      setTimeout(() => child.stdout.on('data', (c) => { out += c; }), 1500);
      child.stderr.on('data', (c) => { err += c; });
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(kill); resolve({ status: code, stdout: out, stderr: err }); });
      child.stdin.end();
    });
    assert.equal(status, 1);
    assert.match(stderr, /listen failed: Unauthenticated/);
    const lines = stdout.trimEnd().split('\n');
    assert.equal(lines.length, 100);
    assert.equal(JSON.parse(lines[99]).id, 'n99');
  } finally {
    server.close();
  }
});

test('listen establishes a cursor from "now", then prints what lands', async () => {
  const seen = [];
  const { server, baseUrl } = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(url.searchParams.get('after'));
    const body = url.searchParams.get('after')
      ? {
          notifications: [
            {
              id: 'n2',
              message: 'Build 512 is green',
              correlation_id: 'deploy-512',
              room: { code: 'AB12', name: 'Project X' },
            },
          ],
          cursor: 'n2',
        }
      // No `after` → the head id and no rows, so startup never replays history.
      : { notifications: [], cursor: 'n1' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  try {
    const { status, stdout } = await runAsync(
      ['listen', '--once', '--token', 'tok', '--api', baseUrl],
      {},
      { timeoutMs: 8000 },
    );
    assert.equal(status, 0);
    assert.match(stdout, /\[Project X\] Build 512 is green/);
    assert.match(stdout, /corr=deploy-512/);
    // First call carries no cursor; the second is bounded by the head id.
    assert.equal(seen[0], null);
    assert.equal(seen[1], 'n1');
  } finally {
    server.close();
  }
});

test('listen --from skips the cursor handshake and honours --json', async () => {
  const seen = [];
  const { server, baseUrl } = await startServer((req, res) => {
    seen.push(new URL(req.url, 'http://x').searchParams.get('after'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      notifications: [{ id: 'n9', message: 'hi', room: { code: 'AB12', name: 'R' } }],
      cursor: 'n9',
    }));
  });

  try {
    const { status, stdout } = await runAsync(
      ['listen', '--once', '--from', 'n5', '--json', '--token', 'tok', '--api', baseUrl],
      {},
      { timeoutMs: 8000 },
    );
    assert.equal(status, 0);
    assert.equal(seen.length, 1, 'an explicit --from needs no handshake request');
    assert.equal(seen[0], 'n5');
    assert.equal(JSON.parse(stdout.trim()).id, 'n9');
  } finally {
    server.close();
  }
});

test('listen refuses out-of-range holds locally, and needs a token', async () => {
  const over = await runAsync(['listen', '--timeout', '99', '--token', 't', '--api', 'https://api.pingroom.io']);
  assert.equal(over.status, 2);
  assert.match(over.stderr, /--timeout must be at most 30/);

  const noToken = await runAsync(['listen', '--api', 'https://api.pingroom.io']);
  assert.equal(noToken.status, 2);
  assert.match(noToken.stderr, /agent token is required/);
});

test('listen waits at least 1 s after a 429 that says Retry-After: 0', async () => {
  const at = [];
  const { server, baseUrl } = await startServer((req, res) => {
    at.push(Date.now());
    if (at.length === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      res.end(JSON.stringify({ message: 'Too Many Attempts.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ notifications: [{ id: 'n2', message: 'hi', room: { name: 'R' } }], cursor: 'n2' }));
  });
  try {
    const { status, stdout } = await runAsync(
      ['listen', '--once', '--from', 'n1', '--token', 'tok', '--api', baseUrl],
      {},
      { timeoutMs: 8000 },
    );
    assert.equal(status, 0);
    assert.match(stdout, /\[R\] hi/);
    assert.equal(at.length, 2);
    assert.ok(at[1] - at[0] >= 950, `retried after ${at[1] - at[0]} ms`);
  } finally {
    server.close();
  }
});
