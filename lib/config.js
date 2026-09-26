// Local state (~/.pingroom) and the layered resolution every command shares:
// explicit flag > env var > config file > the paired credential > built-in.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';

import { BUILTIN_API, EXIT } from './constants.js';
import { fail } from './util.js';
import { requireSafeUrl } from './http.js';
import { parseJsonStrict } from './strict-json.js';

// --- local state (~/.pingroom) ---------------------------------------------
//
// Two files, both under a 0700 directory:
//   credentials.json  the agent credential this machine paired (mode 0600)
//   config.json       user settings: default_room, api_url
//
// PINGROOM_HOME relocates the directory (tests, sandboxes, multi-account
// shells). Every lookup is layered: explicit flag > env var > config file >
// the paired credential > built-in default. PINGROOM_TOKEN is the one env var
// that also outranks the stored credential, which is what keeps CI working
// untouched.

export function pingroomHome() {
  return process.env.PINGROOM_HOME || join(homedir(), '.pingroom');
}

export function credentialsPath() { return join(pingroomHome(), 'credentials.json'); }
export function configPath() { return join(pingroomHome(), 'config.json'); }

// Read a JSON object, or null for anything unreadable/corrupt. Local state must
// never be able to crash a ping: a hand-edited file degrades to "not set".
export function readJsonFile(path) {
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)); } catch { return null; }
  let value;
  try { value = parseJsonStrict(raw, path); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

// Write JSON with restrictive permissions, atomically.
//
// Writing in place truncates first, so a crash or a full disk between truncate
// and write leaves a half-written file — and readJsonFile() degrades anything
// unparseable to {}, so the *next* `config set` would silently drop every other
// setting. Writing a sibling temp file and renaming over the target means a
// reader only ever sees the old file or the new one, never a torn one.
//
// The temp file is opened 'wx' with mode 0600 and fchmod'd before a single byte
// is written: `mode` on an existing file is ignored and a post-write chmod
// leaves a window where the credential is world-readable. rename() carries the
// 0600 over the target, so a pre-existing loose file is tightened too.
//
// mkdirSync(recursive) returns the first path it created, or undefined when the
// directory already existed. chmod'ing only on the former keeps this from
// narrowing a directory the user deliberately created at 0755.
function ensureStateDirectory(dir) {
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined) chmodSync(dir, 0o700);
}

function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeJsonFileAtomic(path, value) {
  const dir = dirname(path);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    ensureStateDirectory(dir);

    fd = openSync(tmp, 'wx', 0o600);
    fchmodSync(fd, 0o600); // defeat a permissive umask masking the open mode
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    syncDirectory(dir);
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
}

export function writeJsonFile(path, value) {
  try { writeJsonFileAtomic(path, value); } catch (err) {
    fail(`could not write ${path}: ${err.message}`);
  }
}

