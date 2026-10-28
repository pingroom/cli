// Small primitives every other module leans on: exiting, sleeping, sanitizing
// untrusted text, and the local validations that turn a would-be 422 into a
// usage error.

import { CHECKLIST_ITEM_MAX_LENGTH, CHECKLIST_MAX_ITEMS, EXIT, LOCATION_ADDRESS_MAX_LENGTH, LOCATION_LABEL_MAX_LENGTH } from './constants.js';

const DATA_MAX_BYTES = 8 * 1024;

/**
 * What fail() throws to end the command. main() catches it and exits once
 * stdout and stderr have drained. fail() used to call process.exit() itself,
 * which dropped piped output still queued (a `listen --json | consumer` lost
 * its last batch when a 401 ended it) and skipped every `finally` on the way
 * out (a failed `skills install` leaked its temp clone). Nothing else should
 * catch it: a bare `catch {}` around a call that can fail would swallow the
 * exit.
 */
export class CliExit extends Error {
  constructor(code) {
    super(`pingroom exited with code ${code}`);
    this.name = 'CliExit';
    this.code = code;
  }
}

export function fail(message, code = EXIT.ERROR) {
  process.stderr.write(`pingroom: ${message}\n`);
  process.exitCode = code;
  throw new CliExit(code);
}

/**
 * True when it is safe to prompt / draw a QR. Both streams must be a TTY: a
 * piped stdin cannot answer a prompt and a piped stdout would capture the QR as
 * garbage.
 *
 * The override is deliberately double-locked (internal-looking name AND
 * NODE_ENV=test) and not documented in --help. A single well-known env var
 * shipping in the published binary is one stray `export` away from making a CI
 * job prompt into the void and poll for the full 15-minute pairing window
 * instead of failing in a second.
 */
export function isInteractive() {
  if (process.env.PINGROOM_INTERNAL_TEST_TTY === '1' && process.env.NODE_ENV === 'test') return true;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** The shortest a long-poll round may take, however fast the server answers. */
export const POLL_FLOOR_MS = 1000;

/**
 * Sleep out the rest of the poll floor for a round that began at `started`.
 * Every loop that re-polls a human decision shares it: a server or proxy that
 * answers `pending` at once, ignoring the hold, would otherwise be hammered at
 * full speed (the PreToolUse hook once made ~17k requests a second that way).
 */
export async function waitOutPollFloor(started) {
  const elapsed = Date.now() - started;
  if (elapsed < POLL_FLOOR_MS) await sleep(POLL_FLOOR_MS - elapsed);
}

// Drop C0/C1 control characters before echoing server-supplied text to the
// terminal. Without this an attacker-controlled API base can smuggle ANSI
// escapes into the output and repaint, erase or overwrite the lines around them.
// Tabs and line breaks become one space first, so "ship it\nnow" stays two
// words instead of gluing into "ship itnow" — and still stays on one line.
export function stripControlChars(value) {
  return String(value)
    .replace(/[\t\n\r]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

export function truncate(value, max) {
  const str = String(value ?? '');
  const characters = Array.from(str);
  return characters.length <= max ? str : `${characters.slice(0, max - 1).join('')}…`;
}

/**
 * Reject an over-long field here rather than letting it become a 422.
 *
 * Every bound mirrors a Laravel rule (StoreNotificationRequest,
 * StoreQuestionRequest, LiveStatusRules) and is documented in --help, so a value
 * past it was always going to be refused — locally it reads as the usage error
 * it is, with the limit and the actual length named.
 */
export function requireMaxLength(value, max, flag) {
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (length > max) {
      fail(`${flag} must be at most ${max} characters (got ${length})`, EXIT.USAGE);
    }
  }
}

/**
 * Validate --timeout and resolve the per-poll hold. Called by ask/handoff
 * BEFORE the create POST: the old in-wait check ran only after the question or
 * handoff already existed, so `--timeout -5` put a live question on someone's
 * phone and then exited 2, orphaning it until its TTL.
 */
export function resolveWaitHold(args, { def, cap }) {
  if (args.timeout === undefined) return Math.min(def, cap);
  const hold = Number(args.timeout);
  if (!Number.isFinite(hold) || hold < 0) fail('--timeout must be a non-negative integer', EXIT.USAGE);
  return Math.min(hold, cap);
}

// PHP trim()'s default set: what the server strips from both ends of a key.
const SERVER_TRIM = /^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g;

/**
 * Validate --idempotency-key and stamp it on the outgoing headers.
 *
 * Creating a human gate is the one CLI write a caller genuinely wants to replay
 * after an ambiguous transport failure. The rule is the server's
 * (RequestIdempotency::keyFrom: trimmed, then 1–255 characters), narrowed to
 * what an HTTP header carries intact: printable ASCII, spaces included. fetch
 * throws on anything outside Latin-1, which used to surface as a network error
 * that every retry repeated, and a Latin-1 byte above 0x7E reaches the server
 * as invalid UTF-8. The key is sent trimmed, which is what the server stores.
 * The server returns 409 if the same key is ever reused for a different payload.
 */
export function applyIdempotencyKey(args, headers) {
  if (args.idempotency_key === undefined) return headers;
  const key = String(args.idempotency_key).replace(SERVER_TRIM, '');
  if (!/^[\x20-\x7E]{1,255}$/.test(key)) {
    fail('--idempotency-key must be 1–255 printable ASCII characters (letters, digits, punctuation or spaces)', EXIT.USAGE);
  }
  headers['Idempotency-Key'] = key;
  return headers;
}

/**
 * The id a successful create must carry. A 2xx without one (an empty `{}`, a
 * proxy's placeholder) used to print "undefined" and exit 0, and
 * --github-output then handed the workflow an empty question-id with
 * state=pending: a success no script could act on.
 */
export function requireCreatedId(json, what) {
  const id = json?.id;
  if (typeof id !== 'string' || id.trim() === '') fail(`${what} returned no id`);
  return id;
}

export function numberOption(raw, flag, { min, max, integer = false } = {}) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`${flag} must be a number`, EXIT.USAGE);
  if (integer && !Number.isInteger(value)) fail(`${flag} must be an integer`, EXIT.USAGE);
  if (min !== undefined && value < min) fail(`${flag} must be at least ${min}`, EXIT.USAGE);
  if (max !== undefined && value > max) fail(`${flag} must be at most ${max}`, EXIT.USAGE);
  return value;
}

