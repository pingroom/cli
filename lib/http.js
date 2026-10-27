// Everything that touches the network, plus the URL safety rule that decides
// whether a bearer token may ride along at all.

import { EXIT, INSTALL_APP_URL } from './constants.js';
import { fail, sleep, stripControlChars } from './util.js';
import { readStrictJsonResponse } from './strict-json.js';

/**
 * The fixes that live on THIS side of the wire. The server's message always
 * leads; these are appended only for the codes where the operator would
 * otherwise have no way to know what to do next, and where the answer is a
 * local action rather than "try again".
 *
 * A value may be a function of the server's own wording. `recipient_not_ready`
 * needs that: since 2026-09-03 the server itself says "Install or update
 * PingRoom, open the app, sign in, and enable notifications", so printing the
 * long hint under it said the same sentence twice. Add only what the server
 * left out — where to get the app, and how to verify the phone.
 */
const API_HINTS = {
  room_not_granted:
    'That room is outside the grant this agent was given. Add it under Connected Agents in the PingRoom app.',
  insufficient_scope:
    'This is a legacy partial credential. Run "pingroom reconnect" once to replace it with a full-access connection; new connections do not need permission refreshes.',
  no_room_configured:
    'This robot has no home room. Pick one under Connected Agents in the PingRoom app, or — if it was granted every room — let it create one with "pingroom rooms create".',
  recipient_not_ready: (base) =>
    /install or update pingroom/i.test(base)
      ? `Get it at ${INSTALL_APP_URL}, then run "pingroom activate" to verify the phone before retrying.`
      : `Install or update PingRoom at ${INSTALL_APP_URL}, then open it, sign in, and enable notifications. Run "pingroom activate" to verify the phone before retrying.`,
  quick_action_input_required:
    'This Ping needs a detail. Run "pingroom actions list --room <code>" to see its input type, then retry with --location <lat,lng>, --url <https-url>, or --attach <file>.',
  quick_action_input_type:
    'This Ping wants a specific file type: photo takes jpg/jpeg/png, pdf takes .pdf. Retry with a matching --attach.',
  action_not_configured:
    'That slot is reserved but disabled (empty label and icon). Configure it with "pingroom actions set <n> --room <code> --label <text> --icon <emoji>" or press another slot.',
  pro_required:
    'A Pro plan is needed. Quick ping slots 5-16 and "actions layout" need the ROOM OWNER on Pro; attachments and webhooks need this account on Pro.',
  quick_action_layout_changed:
    'The room\'s quick ping pages changed since they were read. Run "pingroom actions list --room <code>" and retry.',
  quick_action_page_in_use:
    'That page is still targeted by a time trigger, webhook, agent binding or a running live update. Retarget or end those first.',
  payload_too_large:
    'The request body exceeded the server limit: attachments are 5 MiB each and at most 4 per ping, --data is 8 KB.',
};

/**
 * What to print when an API call fails: the server's own wording, plus the one
 * thing that would fix it when we know one.
 */
export function apiDetail(res, json) {
  // The server's wording is untrusted text headed for the terminal — strip
  // escapes so a hostile API can't smuggle ANSI (same threat model as pair_url).
  const base = stripControlChars(
    (json && (json.message || json.error || json.code)) || `HTTP ${res ? res.status : 'error'}`,
  );
  let hint = json && typeof json.code === 'string' ? API_HINTS[json.code] : undefined;
  if (typeof hint === 'function') hint = hint(base);
  // A 401 means the stored credential is dead (revoked in the app, or the
  // pairing was cleaned up). Without this line the CLI prints a bare
  // "Unauthenticated." and leaves the user to guess the remedy.
  if (!hint && res && res.status === 401) {
    hint = 'This credential is no longer valid — run "pingroom reconnect" to pair again.';
  }
  return hint ? `${base}\n  ${hint}` : base;
}

// True when a URL is safe to attach a bearer token or webhook secret to: https,
// or http on loopback so local dev against http://localhost still works.
// Split out of requireSafeUrl for the `hook` command, which must apply the same
// rule but fails open (it defers instead of exiting — see hook()).
export function isSafeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback);
}

// Refuse to send a bearer token or webhook secret over cleartext http. A
// loopback host is allowed so local dev against http://localhost still works.
// URL userinfo is refused too: fetch() will not send it, and the error it
// throws instead quotes the whole URL, so a webhook's secret path ended up on
// stderr.
export function requireSafeUrl(kind, raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail(`${kind} is not a valid URL`, EXIT.USAGE);
  }
  if (u.username || u.password) {
    fail(`${kind} must not contain URL user credentials`, EXIT.USAGE);
  }
  if (!isSafeUrl(raw)) {
    fail(`${kind} must use https (refusing to send credentials over cleartext)`, EXIT.USAGE);
  }
  return raw;
}

