// `config` (read/write ~/.pingroom/config.json) and `logout` (forget the stored
// credential). The only two commands that never touch the network.

import { BUILTIN_API, EXIT } from '../constants.js';
import { fail } from '../util.js';
import { commandHelp } from '../help.js';
import { configPath, credentialsPath, readConfigFile, updateCredentialState, writeJsonFile } from '../config.js';

// Only these keys are storable. An unknown key is a usage error rather than a
// silently-ignored setting the user then blames the tool for not honouring.
const CONFIG_KEYS = {
  default_room: {
    describe: 'Room invite code used when --room / PINGROOM_ROOM is absent',
    validate: (value) => {
      if (/\s/.test(value) || value.length > 64) return 'default_room must be an invite code (no spaces, <= 64 chars)';
      return null;
    },
  },
  api_url: {
    describe: `API base URL (default ${BUILTIN_API})`,
    validate: (value) => {
      let u;
      try { u = new URL(value); } catch { return 'api_url must be a valid URL'; }
      const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
        return 'api_url must use https (refusing to send credentials over cleartext)';
      }
      return null;
    },
  },
};

export async function config(args) {
  if (args.help) { process.stdout.write(`${commandHelp('config')}\n`); return EXIT.OK; }

  const sub = args._[0];
  const known = ['list', 'get', 'set'];
  if (!sub || !known.includes(sub)) {
    fail(`config needs a subcommand: ${known.join(' | ')}`, EXIT.USAGE);
  }

  const stored = readConfigFile();

  if (sub === 'list') {
    if (args.json) { process.stdout.write(`${JSON.stringify(stored)}\n`); return EXIT.OK; }
    const keys = Object.keys(CONFIG_KEYS).filter((k) => stored[k] !== undefined && stored[k] !== '');
    if (keys.length === 0) {
      process.stdout.write(`no settings stored in ${configPath()}\n`);
      return EXIT.OK;
    }
    for (const key of keys) process.stdout.write(`${key}=${stored[key]}\n`);
    return EXIT.OK;
  }

  const key = args._[1];
  if (!key) fail(`config ${sub} needs a key (${Object.keys(CONFIG_KEYS).join(', ')})`, EXIT.USAGE);
  if (!Object.hasOwn(CONFIG_KEYS, key)) {
    fail(`unknown config key: ${key} (known keys: ${Object.keys(CONFIG_KEYS).join(', ')})`, EXIT.USAGE);
  }

  if (sub === 'get') {
    const value = stored[key];
    if (value === undefined || value === '') return EXIT.OK; // unset: print nothing, exit 0
    process.stdout.write(`${value}\n`);
    return EXIT.OK;
  }

  // set
  const raw = args._[2];
  if (raw === undefined) fail(`config set needs a value (pass "" to clear ${key})`, EXIT.USAGE);
  const value = String(raw).trim();

  if (value === '') {
    delete stored[key];
    writeJsonFile(configPath(), stored);
    process.stdout.write(`${key} cleared\n`);
    return EXIT.OK;
  }

  const problem = CONFIG_KEYS[key].validate(value);
  if (problem) fail(problem, EXIT.USAGE);

  stored[key] = value;
  writeJsonFile(configPath(), stored);
  process.stdout.write(`${key}=${value}\n`);
  return EXIT.OK;
}

// --- logout ----------------------------------------------------------------

export async function logout(args) {
  if (args.help) { process.stdout.write(`${commandHelp('logout')}\n`); return EXIT.OK; }

  const path = credentialsPath();
  let stored;
  let pendingCount = 0;
  try {
    await updateCredentialState((current) => {
      stored = current;
      const pending = Array.isArray(current?.pending_revocations) ? current.pending_revocations : [];
      pendingCount = pending.length;
      return pendingCount > 0 ? { version: 1, pending_revocations: pending } : null;
    });
  } catch (err) {
    fail(`could not clear ${path}: ${err.message}`);
  }

  if (!stored?.token) {
    process.stdout.write('not connected — there was no stored credential to clear\n');
    if (pendingCount > 0) process.stdout.write('note: old credential cleanup remains queued for a future command\n');
    return EXIT.OK;
  }
  const who = stored && stored.handle ? ` (@${stored.handle})` : '';
  process.stdout.write(`logged out${who} — cleared ${pendingCount > 0 ? 'the active credential' : path}\n`);
  if (pendingCount > 0) process.stdout.write('note: old credential cleanup remains queued for a future command\n');
  if (process.env.PINGROOM_TOKEN) {
    process.stdout.write('note: PINGROOM_TOKEN is still set in this environment and will keep being used\n');
  }
  return EXIT.OK;
}
