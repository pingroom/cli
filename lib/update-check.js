// "A newer @pingroom/cli is available" — the one piece of output this tool
// prints that nobody asked for. Everything here exists to make that safe.
//
// The hard rule: this must never change what a command does. Not its exit code,
// not its stdout, not whether it succeeds. A version notice that breaks a
// deploy pipeline is worse than never shipping the notice at all, so every
// failure path below is a silent return.

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { pingroomHome, readJsonFile } from './config.js';

const REGISTRY_URL = 'https://registry.npmjs.org/@pingroom/cli/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Awaited before exit, so this is a real ceiling on how long a successful
// command can be delayed by a check nobody asked for. Measured round trips to
// the registry ran 0.63-1.19s warm, so a tighter budget (1.2s was tried) times
// out often enough to look like "there is never an update".
const TIMEOUT_MS = 2500;

export function updateCachePath() { return join(pingroomHome(), 'update-check.json'); }

/**
 * Write the cache, or give up without a word.
 *
 * Deliberately NOT config.js's writeJsonFile: that one calls fail() on an
 * unwritable path, and fail() calls process.exit() — which no try/catch can
 * intercept. Borrowing it here would mean a read-only or full ~/.pingroom turns
 * an advisory version check into the thing that kills the operator's ping. The
 * write is still atomic (temp file + rename) so a crash mid-write cannot leave
 * a torn file for the next run to parse.
 */
function writeCacheQuietly(path, value) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(pingroomHome(), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch { /* never created */ }
  }
}

/**
 * Why an env var AND a TTY test:
 *
 * `CI` covers the graders that set it (GitHub Actions, GitLab, CircleCI). The
 * TTY test covers everything else — cron, systemd units, Docker builds, a
 * pipeline that forgot to set CI, and `pingroom ... | jq`. Neither alone is
 * enough, and the notice is worthless to a machine either way.
 */
function suppressed() {
  if (process.env.PINGROOM_NO_UPDATE_CHECK === '1') return true;
  if (process.env.CI) return true;
  if (process.env.NODE_ENV === 'test') return true;
  return !process.stdout.isTTY || !process.stderr.isTTY;
}

/**
 * Compare two dotted release numbers. Returns true when `candidate` is strictly
 * newer than `current`.
 *
 * Anything carrying a prerelease or build suffix (`-beta.1`, `+sha`) is refused
 * outright rather than guessed at: npm's `latest` tag should never point at one,
 * and a wrong guess here nags every single run. Only the numeric release line is
 * compared, and only when both sides parse.
 */
export function isNewer(candidate, current) {
  const parse = (value) => {
    if (typeof value !== 'string') return null;
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/**
 * Fetch the published `latest` version, or null for any failure at all — no
 * network, DNS refusal, a 5xx, a proxy returning HTML, a body without a version
 * string. The caller cannot distinguish these and should not try to.
 */
async function fetchLatest() {
  try {
    // Plain application/json, NOT npm's abbreviated-metadata type: that one is
    // only accepted on the full packument, and asking for it here gets a 406
    // that this function would swallow into a permanent "no update available".
    // The single-version document is ~1.5 KB, smaller than the packument the
    // abbreviated type would have saved us from.
    const res = await fetch(REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.version === 'string' ? json.version : null;
  } catch {
    return null;
  }
}

/**
 * Check at most once every 24h and print a notice when a newer release exists.
 *
 * The cache timestamp is written on every completed check, including one that
 * found nothing and one whose fetch failed. Writing it only on success would
 * turn an offline machine into a machine that retries the registry on every
 * single invocation.
 *
 * Note this is awaited by the caller rather than detached: the CLI ends in an
 * explicit process.exit(), which would kill a floating promise mid-flight and
 * leave the cache unwritten — so a detached check would re-fetch forever while
 * appearing to cost nothing.
 */
export async function maybeNotifyUpdate(currentVersion) {
  try {
    if (suppressed()) return;

    const path = updateCachePath();
    const cached = readJsonFile(path);
    const checkedAt = Number(cached?.checked_at);
    const fresh = Number.isFinite(checkedAt) && Date.now() - checkedAt < CHECK_INTERVAL_MS;

    // Inside the window, still report what the last check found: the notice
    // should persist until the operator actually upgrades, not appear once a day
    // and vanish.
    const latest = fresh ? cached?.latest : await fetchLatest();
    if (!fresh) {
      writeCacheQuietly(path, { checked_at: Date.now(), latest: latest ?? null });
    }

    if (typeof latest !== 'string' || !isNewer(latest, currentVersion)) return;

    process.stderr.write(
      `\nnote: @pingroom/cli ${latest} is available (you have ${currentVersion})\n`
      + '      pingroom update\n'
      + '      set PINGROOM_NO_UPDATE_CHECK=1 to silence this\n',
    );
  } catch {
    // Unreachable by design — every step above already swallows its own
    // failures. This is the backstop that guarantees the promise this function
    // returns can never reject into the caller's exit path.
  }
}
