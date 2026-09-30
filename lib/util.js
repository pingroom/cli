// Small primitives every other module leans on: exiting, sleeping, sanitizing
// untrusted text, and the local validations that turn a would-be 422 into a
// usage error.

import { EXIT, LOCATION_ADDRESS_MAX_LENGTH, LOCATION_LABEL_MAX_LENGTH } from './constants.js';

const DATA_MAX_BYTES = 8 * 1024;

export function fail(message, code = EXIT.ERROR) {
  process.stderr.write(`pingroom: ${message}\n`);
  process.exit(code);
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

/**
 * Validate --idempotency-key and stamp it on the outgoing headers.
 *
 * Creating a human gate is the one CLI write a caller genuinely wants to replay
 * after an ambiguous transport failure, so the key must survive a shell round
 * trip intact: printable ASCII, no spaces. The server returns 409 if the same
 * key is ever reused for a different payload.
 */
export function applyIdempotencyKey(args, headers) {
  if (args.idempotency_key === undefined) return headers;
  const key = String(args.idempotency_key);
  if (!/^[\x21-\x7E]{1,255}$/.test(key)) {
    fail('--idempotency-key must be 1–255 printable ASCII characters without spaces', EXIT.USAGE);
  }
  headers['Idempotency-Key'] = key;
  return headers;
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
  // a 422 (or, far past it, a 413) that no retry can fix.
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > DATA_MAX_BYTES) {
    fail('--data must serialize to at most 8 KB', EXIT.USAGE);
  }
  return data;
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
