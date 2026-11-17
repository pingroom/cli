// `pingroom update` (alias `upgrade`): install the newest release over an npm
// global install. A copy installed any other way is never touched; the command
// names the one line that updates it instead.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EXIT } from '../constants.js';
import { VERSION } from '../version.js';
import { commandHelp } from '../help.js';
import { isNewer } from '../update-check.js';
import { stripControlChars } from '../util.js';

const run = promisify(execFile);
const PACKAGE = '@pingroom/cli';
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const VIEW_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;

async function npm(args, timeout = VIEW_TIMEOUT_MS) {
  // From the home directory, so the lookup and the global install read the same
  // npm config: a project .npmrc in the working directory applies to `npm view`
  // but never to `npm install --global`.
  const options = { timeout, maxBuffer: 1024 * 1024, cwd: homedir() };
  // Windows needs npm's JS entry to avoid running npm.cmd through a shell.
  if (process.platform === 'win32') {
    return run(process.execPath, [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args], options);
  }
  return run('npm', args, options);
}

/**
 * Which tool owns the copy at `root`, read from the path each one installs to.
 * Returns null for a path no tool claims: an npm global install, a project
 * dependency and a source checkout all look alike from the path alone.
 */
export function installerFromPath(root) {
  const path = root.replaceAll('\\', '/').toLowerCase();
  if (path.includes('/_npx/')) return 'npx';
  if (path.includes('/pnpm/global/')) return 'pnpm';
  if (path.includes('/.bun/install/global/')) return 'bun';
  if (/\/yarn\/(?:data\/)?global\//.test(path)) return 'yarn';
  if (path.includes('/.volta/') || path.includes('/volta/tools/')) return 'volta';
  return null;
}

/** The line that updates an install this command will not touch itself. */
export function manualUpdate(kind, version) {
  const target = `${PACKAGE}@${version}`;
  switch (kind) {
    case 'npx': return { why: 'You are running pingroom through npx, so there is no installation to update.', command: `npx --yes ${PACKAGE}@latest` };
    case 'pnpm': return { why: 'This copy was installed with pnpm.', command: `pnpm add --global ${target}` };
    case 'bun': return { why: 'This copy was installed with bun.', command: `bun add --global ${target}` };
    case 'yarn': return { why: 'This copy was installed with yarn.', command: `yarn global add ${target}` };
    case 'volta': return { why: 'This copy was installed with Volta.', command: `volta install ${target}` };
    case 'source': return { why: 'This copy is a source checkout.', command: 'git pull' };
    default: return { why: 'This copy is a dependency of a project, not a global install.', command: `npm install ${target}`, where: ' in that project' };
  }
}

/**
 * Why npm failed, from its error code alone. npm's own output can carry
 * registry configuration and tokens, so none of it is echoed.
 */
export function explainNpmFailure(error, version) {
  const target = `${PACKAGE}@${version ?? 'latest'}`;
  const install = `npm install --global ${target}`;
  const npmCode = /^npm (?:error|ERR!) code (\S+)/m.exec(String(error?.stderr ?? ''))?.[1] ?? '';
  if (error?.code === 'ENOENT') {
    return { error_code: 'npm_missing', error: 'npm was not found on your PATH. Install Node.js with npm, then retry.' };
  }
  if (error?.killed) {
    return { error_code: 'timeout', error: `npm did not finish in time. Retry, or run: ${install}`, command: install };
  }
  if (npmCode === 'ETARGET') {
    const command = `${install} --min-release-age=0`;
    return {
      error_code: 'release_age',
      error: `npm would not install ${target}. The registry has it, so a release-age setting in your npm config (min-release-age or before) is holding new releases back. pingroom update installs it once it is old enough. To take it now: ${command}`,
      command,
    };
  }
  if (npmCode === 'EACCES' || npmCode === 'EPERM') {
    if (process.platform === 'win32') {
      return { error_code: 'permission', error: `npm may not write to its global directory. Open the terminal as Administrator and run: ${install}`, command: install };
    }
    const command = `sudo ${install}`;
    return { error_code: 'permission', error: `npm may not write to its global directory. Run: ${command}`, command };
  }
  if (['E401', 'E403', 'ENEEDAUTH'].includes(npmCode)) {
    return { error_code: 'registry_auth', error: 'The npm registry refused the request. Check "npm whoami" and the registry in your npm config, then retry.' };
  }
  if (['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_SOCKET_TIMEOUT'].includes(npmCode)) {
    return { error_code: 'network', error: 'npm could not reach its registry. Check your connection, then retry.' };
  }
  return { error_code: 'npm_failed', error: `npm could not complete the update. To see why, run: ${install}`, command: install };
}

/**
 * When npm's min-release-age keeps `version` from installing: the ISO time it
 * becomes installable, or null when nothing holds it (or it cannot be told;
 * the install then reports ETARGET itself).
 */
async function releaseHold(version) {
  try {
    const days = Number(JSON.parse((await npm(['config', 'get', 'min-release-age', '--json'])).stdout));
    if (!Number.isFinite(days) || days <= 0) return null;
    // Exclusions use npm's glob rules and can exempt this package. Do not
    // guess which patterns match or block an allowed update: let npm decide
    // during install, with the caller's policy unchanged.
    const exclusions = (await npm(['config', 'get', 'min-release-age-exclude'])).stdout.trim();
    if (exclusions) return null;
    const times = JSON.parse((await npm(['view', PACKAGE, 'time', '--json'])).stdout);
    const published = Date.parse(times?.[version]);
    if (!Number.isFinite(published)) return null;
    const until = published + days * 24 * 60 * 60 * 1000;
    return until > Date.now() ? new Date(until).toISOString() : null;
  } catch {
    return null;
  }
}

const defaults = {
  currentVersion: VERSION,
  releaseHold,
  async latestVersion() {
    const { stdout } = await npm(['view', `${PACKAGE}@latest`, 'version', '--json']);
    return JSON.parse(stdout);
  },
  // 'npm' is the only kind this command installs over.
  async installKind() {
    const installer = installerFromPath(packageRoot);
    if (installer) return installer;
    // An npm-linked checkout resolves here too: its real path is the checkout.
    if (existsSync(join(packageRoot, '.git'))) return 'source';
    try {
      const { stdout } = await npm(['root', '--global']);
      const installed = join(stdout.trim(), '@pingroom', 'cli');
      const isGlobal = !(await lstat(installed)).isSymbolicLink() && await realpath(installed) === await realpath(packageRoot);
      return isGlobal ? 'npm' : 'local';
    } catch {
      return 'local';
    }
  },
  async install(version) {
    await npm(['install', '--global', `${PACKAGE}@${version}`, '--no-fund', '--no-audit'], INSTALL_TIMEOUT_MS);
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (pkg.version !== version) throw new Error('npm finished, but this installation did not update. Check your PATH and npm prefix.');
  },
};

export async function update(args, dependencies = {}) {
  if (args.help) { process.stdout.write(`${commandHelp('update')}\n`); return EXIT.OK; }
  const ops = { ...defaults, ...dependencies };
  const report = (result) => {
    if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (result.error) process.stderr.write(`error: ${result.error}\n`);
    else if (result.updated) process.stdout.write(`Updated PingRoom CLI ${result.current_version} → ${result.latest_version}.\n`);
    else if (result.update_available && result.held_until) process.stdout.write(`PingRoom CLI ${result.latest_version} is available (installed: ${result.current_version}), but min-release-age in your npm config holds it until ${result.held_until.slice(0, 10)}. To take it now: ${result.command}\n`);
    else if (result.update_available) process.stdout.write(`PingRoom CLI ${result.latest_version} is available (installed: ${result.current_version}). Run pingroom update.\n`);
    else process.stdout.write(`PingRoom CLI ${result.current_version} is up to date.\n`);
  };
  if (args._?.length) {
    report({ error: 'Usage: pingroom update [--check] [--json]' });
    return EXIT.USAGE;
  }
  let result = { current_version: ops.currentVersion, updated: false };
  try {
    const latest = await ops.latestVersion();
    if (typeof latest !== 'string' || !/^\d+\.\d+\.\d+$/.test(latest)) {
      throw new Error('npm returned an invalid stable version; no update was installed.');
    }
    result = { ...result, latest_version: latest, update_available: isNewer(latest, ops.currentVersion) };
    if (result.update_available && args.check) {
      const heldUntil = await ops.releaseHold(latest);
      if (heldUntil) result = { ...result, held_until: heldUntil, command: `npm install --global ${PACKAGE}@${latest} --min-release-age=0` };
    }
    if (result.update_available && !args.check) {
      const kind = await ops.installKind();
      if (kind !== 'npm') {
        const { why, command, where = '' } = manualUpdate(kind, latest);
        report({ ...result, install: kind, command, error: `${why} To get ${latest}, run${where}: ${command}` });
        return EXIT.USAGE;
      }
      const heldUntil = await ops.releaseHold(latest);
      if (heldUntil) {
        const command = `npm install --global ${PACKAGE}@${latest} --min-release-age=0`;
        report({
          ...result, held_until: heldUntil, command, error_code: 'release_age',
          error: `min-release-age in your npm config holds ${PACKAGE}@${latest} until ${heldUntil.slice(0, 10)}. pingroom update installs it from then. To take it now: ${command}`,
        });
        return EXIT.ERROR;
      }
      if (!args.json) process.stderr.write(`Installing ${PACKAGE}@${latest}…\n`);
      await ops.install(latest);
      result.updated = true;
      result.update_available = false;
    }
    report(result);
    return EXIT.OK;
  } catch (error) {
    // A failed child process carries `cmd`; anything else is our own message.
    const failure = error?.cmd !== undefined || error?.code === 'ENOENT'
      ? explainNpmFailure(error, result.latest_version)
      : { error: stripControlChars(error?.message ?? 'Update failed.') };
    report({ ...result, ...failure });
    return EXIT.ERROR;
  }
}
