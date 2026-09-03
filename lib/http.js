// Everything that touches the network, plus the URL safety rule that decides
// whether a bearer token may ride along at all.

import { EXIT } from './constants.js';
import { fail, stripControlChars } from './util.js';
import { readStrictJsonResponse } from './strict-json.js';

/**
 * The fixes that live on THIS side of the wire. The server's message always
 * leads; these are appended only for the codes where the operator would
 * otherwise have no way to know what to do next, and where the answer is a
 * local action rather than "try again".
 */
const API_HINTS = {
  room_not_granted:
    'That room is outside the grant this agent was given. Add it under Connected Agents in the PingRoom app.',
  insufficient_scope:
    'This is a legacy partial credential. Run "pingroom reconnect" once to replace it with a full-access connection; new connections do not need permission refreshes.',
  no_room_configured:
    'This agent has no delivery room. Pick one under Connected Agents in the PingRoom app, or — if it was granted every room — let it create one with "pingroom rooms create".',
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
export function requireSafeUrl(kind, raw) {
  try {
    new URL(raw);
  } catch {
    fail(`${kind} is not a valid URL`, EXIT.USAGE);
  }
  if (!isSafeUrl(raw)) {
    fail(`${kind} must use https (refusing to send credentials over cleartext)`, EXIT.USAGE);
  }
  return raw;
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
    fail(`network error: ${err.message}`);
  }

  let text;
  let json;
  try {
    ({ text, json } = await readStrictJsonResponse(res, 'PingRoom API response'));
  } catch (err) {
    if (soft) return { res: null, text: '', json: null, error: err };
    fail(`untrusted JSON response: ${err.message}`);
  }

  return { res, text, json };
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
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        body,
      });
    } catch (err) {
      fail(`network error uploading ${name}: ${err.message}`);
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
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const { json } = await readStrictJsonResponse(res, 'hook response');
  if (!res.ok) {
    throw new Error(apiDetail(res, json));
  }
  return json;
}

export function retryAfterMs(response) {
  const raw = response?.headers?.get('retry-after')?.trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}
