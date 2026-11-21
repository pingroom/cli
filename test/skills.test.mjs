import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { run, runAsync } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED = join(ROOT, 'skills');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// Each bundled skill and every file it ships.
const BUNDLE = {
  'pingroom-cli': ['SKILL.md'],
  'pingroom-mcp': ['SKILL.md', 'references/tools.md'],
};
const bundled = (skill, file) => readFileSync(join(BUNDLED, skill, ...file.split('/')));

// A PATH whose only git fails, so a test proves a command never needed it.
function brokenGitPath(root) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho "git must not run" >&2\nexit 1\n', { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

// --------------------------------------------------------------- skills

test('skills lists both published skills and every install route', () => {
  const { status, stdout } = run(['skills']);
  assert.equal(status, 0);
  assert.match(stdout, /https:\/\/github\.com\/pingroom\/skills/);
  assert.match(stdout, /pingroom-mcp/);
  assert.match(stdout, /pingroom-cli/);
  // The three routes: this CLI, the Claude Code plugin system, and by hand.
  assert.match(stdout, /pingroom skills install/);
  assert.match(stdout, /pingroom skills install --latest/);
  assert.match(stdout, /pingroom skills show pingroom-mcp/);
  assert.match(stdout, /\/plugin marketplace add pingroom\/skills/);
  assert.match(stdout, /git clone https:\/\/github\.com\/pingroom\/skills\.git/);
  // Same output-only promise `mcp` makes.
  assert.match(stdout, /does not\.$/m);
});

test('skills is registered in the top-level help', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /^  skills      List, print or install the PingRoom agent skills/m);
  // Where an agent reading the top-level help learns how to use this CLI.
  assert.match(stdout, /^  pingroom skills show {9}How to use this CLI, written for agents$/m);
  assert.match(run(['help', 'all']).stdout, /^skills:$/m);
});

test('skills --help does not advertise credential flags it cannot use', () => {
  // `skills` talks to GitHub, never the PingRoom API. Printing --token/--api/
  // --json here would describe flags its parser rejects.
  const { status, stdout } = run(['skills', '--help']);
  assert.equal(status, 0);
  assert.match(stdout, /pingroom skills install/);
  assert.doesNotMatch(stdout, /--token/);
  assert.doesNotMatch(stdout, /--api /);
  assert.doesNotMatch(stdout, /--json/);
});

