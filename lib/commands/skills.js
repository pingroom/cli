// `skills` — the agent skills published at github.com/pingroom/skills.
//
// Bare `skills` prints the catalog and every install route, the same
// output-only contract `mcp` keeps. `skills show` prints one skill to stdout.
// `skills install` is the one command in this CLI that writes outside
// ~/.pingroom, so it is explicit, refuses to clobber, and names every path it
// touched.
//
// Both skills ship inside this package (`files` lists `skills/`), so `show` and
// `install` need neither git nor the network, and the CLI skill an agent reads
// describes the commands of the CLI it runs. GitHub can be ahead of a release,
// and an agent told to use a flag its CLI does not have yet fails (it happened
// on 2026-09-03). `install --latest` still fetches the newest copy from GitHub.
// The bundled copies agree with the skills repo byte for byte, which
// knowledge/tools/check-lockstep.mjs ("cli skills") checks.

import { spawnSync } from 'node:child_process';
import { constants, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../constants.js';
import { fail } from '../util.js';
import { commandHelp } from '../help.js';
import { VERSION } from '../version.js';

export const SKILLS_REPO = 'https://github.com/pingroom/skills';
const SKILLS_CLONE_URL = `${SKILLS_REPO}.git`;

/** Where this package keeps its copy of each skill, one directory per install name. */
export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url));

// Path in the repo -> the skill directory name it installs as.
//
// The repo is laid out as two Claude Code plugins (`mcp/`, `cli/`), each with a
// `skills/<name>/` directory whose name already matches the skill's frontmatter
// `name` — that agreement is what lets the same tree also be installed with
// `/plugin marketplace add`. So the source path is deep and the install name is
// simply its last segment; a copy install and a plugin install land the same
// directory name either way. The bundled copy sits at `skills/<install>/`.
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

// What `skills show` prints with no name: the skill for the CLI that is running.
const DEFAULT_SHOW = 'pingroom-cli';
const SKILL_FILE = 'SKILL.md';

const USAGE = 'usage: pingroom skills [list|show [<skill>] [<file>]|install [--dir <path>] [--force] [--latest]]';

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

Read one here (both ship inside this CLI):
  pingroom skills show                 how to use this CLI
  pingroom skills show pingroom-mcp    how to use the MCP tools

Install with this CLI (copies them into ${claudeSkillsDir()}):
  pingroom skills install              the copies bundled with this CLI
  pingroom skills install --latest     the newest from GitHub (needs git)

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

function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Every regular file under `dir`, as a `/`-separated path relative to it,
 * sorted. A symbolic link is never listed, so `show` cannot be pointed through
 * one at another file on this machine.
 */
