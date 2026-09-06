import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { credentialsPath, readStoredCredential, saveCredential, updateCredentialState } from '../lib/config.js';

const configModule = new URL('../lib/config.js', import.meta.url).href;
const logoutModule = new URL('../lib/commands/config.js', import.meta.url).href;

function temporaryHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'pingroom-credential-state-'));
  const home = join(root, 'home');
  const previous = process.env.PINGROOM_HOME;
  process.env.PINGROOM_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.PINGROOM_HOME;
    else process.env.PINGROOM_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home };
}

function rawState() { return JSON.parse(readFileSync(credentialsPath(), 'utf8')); }

function child(code, home) {
  return spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, PINGROOM_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runChild(code, home) {
  const process = child(code, home);
  let stdout = '';
  let stderr = '';
  process.stdout.on('data', (chunk) => { stdout += chunk; });
  process.stderr.on('data', (chunk) => { stderr += chunk; });
  const [status] = await once(process, 'close');
  assert.equal(status, 0, stderr);
  return stdout;
}

test('replacement and pending revocation share durable credential state with private permissions', async (t) => {
  const { home } = temporaryHome(t);
  await saveCredential({ token: 'old', apiBase: 'https://original.example/api' });
  await saveCredential({ token: 'new', handle: 'agent', apiBase: 'https://replacement.example/api' });

  const state = rawState();
  assert.equal(state.token, 'new');
  assert.equal(state.handle, 'agent');
  assert.equal(state.pending_revocations.length, 1);
  assert.deepEqual(state.pending_revocations[0], {
    id: state.pending_revocations[0].id,
    token: 'old',
    api_url: 'https://original.example/api',
  });
  assert.match(state.pending_revocations[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600);
});

test('several rotations retain every unfinished revocation and its retry metadata', async (t) => {
  temporaryHome(t);
  await saveCredential({ token: 'first', apiBase: 'https://first.example' });
  await saveCredential({ token: 'second', apiBase: 'https://second.example' });
  const pending = rawState().pending_revocations[0];
  await updateCredentialState((state) => ({
    ...state,
    pending_revocations: [{ ...pending, next_attempt_at: 123456 }],
  }));
  await saveCredential({ token: 'third', apiBase: 'https://third.example' });

  const state = rawState();
  assert.equal(state.token, 'third');
  assert.deepEqual(state.pending_revocations[0], { ...pending, next_attempt_at: 123456 });
  assert.equal(state.pending_revocations[1].token, 'second');
  assert.equal(state.pending_revocations[1].api_url, 'https://second.example');
});

test('a missing original API leaves cleanup queued without guessing the replacement issuer', async (t) => {
  temporaryHome(t);
  await updateCredentialState(() => ({ version: 1, token: 'old' }));
  await saveCredential({ token: 'new', apiBase: 'https://replacement.example' });
  const state = rawState();
  assert.equal(state.token, 'new');
  assert.equal(state.pending_revocations[0].token, 'old');
  assert.equal(state.pending_revocations[0].api_url, null);
});

test('saving the same token and reactivating a queued token never queues the active credential', async (t) => {
  temporaryHome(t);
  await saveCredential({ token: 'first', apiBase: 'https://issuer.example' });
  await saveCredential({ token: 'first', apiBase: 'https://issuer.example' });
  assert.deepEqual(rawState().pending_revocations || [], []);
  await saveCredential({ token: 'second', apiBase: 'https://issuer.example' });
  await saveCredential({ token: 'first', apiBase: 'https://issuer.example' });
  assert.equal(rawState().token, 'first');
  assert.deepEqual(rawState().pending_revocations.map(({ token }) => token), ['second']);
});

test('concurrent saves through directory aliases retain every predecessor credential', async (t) => {
  const { home, root } = temporaryHome(t);
  await saveCredential({ token: 'initial', apiBase: 'https://issuer.example' });
  const alias = join(root, 'alias');
  symlinkSync(home, alias, 'dir');
  const tokens = ['one', 'two', 'three', 'four', 'five', 'six'];
  await Promise.all(tokens.map((token, index) => runChild(`
    import { saveCredential } from ${JSON.stringify(configModule)};
    await saveCredential({ token: ${JSON.stringify(token)}, apiBase: 'https://issuer.example' });
  `, index % 2 ? alias : home)));

  const state = rawState();
  const saved = [state.token, ...state.pending_revocations.map(({ token }) => token)];
  assert.deepEqual(saved.sort(), ['initial', ...tokens].sort());
  assert.equal(new Set(saved).size, saved.length);
});

test('logout clears active metadata but preserves pending revocations', async (t) => {
  const { home } = temporaryHome(t);
  await saveCredential({ token: 'old', apiBase: 'https://issuer.example' });
  await saveCredential({ token: 'new', handle: 'agent', apiBase: 'https://issuer.example' });
  const pending = rawState().pending_revocations;
  const stdout = await runChild(`
    import { logout } from ${JSON.stringify(logoutModule)};
    await logout({});
  `, home);
  assert.match(stdout, /logged out \(@agent\)/);
  assert.match(stdout, /cleanup remains queued/);
  assert.equal(readStoredCredential(), null);
  assert.deepEqual(rawState(), { version: 1, pending_revocations: pending });
});

test('a failed mutation preserves credentials and releases its lock', async (t) => {
  temporaryHome(t);
  await saveCredential({ token: 'active', apiBase: 'https://issuer.example' });
  const before = readFileSync(credentialsPath(), 'utf8');
  await assert.rejects(updateCredentialState(() => { throw new Error('mutation failed'); }), /mutation failed/);
  assert.equal(readFileSync(credentialsPath(), 'utf8'), before);
  assert.ok(!existsSync(`${credentialsPath()}.lock`));
  await updateCredentialState((state) => ({ ...state, handle: 'changed' }), { retries: 0 });
  assert.equal(rawState().handle, 'changed');
});

test('credential writes refuse unreadable state without discarding pending recovery work', async (t) => {
  const { home } = temporaryHome(t);
  mkdirSync(home, { mode: 0o700 });
  const damaged = '{"token":"secret-token-avoid-logs","pending_revocations":oops}';
  writeFileSync(credentialsPath(), damaged, { mode: 0o600 });
  await assert.rejects(saveCredential({ token: 'new', apiBase: 'https://issuer.example' }), (err) => {
    assert.match(err.message, /invalid credential state/);
    assert.doesNotMatch(err.message, /secret-token-avoid-logs/);
    return true;
  });
  assert.equal(readFileSync(credentialsPath(), 'utf8'), damaged);
  assert.ok(!existsSync(`${credentialsPath()}.lock`));
});

test('a stale lock left by a killed process can be reclaimed', async (t) => {
  const { home } = temporaryHome(t);
  await saveCredential({ token: 'old', apiBase: 'https://issuer.example' });
  const owner = child(`
    import { updateCredentialState } from ${JSON.stringify(configModule)};
    await updateCredentialState(async () => {
      process.stdout.write('locked');
      await new Promise(() => { setInterval(() => {}, 1000); });
    });
  `, home);
  t.after(() => owner.kill('SIGKILL'));
  await once(owner.stdout, 'data');
  const closed = once(owner, 'close');
  owner.kill('SIGKILL');
  await closed;
  const lockPath = `${credentialsPath()}.lock`;
  assert.ok(existsSync(lockPath));
  const stale = new Date(Date.now() - 20000);
  utimesSync(lockPath, stale, stale);
  await saveCredential({ token: 'new', apiBase: 'https://issuer.example' });
  assert.equal(rawState().token, 'new');
  assert.equal(rawState().pending_revocations[0].token, 'old');
});
