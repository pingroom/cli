import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/pingroom.js', import.meta.url));
const RUN = new URL('../lib/commands/run.js', import.meta.url).href;
const NODE = process.execPath;

function environment(t, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pingroom-run-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PINGROOM_')) delete env[key];
  delete env.NODE_OPTIONS;
  return { ...env, PINGROOM_HOME: home, ...extra };
}

function execute(argv, env, { nodeArgs = [], onChild, input = '', detached = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [...nodeArgs, CLI, 'run', ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'], detached });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('run did not finish within 8 seconds')); }, 8000);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    onChild?.(child);
    child.stdin.end(input);
  });
}

async function stub(t, handler = (_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{"success":true}');
}) {
  const received = [];
  const server = createServer(async (request, response) => {
    const pieces = [];
    for await (const piece of request) pieces.push(piece);
    received.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(pieces).toString()) });
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, received };
}

function previewPayload(stderr) {
  return JSON.parse(stderr.split('\n').find((line) => line.startsWith('pingroom: ping preview ')).slice('pingroom: ping preview '.length));
}

test('run preview executes once, preserves output/status, and warns before execution', async (t) => {
  const env = environment(t);
  const counter = join(env.PINGROOM_HOME, 'ran');
  const code = `require('node:fs').appendFileSync(${JSON.stringify(counter)}, '1'); process.stdout.write('child stdout\\n'); process.stderr.write('child stderr\\n'); process.exit(7);`;
  const result = await execute(['--preview', '--name', 'Build', '--', NODE, '-e', code], env);
  assert.equal(result.code, 7);
  assert.equal(result.stdout, 'child stdout\n');
  assert.equal(readFileSync(counter, 'utf8'), '1');
  assert.match(result.stderr, /^pingroom: preview EXECUTES the command/);
  assert.match(result.stderr, /child stderr/);
  assert.deepEqual(previewPayload(result.stderr).title, 'Build');
  assert.match(previewPayload(result.stderr).message, /^Build failed \(exit 7\) after \d+\.\ds\.$/);
});

test('run forwards arguments literally after --, including --help and shell syntax', async (t) => {
  const env = environment(t);
  const args = ['--help', '--name', 'not-a-run-option', '--', 'a b', '; echo bad', '$(echo bad)', '*.js'];
  const result = await execute(['--preview', '--', NODE, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args], env);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.match(previewPayload(result.stderr).message, /succeeded \(exit 0\)/);
});

test('run passes piped stdin through to the child', async (t) => {
  const result = await execute(['--preview', '--', NODE, '-e', 'process.stdin.pipe(process.stdout)'], environment(t), { input: 'piped input\n' });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'piped input\n');
});

