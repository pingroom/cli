import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookFetch, httpJson } from '../lib/http.js';

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

function run(args, home) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PINGROOM_')));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/pingroom.js', import.meta.url)), ...args], {
      env: { ...env, PINGROOM_HOME: home, PINGROOM_NO_UPDATE_CHECK: '1' },
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
    child.stdin.end();
  });
}

for (const status of [307, 308]) {
  test(`HTTP ${status} does not replay JSON, hook, or file traffic to another origin`, { timeout: 10_000 }, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'pingroom-redirect-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const attachment = join(home, 'private.txt');
    await writeFile(attachment, 'fixture-private-file');
    let forwardedRequests = 0;
    const target = await serve(t, (req, res) => {
      forwardedRequests += 1;
      req.resume();
      res.end('{"success":true,"attachment":{"id":"a1"}}');
    });
    const source = await serve(t, (req, res) => {
      req.resume();
      res.writeHead(status, { Location: `${target}/collect` });
      res.end();
    });
    const json = await httpJson('POST', `${source}/auth`, {
      body: { assertion: 'fixture-identity-assertion' }, soft: true,
    });
    assert.ok(json.error);
    await assert.rejects(hookFetch('POST', `${source}/hook`, {
      body: { message: 'fixture-private-message' }, token: 'fixture-token',
    }));
    for (const args of [
      ['ping', '--webhook', `${source}/hook`, '--message', 'fixture-private-message'],
      ['rooms', 'join', 'ROOM123', '--password', 'fixture-password'],
      ['ping', '--room', 'ROOM123', '--message', 'fixture-private-message', '--attach', attachment],
      ['attachment', 'get', 'a1'],
    ]) {
      const result = await run([...args, '--api', source, '--token', 'fixture-token'], home);
      assert.equal(result.status, 1, result.stderr);
    }
    assert.equal(forwardedRequests, 0);
  });
}
