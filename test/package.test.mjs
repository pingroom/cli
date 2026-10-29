import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { commandHelp } from '../lib/help.js';
import { run } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(root, name), 'utf8');
const pkg = JSON.parse(read('package.json'));

// CL-10: Node 20 (engines >=20) does not expand a glob handed to --test, so a
// quoted pattern in the script failed `npm test` for anyone on it. The shell
// expands an unquoted one, which is what ci.yml now runs through `npm test`.
test('npm test leaves its file pattern to the shell, so it works on Node 20', () => {
  const script = pkg.scripts.test;
  assert.match(script, /^node --test /);
  assert.doesNotMatch(script, /["']/, 'a quoted glob is passed to node literally, and Node 20 does not expand it');
  assert.match(script, /test\/\*\.test\.mjs$/);
  assert.match(read('.github/workflows/ci.yml'), /^\s*- run: npm test$/m);
});

// CL-08: action.yml runs `npx --yes @pingroom/cli@<version>`, which resolves the
// CLI's own dependencies by range at run time in a process that holds the
// token and the webhook secret. npm honours a published npm-shrinkwrap.json for
// an installed package, and npx installs one, so shipping the lockfile's
// resolution pins the transitive tree to what was tested. It is a copy of
// package-lock.json (kept in step by this test): `npm shrinkwrap` would rename
// the lockfile instead, and `npm install` rewrites whichever of the two exists.
test('the package ships an npm-shrinkwrap.json that pins what package-lock.json resolves', () => {
  assert.ok(pkg.files.includes('npm-shrinkwrap.json'), 'package.json files must include npm-shrinkwrap.json');
  const shrinkwrap = JSON.parse(read('npm-shrinkwrap.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.deepEqual(shrinkwrap, lock, 'npm-shrinkwrap.json drifted from package-lock.json: copy one over the other');

  assert.equal(shrinkwrap.name, pkg.name);
  assert.equal(shrinkwrap.version, pkg.version, 'bump the version in npm-shrinkwrap.json together with package.json');
  assert.deepEqual(shrinkwrap.packages[''].dependencies, pkg.dependencies);

  // Every installed package is pinned to an exact version with an integrity hash.
  const installed = Object.entries(shrinkwrap.packages).filter(([path]) => path !== '');
  assert.ok(installed.length >= Object.keys(pkg.dependencies).length);
  for (const [path, entry] of installed) {
    assert.match(entry.version, /^\d+\.\d+\.\d+$/, path);
    assert.match(entry.integrity ?? '', /^sha512-/, `${path} has no integrity hash`);
    assert.match(entry.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//, `${path} does not resolve to the registry`);
  }
  // The tree is closed: every dependency a pinned package asks for is in it.
  for (const [path, entry] of installed) {
    for (const dependency of Object.keys(entry.dependencies ?? {})) {
      assert.ok(shrinkwrap.packages[`node_modules/${dependency}`], `${path} needs ${dependency}, which is not pinned`);
    }
  }
});

test('the tarball includes the shrinkwrap and no test file', () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
  assert.ok(files.includes('npm-shrinkwrap.json'));
  assert.ok(files.includes('bin/pingroom.js'));
  assert.equal(files.some((path) => path.startsWith('test/')), false);
});

// CL-10: every `<command> --help` listed `-v, --version`, which only works as
// the first argument (pingroom -v). `pingroom listen -v` is an unknown option.
test('per-command help does not advertise -v, which only works at the top level', () => {
  for (const command of ['ping', 'ask', 'list', 'watch', 'cancel', 'listen', 'handoff', 'handoffs', 'live', 'hook', 'webhooks']) {
    const { status, stdout } = run([command, '--help']);
    assert.equal(status, 0, command);
    assert.doesNotMatch(stdout, /--version|^\s+-v,/m, `${command} --help lists -v`);
    assert.match(stdout, /^\S[^\n]*:\n/, `${command} --help prints its own section`);
  }
  // ...and the claim it no longer makes really is false:
  for (const command of ['listen', 'watch', 'ping']) {
    const { status, stderr } = run([command, '-v']);
    assert.equal(status, 2, command);
    assert.match(stderr, /Unknown option: -v/);
  }
  // The top level still documents the working spelling, and says where it works.
  const top = run(['--help']).stdout;
  assert.match(top, /-v, --version\s+Show the CLI version \(first argument only: pingroom -v\)/);
  assert.equal(run(['-v']).stdout.trim(), pkg.version);
});

test('handoff --timeout help states the range the code applies', () => {
  assert.match(commandHelp('handoff'), /--timeout <sec>\s+Per long-poll hold with --wait \(0–25, default 20\)/);
  assert.doesNotMatch(commandHelp('handoff'), /0–20/);
});

// CL-09: the README's room-ask example pinned @v0.7.5 while the same page tells
// readers to use v0.11.0 or newer for GitHub Actions. The ask example must pin an
// exact tag (the test in action.test.mjs), and that tag must honour the floor.
test('README Action examples never pin below the floor the README itself states', () => {
  const readme = read('README.md');
  const floor = readme.match(/use `pingroom\/cli@v(\d+)\.(\d+)\.(\d+)` or a newer release/)?.slice(1).map(Number);
  assert.ok(floor, 'the README no longer states the minimum Action version');
  const pins = [...readme.matchAll(/uses: pingroom\/cli@v(\d+)\.(\d+)\.(\d+)\s*$/gm)].map((m) => m.slice(1).map(Number));
  assert.ok(pins.length > 0, 'the README has no exact-tag Action example left to check');
  for (const pin of pins) {
    const [a, b, c] = pin.map((part, i) => part - floor[i]);
    assert.ok(a > 0 || (a === 0 && (b > 0 || (b === 0 && c >= 0))), `README pins pingroom/cli@v${pin.join('.')}, below the stated floor v${floor.join('.')}`);
  }
});