/**
 * A one-line description of a fetch() failure that is safe to print.
 *
 * fetch's own messages are not: "Request cannot be constructed from a URL that
 * includes credentials: <url>" quotes a webhook URL whose path is its secret,
 * and "Headers.append: \"Bearer <token>\" is an invalid header value" quotes
 * the bearer. So only the error class, the system error code (ECONNREFUSED,
 * ENOTFOUND, ...) or a short fixed cause such as "unexpected redirect" is ever
 * shown.
 */
export function describeTransportError(err) {
  if (err?.name === 'TimeoutError') return 'timed out';
  if (err?.name === 'AbortError') return 'aborted';
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  const cause = err?.cause?.message;
  if (typeof cause === 'string' && /^[a-z][a-z ]{2,60}$/.test(cause)) return cause;
  if (err?.cause) return 'connection failed';
  return 'the request could not be built (check the URL, token and header values)';
}

/** `(https://host)` for an error line, or '' when the URL does not parse. */
function originNote(url) {
  try {
    return ` (${new URL(url).origin})`;
  } catch {
    return '';
  }
}

// `soft: true` returns { error } instead of exiting on a transport failure. The
// bounded pairing and activation loops use it so a single DNS blip or dropped
// connection does not discard an otherwise recoverable human workflow. Every
// other caller keeps the hard exit.
export async function httpJson(method, url, { body, headers = {}, soft = false, signal } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (soft) return { res: null, text: '', json: null, error: err };
    fail(`network error${originNote(url)}: ${describeTransportError(err)}`);
  }

  let text;
  let json;
  try {
    ({ text, json } = await readStrictJsonResponse(res, 'PingRoom API response'));
  } catch (err) {
    // `response` and `parseError` let a soft caller tell a body it could not
    // trust apart from a connection that never answered; `res` stays null so
    // existing soft loops keep treating both as retryable.
    if (soft) return { res: null, text: '', json: null, error: err, response: res, parseError: true };
    fail(`untrusted JSON response: ${err.message}`);
  }

  return { res, text, json };
}

// Transient failures in a row before a waiting command says so on stderr.
const TRANSIENT_WARN_AFTER = 3;

/**
 * GET an existing decision, riding out network errors, 5xx and 429.
 *
 * Safe retries apply only to reads of an existing decision. Never repeat a
 * create here: transport failure may occur after the server committed it.
 *
 * The retries are bounded. Past `deadline` (an absolute time: the decision's
 * expiry plus grace), or after `maxOutageMs` of unbroken failures when the
 * expiry is unknown, the wait ends with exit 1 and "PingRoom unavailable
 * since …". It used to retry forever and print nothing, so a deploy gate whose
 * API went away sat silent until the CI job's own timeout. After a few failures
 * in a row it says so once on stderr. `what` names the decision in the message.
 */
export async function pollDecision(url, token, { deadline = Infinity, maxOutageMs = Infinity, what = 'the decision' } = {}) {
  let failures = 0;
  let since = null;
  for (;;) {
    const result = await httpJson('GET', url, {
      headers: { Authorization: `Bearer ${token}` },
      soft: true,
      signal: AbortSignal.timeout(45_000),
    });
    if (result.res && result.res.status !== 429 && result.res.status < 500) return result;
    // The server answered, but not with JSON: a WAF/challenge page or an --api
    // base that is not the API. Retrying cannot change that answer, so report
    // it instead of polling silently forever. A 429/5xx page (proxy error
    // HTML) is still transient and keeps retrying.
    if (result.parseError && result.response && result.response.status !== 429 && result.response.status < 500) {
      fail(`untrusted JSON response (HTTP ${result.response.status}): ${result.error.message}`);
    }
    failures += 1;
    since ??= Date.now();
    const answered = result.res ?? result.response;
    const reason = answered ? `HTTP ${answered.status}` : describeTransportError(result.error);
    const stopAt = Math.min(deadline, since + maxOutageMs);
    const remaining = stopAt - Date.now();
    const sinceText = new Date(since).toISOString();
    if (remaining <= 0) {
      fail(`PingRoom unavailable since ${sinceText} (${reason}); stopped waiting for ${what}`);
    }
    if (failures === TRANSIENT_WARN_AFTER) {
      const until = Number.isFinite(stopAt) ? ` until ${new Date(stopAt).toISOString()}` : '';
      process.stderr.write(`pingroom: PingRoom unavailable since ${sinceText} (${reason}); retrying${until}\n`);
    }
    const delay = retryAfterMs(answered) ?? Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
    // Never sleep past the bound: the last attempt lands on it, not after it.
    await sleep(Math.min(Math.max(1000, delay), remaining));
  }
}

