import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { run, runAsync } from './helpers.mjs';

// --------------------------------------------------------------- skills

test('skills lists both published skills and every install route', () => {
  const { status, stdout } = run(['skills']);
  assert.equal(status, 0);
  assert.match(stdout, /https:\/\/github\.com\/pingroom\/skills/);
  assert.match(stdout, /pingroom-mcp/);
  assert.match(stdout, /pingroom-cli/);
  // The three routes: this CLI, the Claude Code plugin system, and by hand.
  assert.match(stdout, /pingroom skills install/);
  assert.match(stdout, /\/plugin marketplace add pingroom\/skills/);
  assert.match(stdout, /git clone https:\/\/github\.com\/pingroom\/skills\.git/);
  // Same output-only promise `mcp` makes.
  assert.match(stdout, /does not\.$/m);
});

test('skills is registered in the top-level help', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /^  skills   List the PingRoom agent skills/m);
  assert.match(stdout, /^skills:$/m);
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
  assert.match(stderr, /usage: pingroom skills \[list\|install\]/);
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

test('a failed skills install still removes its temporary clone', async () => {
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
    const { status, stderr } = await runAsync(['skills', 'install', '--dir', target], {
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