// Credential mutations must read after taking the lock. Otherwise a reconnect,
// logout, or cleanup from another process can overwrite newly queued work.
// Resolve the credential directory's real path before locking, even when the
// credentials file does not exist yet.
// A crashed owner stops refreshing its lock; subsequent writers reclaim it.
export async function updateCredentialState(mutator, {
  retries = { retries: 24, factor: 1, minTimeout: 500, maxTimeout: 500 },
} = {}) {
  ensureStateDirectory(pingroomHome());
  const dir = realpathSync(pingroomHome());
  const path = join(dir, 'credentials.json');
  let compromised;
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 10000,
    update: 5000,
    retries,
    onCompromised: (err) => { compromised = err; },
  });
  try {
    let current = null;
    try {
      const bytes = readFileSync(path);
      try {
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        current = parseJsonStrict(raw, path);
      } catch (err) {
        // JSON parser errors can quote the input, including bearer tokens.
        throw new Error(`invalid credential state in ${path}`, { cause: err });
      }
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`invalid credential state in ${path}`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const next = await mutator(current);
    if (compromised) throw compromised;
    if (next === null) {
      try { unlinkSync(path); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      syncDirectory(dir);
    } else if (next !== undefined) {
      if (typeof next !== 'object' || Array.isArray(next)) throw new TypeError('credential state must be an object');
      writeJsonFileAtomic(path, next);
    }
    return next === undefined ? current : next;
  } finally {
    // A compromised lock has already been released by proper-lockfile.
    if (!compromised) await release();
  }
}

export function readStoredCredential() {
  const cred = readJsonFile(credentialsPath());
  if (!cred || typeof cred.token !== 'string' || cred.token === '') return null;
  return cred;
}

export function readConfigFile() {
  return readJsonFile(configPath()) || {};
}

/** Agent token: --token > PINGROOM_TOKEN > the paired credential. */
export function resolveToken(args) {
  return args.token || process.env.PINGROOM_TOKEN || readStoredCredential()?.token || undefined;
}

/**
 * API base: --api > PINGROOM_API_URL > config.api_url > the host the credential
 * was paired against > built-in, no trailing slash.
 *
 * The credential layer is not optional. saveCredential() records `api_url`, and
 * a token minted by a self-hosted / staging server is only valid there; without
 * this layer the next command would present that bearer to api.pingroom.io —
 * leaking it to a host it was never issued for. resolveRoom() already consults
 * the credential last, so the two layerings now agree.
 *
 * It is also an issuer boundary when resolveToken() falls through to the stored
 * credential. Overrides may change the path on the same origin, but
 * requireStoredCredentialOrigin() refuses a different origin unless the caller
 * supplies an explicit --token or PINGROOM_TOKEN for that host.
 */
export function resolveApiBase(args) {
  const raw = args.api
    || process.env.PINGROOM_API_URL
    || readConfigFile().api_url
    || readStoredCredential()?.api_url
    || BUILTIN_API;
  return String(raw).replace(/\/$/, '');
}

/**
 * A paired bearer belongs to the API origin that minted it. API settings still
 * resolve independently so callers can select a path or an intentional custom
 * host, but a stored token may only follow them within its recorded origin.
 * Supplying --token / PINGROOM_TOKEN makes the token source explicit and opts
 * out of this stored-credential binding.
 */
export function storedCredentialOriginError(args, apiBase) {
  if (args.token || process.env.PINGROOM_TOKEN) return null;

  const credential = readStoredCredential();
  if (!credential || typeof credential.api_url !== 'string' || credential.api_url === '') return null;

  let credentialOrigin;
  let targetOrigin;
  try {
    credentialOrigin = new URL(credential.api_url).origin;
    targetOrigin = new URL(apiBase).origin;
  } catch {
    // URL validation owns malformed values. This guard only compares origins.
    return null;
  }

  if (credentialOrigin === targetOrigin) return null;
  return `stored credential is bound to ${credentialOrigin}; refusing to send it to ${targetOrigin}. Provide --token or PINGROOM_TOKEN for an intentional API origin override`;
}

export function requireStoredCredentialOrigin(args, apiBase) {
  const error = storedCredentialOriginError(args, apiBase);
  if (error) fail(error, EXIT.USAGE);
}

/**
 * Room invite code: --room > PINGROOM_ROOM > config.default_room > the room the
 * credential was paired to. The paired room is last because it is the weakest
 * signal — it is where the agent was told to deliver, not necessarily where
 * this invocation means to.
 */
export function resolveRoom(args) {
  return normalizeRoomCode(
    args.room
    || process.env.PINGROOM_ROOM
    || readConfigFile().default_room
    || readStoredCredential()?.room?.invite_code,
  );
}

/**
 * Accept a room code the way people actually paste one: surrounding spaces, a
 * leading "#", or a whole join link (pgr.link/j/CODE, pingroom.io/join/CODE).
 * Each of those used to reach the API as a code no room has and come back as a
 * bare "Resource not found". Case is left alone; the API uppercases codes.
 */
export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return undefined;
  let code = value.trim().replace(/^#/, '');
  if (code.includes('/')) {
    const path = code.replace(/[?#].*$/, '');
    code = path.split('/').filter(Boolean).pop() ?? '';
  }
  code = code.trim();
  return code || undefined;
}

// Resolve the credential + endpoint a token-only command needs. When nothing is
// available this is a usage error pointing at PINGROOM_TOKEN — never a prompt,
// so a CI job fails in a second instead of hanging on an invisible question.
export function agentContext(args, { needRoom = false } = {}) {
  const token = resolveToken(args);
  if (!token) {
    fail(
      'an agent token is required (--token or PINGROOM_TOKEN). Run "pingroom" in an interactive terminal to connect this machine, or "pingroom pair" where there is no terminal; in CI set PINGROOM_TOKEN.',
      EXIT.USAGE,
    );
  }
  const apiBase = resolveApiBase(args);
  requireStoredCredentialOrigin(args, apiBase);
  requireSafeUrl('--api', apiBase);
  const room = resolveRoom(args);
  if (needRoom && !room) {
    fail('--room is required (or set one with "pingroom config set default_room <code>")', EXIT.USAGE);
  }
  if (args.expected_room_sha256 !== undefined) {
    const expected = String(args.expected_room_sha256);
    if (!/^[a-f0-9]{64}$/.test(expected)) fail('--expected-room-sha256 must be 64 lowercase hexadecimal characters', EXIT.USAGE);
    if (!room) fail('--expected-room-sha256 requires a resolved room', EXIT.USAGE);
    const actual = createHash('sha256').update(String(room), 'utf8').digest('hex');
    if (actual !== expected) fail('resolved room does not match --expected-room-sha256', EXIT.USAGE);
  }
  return { token, apiBase, room };
}

/** Persist the active credential plus the bits the status line prints. */
export async function saveCredential({ token, handle, room, rooms, roomAccess, account, links, apiBase }) {
  const safeLinks = {
    ...(links?.latest_pings ? { latest_pings: links.latest_pings } : {}),
    ...(links?.install_app ? { install_app: links.install_app } : {}),
  };
  return updateCredentialState((previous) => {
    const pending = [];
    const seen = new Set();
    for (const entry of Array.isArray(previous?.pending_revocations) ? previous.pending_revocations : []) {
      // Never retain cleanup for the token becoming active, including a token
      // that a user deliberately pairs again while its cleanup is pending.
      if (entry?.token === token) continue;
      const key = JSON.stringify([entry?.token, entry?.api_url]);
      if (seen.has(key)) continue;
      seen.add(key);
      pending.push(entry);
    }
    if (typeof previous?.token === 'string' && previous.token !== '' && previous.token !== token) {
      // Missing issuer metadata needs manual cleanup. The new API selection
      // cannot establish where the previous credential is safe to send.
      const originalApi = typeof previous.api_url === 'string' && previous.api_url !== ''
        ? previous.api_url : null;
      const key = JSON.stringify([previous.token, originalApi]);
      if (!seen.has(key)) pending.push({ id: randomUUID(), token: previous.token, api_url: originalApi });
    }
    return {
      version: 1,
      token,
      handle: handle || null,
      // `room` is the delivery room — where handoffs and questions land. `rooms`
      // is the whole grant, which can be wider; `room_access: "all"` lists no
      // access rows but may still carry one eligible private delivery room.
      room: room || null,
      rooms: Array.isArray(rooms) ? rooms : [],
      room_access: roomAccess || null,
      account: account || null,
      ...(Object.keys(safeLinks).length > 0 ? { links: safeLinks } : {}),
      api_url: apiBase,
      created_at: new Date().toISOString(),
      ...(pending.length > 0 ? { pending_revocations: pending } : {}),
    };
  });
}
