import test from 'node:test';
import assert from 'node:assert/strict';
import { explainNpmFailure, installerFromPath, update } from '../lib/commands/update.js';
import { parseUpdateArgs } from '../lib/parser.js';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { run } from './helpers.mjs';

async function check(t, args, overrides = {}) {
  let output = '';
  const installed = [];
  t.mock.method(process.stdout, 'write', (value) => { output += value; return true; });
  const code = await update({ _: [], json: true, ...args }, {
    currentVersion: '0.10.3', latestVersion: async () => '0.11.0',
    installKind: async () => 'npm', releaseHold: async () => null, install: async (version) => installed.push(version), ...overrides,
  });
  return { code, body: JSON.parse(output), installed };
}

test('update parser exposes check and JSON without credentials', () => {
  assert.deepEqual(parseUpdateArgs(['--check', '--json']), { _: [], check: true, json: true });
});
test('update --check reports the available version without installing', async (t) => {
  const result = await check(t, { check: true });
  assert.equal(result.code, 0);
  assert.equal(result.body.update_available, true);
  assert.equal(result.body.updated, false);
  assert.deepEqual(result.installed, []);
});
test('update installs exactly the checked version and returns one JSON result', async (t) => {
  const result = await check(t, {});
  assert.equal(result.code, 0);
  assert.equal(result.body.updated, true);
  assert.equal(result.body.update_available, false);
  assert.deepEqual(result.installed, ['0.11.0']);
});
for (const latest of ['0.10.3', '0.9.0']) {
  test(`update does not reinstall or downgrade for ${latest}`, async (t) => {
    const result = await check(t, {}, { latestVersion: async () => latest });
    assert.equal(result.code, 0);
    assert.equal(result.body.update_available, false);
    assert.deepEqual(result.installed, []);
  });
}
for (const latest of ['1.0.0-beta.1', '1.0.0;touch bad', null, {}]) {
  test(`update rejects malformed npm versions: ${JSON.stringify(latest)}`, async (t) => {
    const result = await check(t, {}, { latestVersion: async () => latest });
    assert.equal(result.code, 1);
    assert.match(result.body.error, /invalid stable version/);
    assert.deepEqual(result.installed, []);
  });
}
for (const [kind, command] of [
  ['npx', 'npx --yes @pingroom/cli@latest'],
  ['pnpm', 'pnpm add --global @pingroom/cli@0.11.0'],
  ['bun', 'bun add --global @pingroom/cli@0.11.0'],
  ['yarn', 'yarn global add @pingroom/cli@0.11.0'],
  ['volta', 'volta install @pingroom/cli@0.11.0'],
  ['source', 'git pull'],
  ['local', 'npm install @pingroom/cli@0.11.0'],
]) {
  test(`update leaves a ${kind} install alone and names the command that updates it`, async (t) => {
    const result = await check(t, {}, { installKind: async () => kind });
    assert.equal(result.code, 2);
    assert.equal(result.body.install, kind);
    assert.equal(result.body.command, command);
    assert.ok(result.body.error.includes(command));
    assert.equal(result.body.updated, false);
    assert.deepEqual(result.installed, []);
  });
}
test('the installer is read from the path each tool installs to', () => {
  assert.equal(installerFromPath('/Users/a/.npm/_npx/007ca3d07bf3d050/node_modules/@pingroom/cli/'), 'npx');
  assert.equal(installerFromPath('/Users/a/Library/pnpm/global/5/.pnpm/@pingroom+cli@0.16.0/node_modules/@pingroom/cli/'), 'pnpm');
  assert.equal(installerFromPath('/Users/a/.bun/install/global/node_modules/@pingroom/cli/'), 'bun');
  assert.equal(installerFromPath('/home/a/.config/yarn/global/node_modules/@pingroom/cli/'), 'yarn');
  assert.equal(installerFromPath('C:\\Users\\a\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\@pingroom\\cli\\'), 'yarn');
  assert.equal(installerFromPath('/Users/a/.volta/tools/image/packages/@pingroom/cli/lib/node_modules/@pingroom/cli/'), 'volta');
  // npm global, a project dependency (pnpm's included) and a checkout share no marker.
  assert.equal(installerFromPath('/opt/homebrew/lib/node_modules/@pingroom/cli/'), null);
  assert.equal(installerFromPath('/work/app/node_modules/.pnpm/@pingroom+cli@0.16.0/node_modules/@pingroom/cli/'), null);
  assert.equal(installerFromPath('/work/pingroom/cli/'), null);
});
const npmError = (code, extra = {}) => Object.assign(new Error('Command failed: npm secret-token'), {
  cmd: 'npm install', stderr: `npm error code ${code}\nnpm error secret-token\n`, ...extra,
});
for (const [error, code, command] of [
  [npmError('ETARGET'), 'release_age', 'npm install --global @pingroom/cli@0.11.0 --min-release-age=0'],
  [npmError('EACCES'), 'permission', process.platform === 'win32' ? 'npm install --global @pingroom/cli@0.11.0' : 'sudo npm install --global @pingroom/cli@0.11.0'],
  [npmError('E401'), 'registry_auth', undefined],
  [npmError('ENOTFOUND'), 'network', undefined],
  [npmError('ESOMETHING', { killed: true }), 'timeout', 'npm install --global @pingroom/cli@0.11.0'],
  [npmError('EWHATEVER'), 'npm_failed', 'npm install --global @pingroom/cli@0.11.0'],
  [Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }), 'npm_missing', undefined],
]) {
  test(`a failed install says why and what to run: ${code}`, async (t) => {
    const result = await check(t, {}, { install: async () => { throw error; } });
    assert.equal(result.code, 1);
    assert.equal(result.body.error_code, code);
    assert.equal(result.body.command, command);
    if (command) assert.ok(result.body.error.includes(command));
    assert.equal(result.body.updated, false);
    assert.doesNotMatch(JSON.stringify(result.body), /secret-token/);
  });
}
test('a failed version lookup points at the latest tag, not at "undefined"', () => {
  const failure = explainNpmFailure(npmError('EWHATEVER'), undefined);
  assert.equal(failure.command, 'npm install --global @pingroom/cli@latest');
});
test('failed npm install returns failure without claiming success or exposing npm output', async (t) => {
  const result = await check(t, {}, { install: async () => { throw Object.assign(new Error('secret-token'), { cmd: 'npm', stderr: 'secret-token' }); } });
  assert.equal(result.code, 1);
  assert.equal(result.body.updated, false);
  assert.doesNotMatch(result.body.error, /secret-token/);
});
test('invalid update arguments fail before registry access', async (t) => {
  const result = await check(t, { _: ['latest'] }, { latestVersion: async () => assert.fail('must not contact npm') });
  assert.equal(result.code, 2);
  assert.deepEqual(result.installed, []);
});

