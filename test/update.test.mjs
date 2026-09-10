import test from 'node:test';
import assert from 'node:assert/strict';
import { update } from '../lib/commands/update.js';
import { parseUpdateArgs } from '../lib/parser.js';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

async function check(t, args, overrides = {}) {
  let output = '';
  const installed = [];
  t.mock.method(process.stdout, 'write', (value) => { output += value; return true; });
  const code = await update({ _: [], json: true, ...args }, {
    currentVersion: '0.10.3', latestVersion: async () => '0.11.0',
    isGlobalInstall: async () => true, install: async (version) => installed.push(version), ...overrides,
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
test('update refuses local, npx, and linked source installations', async (t) => {
  const result = await check(t, {}, { isGlobalInstall: async () => false });
  assert.equal(result.code, 2);
  assert.match(result.body.error, /requires an npm global installation/);
  assert.deepEqual(result.installed, []);
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