export function parseDataObject(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail('--data must be valid JSON', EXIT.USAGE);
  }
  if (typeof data !== 'object' || Array.isArray(data) || data === null) {
    fail('--data must be a JSON object', EXIT.USAGE);
  }
  // The server caps structured data at 8 KB serialized; past it the request is
  // a 422 (or, far past it, a 413) that no retry can fix. Measured the way the
  // server measures it, not as UTF-8: ~1,500 Persian characters used to pass
  // here and 422 there.
  requireDataWithinServerCap(data, '--data');
  return data;
}

/**
 * Bytes `data` takes under PHP's default json_encode, which is what the API's
 * 8 KB cap measures: every non-ASCII UTF-16 unit becomes a 6-byte `\uXXXX`
 * escape and `/` becomes `\/`. A non-Latin checklist is several times larger
 * there than its UTF-8 size.
 */
export function serverJsonByteLength(value) {
  const json = JSON.stringify(value) ?? '';
  let bytes = 0;
  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index);
    if (code > 0x7f) bytes += 6;
    else if (code === 0x2f) bytes += 2;
    else bytes += 1;
  }
  return bytes;
}

/**
 * Fail before sending when `data` would 422 on the 8 KB cap. `what` names the
 * input in the error: the raw --data object, or ping's merged data.
 */
export function requireDataWithinServerCap(data, what = 'data (including --item, --location and --url)') {
  if (data !== undefined && serverJsonByteLength(data) > DATA_MAX_BYTES) {
    fail(`${what} must serialize to at most 8 KB as the server measures it; each non-ASCII UTF-16 code unit counts 6 bytes (a surrogate-pair emoji counts 12)`, EXIT.USAGE);
  }
}

const DECIMAL_COORDINATE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Parse a "latitude,longitude" flag value into validated numbers. */
export function parseLocation(value, flag = '--location') {
  const parts = String(value).split(',');
  if (parts.length !== 2) {
    fail(`${flag} must contain exactly two coordinates formatted "latitude,longitude"`, EXIT.USAGE);
  }

  const [latitudeText, longitudeText] = parts.map((part) => part.trim());
  if (!DECIMAL_COORDINATE.test(latitudeText) || !DECIMAL_COORDINATE.test(longitudeText)) {
    fail(`${flag} coordinates must be finite numbers formatted "latitude,longitude"`, EXIT.USAGE);
  }

  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    fail(`${flag} coordinates must be finite numbers formatted "latitude,longitude"`, EXIT.USAGE);
  }
  if (latitude < -90 || latitude > 90) {
    fail(`${flag} latitude must be between -90 and 90`, EXIT.USAGE);
  }
  if (longitude < -180 || longitude > 180) {
    fail(`${flag} longitude must be between -180 and 180`, EXIT.USAGE);
  }
  return { latitude, longitude };
}

/**
 * The reserved `data.location` object from --location / --location-label /
 * --location-address, or undefined when --location is absent. Shared by `ping`
 * and `actions trigger` so the two never drift on the 100/255 caps or the
 * "label without a location" usage error.
 */
export function buildLocation(args) {
  if (args.location_label !== undefined && args.location === undefined) {
    fail('--location-label requires --location', EXIT.USAGE);
  }
  if (args.location_address !== undefined && args.location === undefined) {
    fail('--location-address requires --location', EXIT.USAGE);
  }
  if (args.location === undefined) return undefined;
  requireMaxLength(args.location_label, LOCATION_LABEL_MAX_LENGTH, '--location-label');
  requireMaxLength(args.location_address, LOCATION_ADDRESS_MAX_LENGTH, '--location-address');
  const location = parseLocation(args.location);
  if (args.location_label !== undefined) location.label = args.location_label;
  if (args.location_address !== undefined) location.address = args.location_address;
  return location;
}

/**
 * The reserved `data.checklist` object from repeated --item flags, or
 * undefined when none was given. Items keep their order; the room ticks them
 * by position.
 */
export function buildChecklist(args) {
  if (args.item === undefined) return undefined;
  if (args.item.length > CHECKLIST_MAX_ITEMS) {
    fail(`--item may be repeated at most ${CHECKLIST_MAX_ITEMS} times (got ${args.item.length})`, EXIT.USAGE);
  }
  const items = args.item.map((text) => {
    const trimmed = text.trim();
    if (trimmed === '') fail('--item must not be empty', EXIT.USAGE);
    requireMaxLength(trimmed, CHECKLIST_ITEM_MAX_LENGTH, '--item');
    return { text: trimmed };
  });
  return { items };
}

/** Validate a --url value against the server's link contract (absolute http(s), <= 2048). */
export function requireLinkUrl(value, flag = '--url') {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${flag} is not a valid URL`, EXIT.USAGE);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail(`${flag} must be an absolute http(s) URL`, EXIT.USAGE);
  }
  if (value.length > 2048) {
    fail(`${flag} must be at most 2048 characters`, EXIT.USAGE);
  }
  return value;
}

export function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function isNullableString(value) {
  return value === null || typeof value === 'string';
}
