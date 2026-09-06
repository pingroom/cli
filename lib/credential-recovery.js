// Complete credential replacements interrupted after the local commit.
// The active token and its pending revocations share one atomic, locked file.

import { credentialsPath, readJsonFile, updateCredentialState } from './config.js';
import { httpJson, isSafeUrl, retryAfterMs } from './http.js';

const RECOVERY_TIMEOUT_MS = 1500;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;

function validPending(entry) {
  return entry && typeof entry.id === 'string' && entry.id !== ''
    && typeof entry.token === 'string' && entry.token !== ''
    && typeof entry.api_url === 'string' && isSafeUrl(entry.api_url);
}

function reportResult({ revoked, detail, manual = false }, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ event: 'previous_connection', revoked, ...(detail ? { detail } : {}) })}\n`);
  } else if (revoked) {
    process.stdout.write('  Previous connection revoked.\n');
  } else {
    process.stdout.write(`  Note: the previous connection could not be revoked (${detail}).\n`);
    process.stdout.write(manual
      ? '  Remove the previous connection in PingRoom → Settings → Connected Agents.\n'
      : '  Cleanup is saved and will retry on a later run. You can also remove it in PingRoom → Settings → Connected Agents.\n');
  }
}

/**
 * Best-effort recovery must never change a command's outcome or stdout format.
 * Pair/reconnect opt into the existing human/NDJSON receipt. All other callers
 * stay quiet. A bounded request budget and persisted backoff limit delays and
 * space out revocation retries during an outage.
 */
export async function retryPendingRevocations({ report = false, json = false } = {}) {
  const snapshot = readJsonFile(credentialsPath());
  if (!Array.isArray(snapshot?.pending_revocations) || snapshot.pending_revocations.length === 0) return;

  const results = [];
  let hasPending = true;
  try {
    const updated = await updateCredentialState(async (state) => {
      if (!Array.isArray(state?.pending_revocations) || state.pending_revocations.length === 0) return;
      let pending = [...state.pending_revocations];
      let attempts = 0;
      const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
      const signal = AbortSignal.timeout(RECOVERY_TIMEOUT_MS);

      // Hold the credential lock through each request: another process cannot
      // replace or log out the active token while we decide what is safe to
      // revoke. The total budget is below the lock's stale interval.
      for (const entry of state.pending_revocations) {
        if (attempts >= MAX_ATTEMPTS || Date.now() >= deadline) break;
        if (!validPending(entry)) {
          results.push({ revoked: false, detail: 'the saved cleanup record is incomplete or unsafe; manual removal is required', manual: true });
          continue;
        }
        if (entry.token === state.token) continue;
        if (Number.isFinite(entry.next_attempt_at) && entry.next_attempt_at > Date.now()) continue;
        attempts += 1;

        // Never resolve this through --api, config, or the environment. Each
        // bearer must return to the API base saved when it was replaced.
        const { res, json: body, error } = await httpJson('POST', `${entry.api_url.replace(/\/$/, '')}/api/agent/auth/revoke`, {
          headers: { Authorization: `Bearer ${entry.token}` },
          body: {},
          soft: true,
          signal,
        });
        // A lost successful response is safe to replay: the server answers
        // invalid_credential once that bearer can no longer authenticate.
        const complete = !error && (res?.status === 204
          || (res?.status === 401 && body?.code === 'invalid_credential'));
        if (complete) {
          pending = pending.filter((candidate) => candidate !== entry);
          results.push({ revoked: true });
        } else {
          const retryAfter = retryAfterMs(res);
          const delay = Number.isFinite(retryAfter) ? Math.max(RETRY_DELAY_MS, retryAfter) : RETRY_DELAY_MS;
          pending = pending.map((candidate) => candidate === entry
            ? { ...entry, next_attempt_at: Date.now() + delay }
            : candidate);
          // Do not echo API bodies or exceptions: these can contain secrets.
          results.push({ revoked: false, detail: error ? 'network request failed' : `HTTP ${res?.status ?? 'error'}` });
        }
      }

      if (attempts === 0) return;
      if (pending.length === 0 && !state.token) return null;
      const next = { ...state };
      if (pending.length > 0) next.pending_revocations = pending;
      else delete next.pending_revocations;
      return next;
    }, { retries: 0 });
    hasPending = Array.isArray(updated?.pending_revocations) && updated.pending_revocations.length > 0;
  } catch {
    // Lock contention, an interrupted writer, or a full disk must not turn a
    // working connection into a command failure. Leave the journal for later.
    if (report) reportResult({ revoked: false, detail: 'cleanup is still pending' }, json);
    return;
  }

  if (report) {
    for (const result of results) reportResult(result, json);
    if (hasPending && !results.some((result) => !result.revoked)) {
      reportResult({ revoked: false, detail: 'cleanup is still pending' }, json);
    }
  }
}
