// `skills` — the agent skills published at github.com/pingroom/skills.
//
// Bare `skills` prints the catalog and every install route, the same
// output-only contract `mcp` keeps. `skills install` is the one command in this
// CLI that writes outside ~/.pingroom, so it is explicit, refuses to clobber,
// and names every path it touched.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXIT } from '../constants.js';
import { fail } from '../util.js';
import { commandHelp } from '../help.js';

export const SKILLS_REPO = 'https://github.com/pingroom/skills';
const SKILLS_CLONE_URL = `${SKILLS_REPO}.git`;

// Path in the repo -> the skill directory name it installs as.
//
// The repo is laid out as two Claude Code plugins (`mcp/`, `cli/`), each with a
// `skills/<name>/` directory whose name already matches the skill's frontmatter
// `name` — that agreement is what lets the same tree also be installed with
// `/plugin marketplace add`. So the source path is deep and the install name is
// simply its last segment; a copy install and a plugin install land the same
// directory name either way.
const SKILLS = [
  {
    source: ['mcp', 'skills', 'pingroom-mcp'],
    install: 'pingroom-mcp',
    summary: 'conversational agents — the hosted MCP connector',
  },
  {
    source: ['cli', 'skills', 'pingroom-cli'],
    install: 'pingroom-cli',
    summary: 'shells, CI, and Claude Code hooks',
  },
];

export function claudeSkillsDir() {
  return process.env.CLAUDE_SKILLS_DIR || join(homedir(), '.claude', 'skills');
}

function catalogLines() {
  const width = Math.max(...SKILLS.map((s) => s.install.length));
  return SKILLS.map((s) => `  ${s.install.padEnd(width)}  ${s.summary}`).join('\n');
}

function printCatalog() {
  process.stdout.write(
`PingRoom agent skills — ${SKILLS_REPO}

${catalogLines()}

Install with this CLI (copies into ${claudeSkillsDir()}):
  pingroom skills install

Install as a Claude Code plugin (auto-updates, no copy):
  /plugin marketplace add pingroom/skills
  /plugin install pingroom-mcp
  /plugin install pingroom-cli

Or by hand:
  git clone ${SKILLS_CLONE_URL} /tmp/pingroom-skills
${SKILLS.map((s) => `  cp -r /tmp/pingroom-skills/${s.source.join('/')} ${claudeSkillsDir()}`).join('\n')}

OpenClaw (headless agents): https://pingroom.io/connect-openclaw.md

Only "pingroom skills install" writes anything; this listing does not.
`);
  return EXIT.OK;
}

function directoryExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Clone the skills repo into a fresh temp directory and return its path.
 *
 * `git` rather than a tarball fetch: the repo is public and shallow-clones in
 * one round trip, Node ships no tar reader, and vendoring one would put an
 * archive parser in the dependency-free path every ping goes through. When git
 * is missing the manual recipe above is still exact, so this fails with that
 * rather than half-installing.
 */
function cloneSkills() {
  const probe = spawnSync('git', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    fail(`git is required for "skills install".\nInstall git, or copy the skills by hand:\n  pingroom skills`, EXIT.ERROR);
  }

  const workspace = mkdtempSync(join(tmpdir(), 'pingroom-skills-'));
  const clone = spawnSync(
    'git',
    ['clone', '--depth', '1', '--quiet', SKILLS_CLONE_URL, workspace],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
  );

  if (clone.error || clone.status !== 0) {
    rmSync(workspace, { recursive: true, force: true });
    const detail = (clone.stderr || clone.error?.message || 'git clone failed').trim().split('\n')[0];
    fail(`could not fetch ${SKILLS_REPO}: ${detail}`, EXIT.ERROR);
  }

  return workspace;
}

function install(args) {
  const target = args.dir ? String(args.dir) : claudeSkillsDir();
  const force = Boolean(args.force);

  // Resolve collisions BEFORE the network call. Cloning first and refusing
  // afterwards would spend the round trip to tell the operator something that
  // was knowable from the filesystem alone.
  if (!force) {
    const existing = SKILLS.filter((s) => directoryExists(join(target, s.install)));
    if (existing.length > 0) {
      const names = existing.map((s) => join(target, s.install)).join('\n  ');
      fail(
        `already installed:\n  ${names}\nRe-run with --force to replace ${existing.length === 1 ? 'it' : 'them'}.`,
        EXIT.USAGE,
      );
    }
  }

  const workspace = cloneSkills();
  const installed = [];
  try {
    for (const skill of SKILLS) {
      const from = join(workspace, ...skill.source);
      if (!directoryExists(from)) {
        fail(`${SKILLS_REPO} has no "${skill.source.join('/')}" directory — the repo layout changed.`, EXIT.ERROR);
      }
      const to = join(target, skill.install);
      mkdirSync(target, { recursive: true });
      // Replace rather than merge: a stale SKILL.md left beside a new one is a
      // skill that half-describes two versions, and Claude Code would load it.
      rmSync(to, { recursive: true, force: true });
      cpSync(from, to, { recursive: true });
      installed.push({ name: skill.install, path: to, files: countFiles(to) });
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  const lines = installed.map((s) => `  ${s.name} -> ${s.path} (${s.files} file${s.files === 1 ? '' : 's'})`);
  process.stdout.write(
`Installed ${installed.length} skill${installed.length === 1 ? '' : 's'}:
${lines.join('\n')}

Restart Claude Code (or start a new session) to load them.
Connect the MCP server so the pingroom-mcp skill has tools to call:
  pingroom mcp
`);
  return EXIT.OK;
}

function countFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return total;
}

export function skills(args) {
  if (args.help) { process.stdout.write(`${commandHelp('skills')}\n`); return EXIT.OK; }

  const [sub] = args._;
  if (sub === undefined || sub === 'list') return printCatalog();
  if (sub === 'install') return install(args);

  fail('usage: pingroom skills [list|install] [--dir <path>] [--force]', EXIT.USAGE);
}