test('run preview never reads config or credentials and performs no wrapper network calls', async (t) => {
  const env = environment(t, { PINGROOM_TOKEN: 'secret-token', PINGROOM_WEBHOOK_URL: 'https://secret.invalid/secret' });
  delete env.CI;
  delete env.NODE_ENV;
  const reads = join(env.PINGROOM_HOME, 'reads');
  const network = join(env.PINGROOM_HOME, 'network');
  const preload = join(env.PINGROOM_HOME, 'check.mjs');
  writeFileSync(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.readFileSync;
    fs.readFileSync = function(path, ...args) {
      if (/(config|credentials)\\.json$/.test(String(path))) fs.appendFileSync(${JSON.stringify(reads)}, 'read');
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    globalThis.fetch = async () => { fs.appendFileSync(${JSON.stringify(network)}, 'fetch'); throw new Error('network forbidden'); };
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: true });
  `);
  const result = await execute(['--preview', '--', NODE, '-e', ''], env, { nodeArgs: ['--import', preload] });
  assert.equal(result.code, 0);
  assert.equal(existsSync(reads), false);
  assert.equal(existsSync(network), false);
  assert.doesNotMatch(result.stderr, /secret-token|secret\.invalid/);
});

test('run validates usage before executing the child', async (t) => {
  const env = environment(t);
  const marker = join(env.PINGROOM_HOME, 'ran');
  const command = [NODE, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
  for (const prefix of [
    [], ['--preview', '--unknown-secret'], ['--preview', '--name', 'x'.repeat(41)],
    ['--preview', '--name', '\n\t'], ['--preview', '--notify-timeout', '0'],
    ['--preview', '--notify-timeout', '61'], ['--preview', '--notify-timeout', '1.5'],
    ['--webhook', 'http://example.com/private-secret'],
    ['--webhook', 'https://user:password@example.com'], ['--webhook', 'invalid-secret'],
    ['--token', 'token-without-room'], ['--token', 'bad\nheader', '--room', 'ROOM'],
  ]) {
    const result = await execute([...prefix, '--', ...command], env);
    assert.equal(result.code, 2, JSON.stringify(prefix));
    assert.equal(existsSync(marker), false);
    assert.doesNotMatch(result.stderr, /unknown-secret|private-secret|password|invalid-secret|token-without-room|bad\nheader/);
  }
  for (const argv of [[], ['--preview', '--'], ['--preview', NODE, '-e', ''], ['--preview', '--name', '--', ...command]]) {
    const result = await execute(argv, env);
    assert.equal(result.code, 2);
    assert.equal(existsSync(marker), false);
  }
});

test('run --help before separator does not execute and describes preview accurately', async (t) => {
  const result = await execute(['--help', '--', NODE, '-e', 'process.exit(99)'], environment(t));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /EXECUTES the command/);
  assert.equal(result.stderr, '');
});

test('missing executable returns 127 with a sanitized preview', async (t) => {
  const result = await execute(['--preview', '--', '/private/folder/does-not-exist-pingroom-test', 'secret-argument'], environment(t));
  assert.equal(result.code, 127);
  assert.equal(result.stdout, '');
  assert.match(previewPayload(result.stderr).message, /could not start \(exit 127\)/);
  assert.doesNotMatch(result.stderr, /private\/folder|secret-argument/);
});

test('webhook gets exactly one bounded payload, with no command arguments or output', async (t) => {
  const server = await stub(t);
  const result = await execute(['-w', `${server.url}/secret-hook`, '--', NODE, '-e', 'process.stdout.write("private-output");', 'private-argument'], environment(t));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'private-output');
  assert.equal(server.received.length, 1);
  const { body } = server.received[0];
  assert.deepEqual(Object.keys(body).sort(), ['message', 'title']);
  assert.equal(body.title, basename(NODE));
  assert.ok(Array.from(body.title).length <= 40);
  assert.ok(Array.from(body.message).length <= 120);
  assert.ok(body.message.startsWith(`${basename(NODE)} succeeded (exit 0) after `));
  assert.doesNotMatch(JSON.stringify(body), /private-output|private-argument|secret-hook/);
  assert.match(result.stderr, /completion ping sent/);
});

test('saved credential and room use their bound origin', async (t) => {
  const server = await stub(t);
  const env = environment(t);
  writeFileSync(join(env.PINGROOM_HOME, 'credentials.json'), JSON.stringify({ token: 'saved-secret', api_url: server.url, room: { invite_code: 'HOME' } }));
  const result = await execute(['--', NODE, '-e', 'process.exit(5)'], env);
  assert.equal(result.code, 5);
  assert.equal(server.received.length, 1);
  assert.equal(server.received[0].headers.authorization, 'Bearer saved-secret');
  assert.equal(server.received[0].url, '/api/agent/rooms/HOME/notifications');
  assert.doesNotMatch(result.stderr + result.stdout, /saved-secret/);
});

test('stored credential cannot be redirected and child does not start', async (t) => {
  const env = environment(t);
  const marker = join(env.PINGROOM_HOME, 'ran');
  writeFileSync(join(env.PINGROOM_HOME, 'credentials.json'), JSON.stringify({ token: 'saved-secret', api_url: 'https://original.invalid', room: { invite_code: 'HOME' } }));
  const result = await execute(['--api', 'https://other.invalid', '--', NODE, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], env);
  assert.equal(result.code, 2);
  assert.equal(existsSync(marker), false);
  assert.match(result.stderr, /stored credential is bound/);
  assert.doesNotMatch(result.stderr, /saved-secret/);
});

test('Unicode labels are bounded by characters and strip terminal controls', async (t) => {
  const label = '🕊'.repeat(40);
  const result = await execute(['--preview', '--name', label, '--', NODE, '-e', ''], environment(t));
  assert.equal(result.code, 0);
  assert.equal(previewPayload(result.stderr).title, label);
  assert.ok(Array.from(previewPayload(result.stderr).message).length <= 120);
  const clean = await execute(['--preview', '--name', '\u001bSafe\n\u202elabel', '--', NODE, '-e', ''], environment(t));
  assert.equal(previewPayload(clean.stderr).title, 'Safe label');
});

test('server failure preserves successful and failed child statuses without echoing response secrets', async (t) => {
  const server = await stub(t, (_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{"message":"private-server-secret"}');
  });
  for (const status of [0, 9]) {
    const result = await execute(['--webhook', `${server.url}/secret`, '--', NODE, '-e', `process.exit(${status})`], environment(t));
    assert.equal(result.code, status);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /completion ping failed; command exit status preserved/);
    assert.doesNotMatch(result.stderr, /private-server-secret|\/secret/);
  }
  assert.equal(server.received.length, 2);
});

test('delivery timeout bounds stalled headers and stalled response bodies', async (t) => {
  for (const sendHeaders of [false, true]) {
    const server = await stub(t, (_request, response) => {
      if (sendHeaders) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); }
    });
    const started = performance.now();
    const result = await execute(['--notify-timeout', '1', '--webhook', server.url, '--', NODE, '-e', 'process.exit(11)'], environment(t));
    assert.equal(result.code, 11);
    assert.match(result.stderr, /completion ping failed/);
    assert.ok(performance.now() - started < 4000);
    assert.equal(server.received.length, 1);
  }
});

test('delivery refuses redirects and a success:false response without retrying', async (t) => {
  const redirected = await stub(t);
  const redirect = await stub(t, (_request, response) => {
    response.writeHead(307, { location: redirected.url });
    response.end();
  });
  const rejected = await stub(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"success":false,"message":"private-server-secret"}');
  });
  for (const server of [redirect, rejected]) {
    const result = await execute(['--webhook', server.url, '--', NODE, '-e', ''], environment(t));
    assert.equal(result.code, 0);
    assert.match(result.stderr, /completion ping failed/);
    assert.doesNotMatch(result.stderr, /private-server-secret/);
    assert.equal(server.received.length, 1);
  }
  assert.equal(redirected.received.length, 0);
});

test('interrupting stalled delivery preserves the finished command status', { skip: process.platform === 'win32' }, async (t) => {
  let cli;
  const server = await stub(t, () => cli.kill('SIGINT'));
  const result = await execute(['--webhook', server.url, '--', NODE, '-e', 'process.exit(17)'], environment(t), {
    onChild(child) { cli = child; },
  });
  assert.equal(result.code, 17);
  assert.match(result.stderr, /completion ping failed/);
});

test('signals forward to the direct child and preserve conventional signal status', { skip: process.platform === 'win32' }, async (t) => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const result = await execute(['--preview', '--', NODE, '-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'], environment(t), {
      // The test runner may itself have a controlling terminal even though
      // the wrapper's stdio uses pipes. Model a daemon with its own session.
      detached: true,
      onChild(child) { child.stdout.once('data', () => child.kill(signal)); },
    });
    assert.equal(result.code, code);
    assert.match(previewPayload(result.stderr).message, new RegExp(`stopped by ${signal} \\(exit ${code}\\)`));
  }
});

test('a child signal handler owns its numeric exit status', { skip: process.platform === 'win32' }, async (t) => {
  const result = await execute(['--preview', '--', NODE, '-e', 'process.on("SIGTERM", () => process.exit(23)); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'], environment(t), {
    onChild(child) { child.stdout.once('data', () => child.kill('SIGTERM')); },
  });
  assert.equal(result.code, 23);
});

test('terminal group SIGINT reaches a graceful child exactly once', { skip: process.platform === 'win32' }, async (t) => {
  const env = environment(t);
  const preload = join(env.PINGROOM_HOME, 'terminal.mjs');
  // The test runner has pipes. Model its terminal marker while delivering a
  // real POSIX group signal to an isolated wrapper + child process group.
  writeFileSync(preload, 'Object.defineProperty(process.stdout, "isTTY", { value: true });');
  const script = 'let count=0; process.on("SIGINT",()=>{count++; if(count===1)setTimeout(()=>{process.stdout.write(String(count));process.exit(count)},150)});process.stdout.write("ready\\n");setInterval(()=>{},1000);';
  const result = await execute(['--preview', '--', NODE, '-e', script], env, {
    nodeArgs: ['--import', preload], detached: true,
    onChild(child) { child.stdout.once('data', () => process.kill(-child.pid, 'SIGINT')); },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, 'ready\n1');
});

test('run removes its signal listeners after successful and failed launches', async (t) => {
  const script = `
    const { run } = await import(${JSON.stringify(RUN)});
    const before = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
    await run({ preview: true, _: [process.execPath, '-e', ''] });
    await run({ preview: true, _: ['/missing/pingroom-test-command'] });
    const after = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
    process.stdout.write(JSON.stringify({ before, after }));
  `;
  const result = await execute(['--preview', '--', NODE, '--input-type=module', '-e', script], environment(t));
  assert.equal(result.code, 0);
  const { before, after } = JSON.parse(result.stdout);
  assert.deepEqual(after, before);
});

test('delivery clears its deadline and signal handlers when used without the CLI exit', async (t) => {
  const server = await stub(t);
  const script = `
    const { run } = await import(${JSON.stringify(RUN)});
    const before = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
    await run({ webhook: ${JSON.stringify(server.url)}, _: [process.execPath, '-e', ''] });
    const after = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
    process.stdout.write(JSON.stringify({ before, after }));
  `;
  const result = await execute(['--preview', '--', NODE, '--input-type=module', '-e', script], environment(t));
  assert.equal(result.code, 0);
  const { before, after } = JSON.parse(result.stdout);
  assert.deepEqual(after, before);
  assert.equal(server.received.length, 1);
});

test('a failed signal forward after launch is not reported as a launch failure', { skip: process.platform === 'win32' }, async (t) => {
  // ChildProcess.kill() emits 'error' rather than throwing for EPERM. The child
  // is still running, so its real exit must settle the outcome.
  const script = `
    const { ChildProcess } = await import('node:child_process');
    ChildProcess.prototype.kill = function () {
      this.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
      return false;
    };
    const { run } = await import(${JSON.stringify(RUN)});
    setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 100);
    const code = await run({ preview: true, _: [process.execPath, '-e', 'setTimeout(() => process.exit(3), 400)'] });
    process.stdout.write(JSON.stringify({ code }));
  `;
  const result = await execute(['--preview', '--', NODE, '--input-type=module', '-e', script], environment(t));
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { code: 3 });
  assert.doesNotMatch(result.stderr, /could not start/);
});