test('installed CLI updates through npm and verifies the installed version', { skip: process.platform === 'win32' }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pingroom-self-update-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('..', import.meta.url));
  const globalRoot = join(directory, 'lib', 'node_modules');
  const installed = join(globalRoot, '@pingroom', 'cli');
  mkdirSync(installed, { recursive: true });
  for (const name of ['bin', 'lib']) cpSync(join(source, name), join(installed, name), { recursive: true });
  symlinkSync(join(source, 'node_modules'), join(installed, 'node_modules'), 'dir');
  const manifest = join(installed, 'package.json');
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  writeFileSync(manifest, JSON.stringify({ ...pkg, version: '0.0.1' }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const receipt = join(directory, 'npm-args.json');
  writeFileSync(join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'view') console.log(JSON.stringify('0.11.0'));
else if (args[0] === 'root') console.log(${JSON.stringify(globalRoot)});
else if (args[0] === 'install') {
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(args));
  const file = ${JSON.stringify(manifest)};
  const pkg = JSON.parse(fs.readFileSync(file));
  pkg.version = '0.11.0';
  fs.writeFileSync(file, JSON.stringify(pkg));
} else process.exit(1);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [join(installed, 'bin', 'pingroom.js'), 'update', '--json'], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PINGROOM_HOME: join(directory, 'config'), PINGROOM_NO_UPDATE_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { current_version: '0.0.1', latest_version: '0.11.0', updated: true, update_available: false });
  assert.deepEqual(JSON.parse(readFileSync(receipt)), ['install', '--global', '@pingroom/cli@0.11.0', '--no-fund', '--no-audit']);
  assert.equal(JSON.parse(readFileSync(manifest)).version, '0.11.0');
});

// --------------------------------------------------- update notification

test('isNewer only upgrades on a strictly greater release number', async () => {
  const { isNewer } = await import('../lib/update-check.js');
  assert.equal(isNewer('0.8.0', '0.7.6'), true);
  assert.equal(isNewer('0.10.0', '0.9.0'), true);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.7.6', '0.7.6'), false);
  assert.equal(isNewer('0.7.5', '0.7.6'), false);
  // A prerelease must never trigger the notice: npm's `latest` should not point
  // at one, and guessing wrong nags on every single run.
  assert.equal(isNewer('0.8.0-beta.1', '0.7.6'), false);
  assert.equal(isNewer('', '0.7.6'), false);
  assert.equal(isNewer(null, '0.7.6'), false);
  assert.equal(isNewer('0.8.0', 'not-a-version'), false);
});

test('the update check stays silent and writes nothing when stdout is not a TTY', () => {
  // Spawned with piped stdio, i.e. exactly how CI and `pingroom … | jq` run it.
  const home = mkdtempSync(join(tmpdir(), 'pingroom-upd-'));
  const { status, stderr } = run(['skills'], {
    PINGROOM_HOME: home,
    PINGROOM_NO_UPDATE_CHECK: '',
    CI: '',
  });
  assert.equal(status, 0);
  assert.equal(stderr, '');
  assert.equal(existsSync(join(home, 'update-check.json')), false);
  rmSync(home, { recursive: true, force: true });
});

test('update help works offline and describes check and JSON', () => {
  const result = run(['update', '--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^update \(alias: upgrade\):/);
  assert.match(result.stdout, /--check/);
  assert.match(result.stdout, /--json/);
});

test('update says when min-release-age holds the newest release, and installs nothing', async (t) => {
  const result = await check(t, {}, { releaseHold: async () => '2026-12-01T10:00:00.000Z' });
  assert.equal(result.code, 1);
  assert.equal(result.body.error_code, 'release_age');
  assert.equal(result.body.held_until, '2026-12-01T10:00:00.000Z');
  assert.equal(result.body.command, 'npm install --global @pingroom/cli@0.11.0 --min-release-age=0');
  assert.match(result.body.error, /until 2026-12-01/);
  assert.deepEqual(result.installed, []);
});
test('update --check reports the hold without failing', async (t) => {
  const result = await check(t, { check: true }, { releaseHold: async () => '2026-12-01T10:00:00.000Z' });
  assert.equal(result.code, 0);
  assert.equal(result.body.update_available, true);
  assert.equal(result.body.held_until, '2026-12-01T10:00:00.000Z');
});