test('skills rejects an unknown sub-command as a usage error', () => {
  const { status, stderr } = run(['skills', 'bogus']);
  assert.equal(status, 2);
  assert.match(stderr, /usage: pingroom skills \[list\|show /);
});

test('skills install refuses to clobber before it touches the network', () => {
  // The collision check runs BEFORE the clone on purpose: cloning first would
  // spend a network round trip to report something the filesystem already knew.
  // That ordering is what lets this test assert the guard with no network.
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-skills-'));
  mkdirSync(join(dir, 'pingroom-mcp'), { recursive: true });
  const { status, stderr } = run(['skills', 'install', '--dir', dir]);
  assert.equal(status, 2);
  assert.match(stderr, /already installed/);
  assert.match(stderr, /pingroom-mcp/);
  assert.match(stderr, /--force/);
  // Nothing was created for the skill that had not been installed yet.
  assert.equal(existsSync(join(dir, 'pingroom-cli')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('a failed skills install --latest still removes its temporary clone', async () => {
  // fail() inside install()'s try/finally used to exit before the finally ran,
  // leaving the clone in the temp directory. A stand-in `git` "clones" an empty
  // tree, so the layout check fails with nothing reaching the network.
  const root = mkdtempSync(join(tmpdir(), 'pingroom-skills-fail-'));
  const bin = join(root, 'bin');
  const temp = join(root, 'tmp');
  const target = join(root, 'skills');
  mkdirSync(bin);
  mkdirSync(temp);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    const { status, stderr } = await runAsync(['skills', 'install', '--latest', '--dir', target], {
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: temp,
      // The audit preload intercepts `git clone`; this git never leaves the machine.
      NODE_OPTIONS: undefined,
    });
    assert.equal(status, 1, stderr);
    assert.match(stderr, /the repo layout changed/);
    assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith('pingroom-skills-')), []);
    assert.equal(existsSync(join(target, 'pingroom-mcp')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------- bundled skills

test('the package bundles both skills, each under its own front-matter name', () => {
  assert.deepEqual(readdirSync(BUNDLED).sort(), Object.keys(BUNDLE).sort());
  for (const [skill, files] of Object.entries(BUNDLE)) {
    const listed = [];
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), relative);
        else listed.push(relative);
      }
    };
    walk(join(BUNDLED, skill), '');
    assert.deepEqual(listed.sort(), files, skill);
    assert.match(bundled(skill, 'SKILL.md').toString('utf8'), new RegExp(`^---\nname: ${skill}\n`), skill);
  }
});

test('the bundled skills are byte copies of the skills repo, when it is checked out beside', (t) => {
  // In the monorepo the skills repo sits next to this one; a lone checkout of
  // the CLI has no copy to compare with, and check-lockstep covers the pair.
  const repo = join(ROOT, '..', 'skills');
  const sources = { 'pingroom-cli': ['cli', 'skills', 'pingroom-cli'], 'pingroom-mcp': ['mcp', 'skills', 'pingroom-mcp'] };
  if (!existsSync(join(repo, ...sources['pingroom-cli']))) { t.skip('no skills checkout beside the CLI'); return; }
  for (const [skill, files] of Object.entries(BUNDLE)) {
    for (const file of files) {
      const source = readFileSync(join(repo, ...sources[skill], ...file.split('/')));
      assert.ok(source.equals(bundled(skill, file)), `${skill}/${file} differs from the skills repo: copy it into cli/skills again`);
    }
  }
});

test('skills show prints the CLI skill byte for byte, without git or the network', () => {
  const root = mkdtempSync(join(tmpdir(), 'pingroom-skills-show-'));
  try {
    const PATH = brokenGitPath(root);
    for (const [args, skill, file] of [
      [['skills', 'show'], 'pingroom-cli', 'SKILL.md'],
      [['skills', 'show', 'pingroom-cli'], 'pingroom-cli', 'SKILL.md'],
      [['skills', 'show', 'pingroom-mcp'], 'pingroom-mcp', 'SKILL.md'],
      [['skills', 'show', 'pingroom-mcp', 'references/tools.md'], 'pingroom-mcp', 'references/tools.md'],
    ]) {
      const { status, stdout, stderr } = run(args, { PATH });
      assert.equal(status, 0, `${args.join(' ')}: ${stderr}`);
      assert.equal(stderr, '');
      assert.equal(stdout, bundled(skill, file).toString('utf8'), args.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skills show refuses a skill or file the bundle does not have', () => {
  const unknown = run(['skills', 'show', 'pingroom-nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown skill\. Choose one of: pingroom-mcp, pingroom-cli/);
  assert.equal(unknown.stdout, '');

  // The file is matched against the skill's own list, never joined onto a
  // path, so nothing outside the skill can be printed.
  for (const file of ['references/nope.md', '../../package.json', '../pingroom-cli/SKILL.md', 'references', '/etc/passwd']) {
    const { status, stdout, stderr } = run(['skills', 'show', 'pingroom-mcp', file]);
    assert.equal(status, 2, file);
    assert.equal(stdout, '', file);
    assert.match(stderr, /"pingroom-mcp" has no such file\. Its files:\n  SKILL\.md\n  references\/tools\.md/, file);
  }

  const extra = run(['skills', 'show', 'pingroom-mcp', 'SKILL.md', 'more']);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /usage: pingroom skills/);
});

test('install-only flags are refused outside skills install', () => {
  for (const args of [['skills', 'show', '--force'], ['skills', '--latest'], ['skills', 'list', '--dir', '/tmp/x']]) {
    const { status, stdout, stderr } = run(args);
    assert.equal(status, 2, args.join(' '));
    assert.equal(stdout, '', args.join(' '));
    assert.match(stderr, /--dir, --force and --latest apply to "skills install" only/, args.join(' '));
  }
  const extra = run(['skills', 'list', 'more']);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /usage: pingroom skills/);
  const installExtra = run(['skills', 'install', 'pingroom-cli']);
  assert.equal(installExtra.status, 2);
  assert.match(installExtra.stderr, /usage: pingroom skills/);
});

test('skills install copies the bundled skills, with no git and no temporary clone', () => {
  const root = mkdtempSync(join(tmpdir(), 'pingroom-skills-install-'));
  const temp = join(root, 'tmp');
  const target = join(root, 'skills');
  mkdirSync(temp);
  try {
    const { status, stdout, stderr } = run(['skills', 'install', '--dir', target], { PATH: brokenGitPath(root), TMPDIR: temp });
    assert.equal(status, 0, stderr);
    assert.match(stdout, new RegExp(`^Installed 2 skills from the copies bundled with this CLI \\(${VERSION.replaceAll('.', '\\.')}\\):$`, 'm'));
    assert.match(stdout, /pingroom-mcp -> .*pingroom-mcp \(2 files\)/);
    assert.match(stdout, /pingroom-cli -> .*pingroom-cli \(1 file\)/);
    for (const [skill, files] of Object.entries(BUNDLE)) {
      for (const file of files) {
        assert.ok(readFileSync(join(target, skill, ...file.split('/'))).equals(bundled(skill, file)), `${skill}/${file}`);
      }
    }
    assert.deepEqual(readdirSync(temp), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skills install --force replaces an installed skill, leaving no stale file behind', () => {
  const root = mkdtempSync(join(tmpdir(), 'pingroom-skills-force-'));
  const target = join(root, 'skills');
  mkdirSync(join(target, 'pingroom-mcp'), { recursive: true });
  writeFileSync(join(target, 'pingroom-mcp', 'SKILL.md'), 'old\n');
  writeFileSync(join(target, 'pingroom-mcp', 'stale.md'), 'from an older release\n');
  try {
    const { status, stderr } = run(['skills', 'install', '--force', '--dir', target], { PATH: brokenGitPath(root) });
    assert.equal(status, 0, stderr);
    assert.ok(readFileSync(join(target, 'pingroom-mcp', 'SKILL.md')).equals(bundled('pingroom-mcp', 'SKILL.md')));
    assert.equal(existsSync(join(target, 'pingroom-mcp', 'stale.md')), false);
    assert.deepEqual(readdirSync(target).sort(), ['pingroom-cli', 'pingroom-mcp']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skills install --latest says how to install without git when git is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pingroom-skills-nogit-'));
  try {
    const { status, stderr } = run(['skills', 'install', '--latest', '--dir', join(root, 'skills')], { PATH: brokenGitPath(root) });
    assert.equal(status, 1);
    assert.match(stderr, /git is required for "skills install --latest"/);
    assert.match(stderr, /pingroom skills install$/m);
    assert.equal(existsSync(join(root, 'skills')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
