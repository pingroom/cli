import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EXIT } from '../constants.js';
import { VERSION } from '../version.js';
import { commandHelp } from '../help.js';
import { isNewer } from '../update-check.js';
import { stripControlChars } from '../util.js';

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

async function npm(args, timeout = 30_000) {
  // Windows needs npm's JS entry to avoid running npm.cmd through a shell.
  if (process.platform === 'win32') {
    const { dirname } = await import('node:path');
    return run(process.execPath, [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args], { timeout, maxBuffer: 1024 * 1024 });
  }
  return run('npm', args, { timeout, maxBuffer: 1024 * 1024 });
}

const defaults = {
  currentVersion: VERSION,
  async latestVersion() {
    const { stdout } = await npm(['view', '@pingroom/cli@latest', 'version', '--json']);
    return JSON.parse(stdout);
  },
  async isGlobalInstall() {
    const { stdout } = await npm(['root', '--global']);
    try {
      const installed = join(stdout.trim(), '@pingroom', 'cli');
      // An npm-linked source checkout must not be overwritten either.
      const actual = await realpath(installed);
      return !(await lstat(installed)).isSymbolicLink() && actual === await realpath(packageRoot);
    } catch {
      return false;
    }
  },
  async install(version) {
    await npm(['install', '--global', `@pingroom/cli@${version}`, '--no-fund', '--no-audit'], 180_000);
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
    if (result.update_available && !args.check) {
      if (!await ops.isGlobalInstall()) {
        report({ ...result, error: 'Self-update requires an npm global installation. For npx, run npx @pingroom/cli@latest; for a project dependency, run npm install @pingroom/cli@latest in that project. Source checkouts must be updated with git.' });
        return EXIT.USAGE;
      }
      if (!args.json) process.stderr.write(`Installing @pingroom/cli@${latest}…\n`);
      await ops.install(latest);
      result.updated = true;
      result.update_available = false;
    }
    report(result);
    return EXIT.OK;
  } catch (error) {
    // npm output can contain registry configuration. Do not echo raw stderr.
    const message = error?.cmd
      ? 'npm could not complete the update. Check your network, npm login, global install permissions, and minimum release age policy, then retry.'
      : stripControlChars(error?.message ?? 'Update failed.');
    report({ ...result, error: message });
    return EXIT.ERROR;
  }
}