// The extensions the attachment endpoint accepts. Mirrored here so a typo is a
// local usage error instead of a 422 after the bytes have already been sent.
// Keep in lockstep with laravel config/attachments.php `allowed_extensions`.
const ATTACHMENT_EXTENSIONS = ['md', 'pdf', 'html', 'txt', 'jpg', 'jpeg', 'png', 'zip'];
const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_MAX_COUNT = 4;
const ATTACHMENT_MIME = {
  md: 'text/markdown',
  pdf: 'application/pdf',
  html: 'text/html',
  txt: 'text/plain',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  zip: 'application/zip',
};

/**
 * Upload each --attach path and return the ids in flag order. Bytes go up as
 * multipart; only the resulting ids ride the ping body. An id we never manage
 * to attach expires server-side after 24h, so a mid-run failure leaks nothing
 * permanent.
 */
export async function uploadAttachments(paths, apiBase, token) {
  if (paths.length > ATTACHMENT_MAX_COUNT) {
    fail(`--attach accepts at most ${ATTACHMENT_MAX_COUNT} files`, EXIT.USAGE);
  }

  const { readFile, stat } = await import('node:fs/promises');
  const { basename, extname } = await import('node:path');
  const ids = [];

  for (const path of paths) {
    const name = basename(path);
    const ext = extname(name).slice(1).toLowerCase();
    if (!ATTACHMENT_EXTENSIONS.includes(ext)) {
      fail(`--attach ${name}: only ${ATTACHMENT_EXTENSIONS.join(', ')} files are supported`, EXIT.USAGE);
    }

    let info;
    try {
      info = await stat(path);
    } catch {
      fail(`--attach ${path}: file not found`, EXIT.USAGE);
    }
    if (!info.isFile()) fail(`--attach ${path}: not a file`, EXIT.USAGE);
    if (info.size < 1) fail(`--attach ${name}: file is empty`, EXIT.USAGE);
    if (info.size > ATTACHMENT_MAX_BYTES) {
      fail(`--attach ${name}: file exceeds the 5 MiB limit`, EXIT.USAGE);
    }

    const body = new FormData();
    body.append('file', new Blob([await readFile(path)], { type: ATTACHMENT_MIME[ext] }), name);

    let res;
    try {
      // Not httpJson: that helper JSON-encodes the body and would strip the
      // multipart boundary the runtime generates for us.
      res = await fetch(`${apiBase}/api/agent/attachments`, {
        method: 'POST',
        redirect: 'error',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        body,
      });
    } catch (err) {
      fail(`network error uploading ${name}: ${describeTransportError(err)}`);
    }

    let json = null;
    try { ({ json } = await readStrictJsonResponse(res, 'attachment API response')); } catch (error) {
      fail(`untrusted JSON response uploading ${name}: ${error.message}`);
    }

    if (res.status === 402) {
      fail(`--attach ${name}: ping attachments are a Pro feature`, EXIT.USAGE);
    }
    if (!res.ok || !json?.attachment?.id) {
      const detail = apiDetail(res, json);
      fail(`upload failed for ${name}: ${detail}`);
    }

    ids.push(json.attachment.id);
  }

  return ids;
}

// A minimal HTTP helper for the hook path that THROWS instead of calling fail(),
// so every failure funnels into a fail-open decision. Mirrors httpJson's header
// handling but leaves control flow to the caller.
export async function hookFetch(method, url, { body, token } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    // The hook prints the reason into Claude Code's permission prompt, so it
    // gets the same secret-free wording as httpJson.
    throw new Error(`network error: ${describeTransportError(err)}`);
  }
  const { json } = await readStrictJsonResponse(res, 'hook response');
  if (!res.ok) {
    throw new Error(apiDetail(res, json));
  }
  return json;
}

const RETRY_AFTER_MIN_MS = 1000;
const RETRY_AFTER_MAX_MS = 60_000;

/**
 * The server's Retry-After in milliseconds, or null when it sent none we can
 * read. Clamped here, once, so no caller can skip it: `0` or a past date used
 * to mean "retry immediately" in `listen` and activation, and a value past
 * 2^31-1 ms makes setTimeout fire after 1 ms, turning "wait a very long time"
 * into back-to-back retries. `max` lifts the ceiling for a caller that stores
 * the time instead of sleeping on it (credential cleanup's next attempt).
 */
export function retryAfterMs(response, { max = RETRY_AFTER_MAX_MS } = {}) {
  const raw = response?.headers?.get('retry-after')?.trim();
  if (!raw) return null;
  let ms;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    ms = Number(raw) * 1000;
  } else {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return null;
    ms = at - Date.now();
  }
  return Math.min(max, Math.max(RETRY_AFTER_MIN_MS, ms));
}