function regularFiles(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...regularFiles(join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

function bundledSkillDir(skill) {
  const dir = join(BUNDLED_SKILLS_DIR, skill.install);
  if (!directoryExists(dir)) {
    fail(`this CLI's copy of "${skill.install}" is missing (${dir}). Reinstall the CLI, or run: pingroom skills install --latest`, EXIT.ERROR);
  }
  return dir;
}

/**
 * Print one bundled skill file to stdout, byte for byte, so an agent in any
 * shell can read it and `> SKILL.md` saves a working skill. The file must be
 * one the skill really has: the argument is matched against its file list,
 * never joined onto a path.
 */
function show(args) {
  const [, name = DEFAULT_SHOW, file = SKILL_FILE, ...extra] = args._;
  if (extra.length > 0) fail(USAGE, EXIT.USAGE);

  const skill = SKILLS.find((s) => s.install === name);
  if (!skill) {
    fail(`unknown skill. Choose one of: ${SKILLS.map((s) => s.install).join(', ')}`, EXIT.USAGE);
  }
  const dir = bundledSkillDir(skill);
  const files = regularFiles(dir);
  if (!files.includes(file)) {
    fail(`"${skill.install}" has no such file. Its files:\n  ${files.join('\n  ')}`, EXIT.USAGE);
  }
  process.stdout.write(readFileSync(join(dir, ...file.split('/'))));
  return EXIT.OK;
}

/**
 * Clone the skills repo into a fresh temp directory and return its path.
 *
 * `git` rather than a tarball fetch: the repo is public and shallow-clones in
 * one round trip, Node ships no tar reader, and vendoring one would put an
 * archive parser in the dependency-free path every ping goes through. When git
 * is missing the bundled copies are still one flag away, so this fails with
 * that rather than half-installing.
 */
const CLONE_TIMEOUT_MS = 120_000;

function cloneSkills() {
  const probe = spawnSync('git', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    fail(`git is required for "skills install --latest".\nInstall git, or install the copies bundled with this CLI:\n  pingroom skills install`, EXIT.ERROR);
  }

  const workspace = mkdtempSync(join(tmpdir(), 'pingroom-skills-'));
  const clone = spawnSync(
    'git',
    ['clone', '--depth', '1', '--quiet', SKILLS_CLONE_URL, workspace],
    // Never wait on a credential prompt or a stalled network.
    {
      stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  );

  if (clone.error || clone.status !== 0) {
    rmSync(workspace, { recursive: true, force: true });
    const detail = (clone.stderr || clone.error?.message || 'git clone failed').trim().split('\n')[0];
    fail(`could not fetch ${SKILLS_REPO}: ${detail}`, EXIT.ERROR);
  }

  return workspace;
}

function install(args) {
  if (args._.length > 1) fail(USAGE, EXIT.USAGE);
  const target = args.dir ? String(args.dir) : claudeSkillsDir();
  const force = Boolean(args.force);
  const latest = Boolean(args.latest);

  // Resolve collisions BEFORE the network call. Cloning first and refusing
  // afterwards would spend the round trip to tell the operator something that
  // was knowable from the filesystem alone.
  if (!force) {
    const existing = SKILLS.filter((s) => entryExists(join(target, s.install)));
    if (existing.length > 0) {
      const names = existing.map((s) => join(target, s.install)).join('\n  ');
      fail(
        `destination already exists:\n  ${names}\nRe-run with --force to replace ${existing.length === 1 ? 'it' : 'them'}.`,
        EXIT.USAGE,
      );
    }
  }

  const workspace = latest ? cloneSkills() : null;
  const origin = latest ? SKILLS_REPO : `the copies bundled with this CLI (${VERSION})`;
  const installed = [];
  try {
    for (const skill of SKILLS) {
      let from;
      if (workspace) {
        from = join(workspace, ...skill.source);
        if (!directoryExists(from)) {
          fail(`${SKILLS_REPO} has no "${skill.source.join('/')}" directory — the repo layout changed.`, EXIT.ERROR);
        }
      } else {
        from = bundledSkillDir(skill);
      }
      const to = join(target, skill.install);
      // A skill is instructions an agent trusts. A link in the source would
      // install as a pointer at some other file on this machine.
      const link = firstSymlink(from);
      if (link) fail(`${latest ? SKILLS_REPO : 'this CLI\'s bundled copy'} contains a symbolic link (${link}); nothing was installed from "${skill.install}".`, EXIT.ERROR);
      mkdirSync(target, { recursive: true });
      // Stage before replacing an explicitly forced destination. Otherwise,
      // reserve the new directory and never overwrite a late arrival.
      const staging = `${to}.new-${process.pid}`;
      rmSync(staging, { recursive: true, force: true });
      try {
        cpSync(from, staging, { recursive: true });
        if (force) {
          rmSync(to, { recursive: true, force: true });
          renameSync(staging, to);
        } else {
          mkdirSync(to);
          for (const entry of readdirSync(staging)) {
            cpSync(join(staging, entry), join(to, entry), { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_EXCL });
          }
          rmSync(staging, { recursive: true, force: true });
        }
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        const recovery = force ? '' : '\nInstallation incomplete; existing entries were not replaced. Inspect the destination before retrying; files already copied were left in place.';
        fail(`could not install "${skill.install}" into ${target}: ${error?.code ?? 'copy failed'}${recovery}`, EXIT.ERROR);
      }
      installed.push({ name: skill.install, path: to, files: countFiles(to) });
    }
  } finally {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }

  const lines = installed.map((s) => `  ${s.name} -> ${s.path} (${s.files} file${s.files === 1 ? '' : 's'})`);
  process.stdout.write(
`Installed ${installed.length} skill${installed.length === 1 ? '' : 's'} from ${origin}:
${lines.join('\n')}

Restart Claude Code (or start a new session) to load them.
Connect the MCP server so the pingroom-mcp skill has tools to call:
  pingroom mcp
`);
  return EXIT.OK;
}

/** The first symbolic link under `dir`, relative to it, or null. */
function firstSymlink(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) return relative;
    if (entry.isDirectory()) {
      const nested = firstSymlink(join(dir, entry.name), relative);
      if (nested) return nested;
    }
  }
  return null;
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
  if (sub === 'install') return install(args);
  // --dir, --force and --latest say how to install; anywhere else they would
  // parse and be ignored.
  if (sub === undefined || sub === 'list' || sub === 'show') {
    if (args.dir !== undefined || args.force || args.latest) {
      fail('--dir, --force and --latest apply to "skills install" only', EXIT.USAGE);
    }
    if (sub === 'show') return show(args);
    if (args._.length > 1) fail(USAGE, EXIT.USAGE);
    return printCatalog();
  }

  fail(USAGE, EXIT.USAGE);
}
