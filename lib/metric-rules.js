// Client-side checks for a room metric write, mirroring the server's
// RoomMetricRules (laravel/app/Support/RoomMetricRules.php) so a typo is a usage
// error here instead of a 422 round trip. The server stays authoritative: it also
// knows the stored metric (a partial update is judged by the stored format) and
// the ISO 4217 code list, so nothing here is stricter than it.

import {
  EXIT, METRIC_CURRENCY_PATTERN, METRIC_FORMATS, METRIC_KEY_MAX_LENGTH, METRIC_KEY_PATTERN,
  METRIC_LABEL_MAX_LENGTH, METRIC_MAX_ABSOLUTE_VALUE, METRIC_TEXT_VALUE_MAX_LENGTH, METRIC_UNIT_MAX_LENGTH,
} from './constants.js';
import { fail } from './util.js';

// A plain decimal, the only text the server reads as a number: no exponent, no
// hex, no padding, no NaN or Infinity.
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const NOT_A_NUMBER_WORD = /^[+-]?(?:nan|inf(?:inity)?)$/i;
const FORMATS_WITH_UNIT = ['currency', 'unit'];

const length = (value) => Array.from(value).length;

/** The key as the server stores it: trimmed and lowercased. */
export function normalizeMetricKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/** Whether `value` is a stored-key shape (after {@link normalizeMetricKey}). */
export function isMetricKey(value) {
  return typeof value === 'string' && METRIC_KEY_PATTERN.test(value);
}

/** A usage error for a key the server would never store. */
export function requireMetricKey(raw, flag = 'key') {
  const key = normalizeMetricKey(raw);
  if (!isMetricKey(key)) {
    fail(`${flag} must be 1 to ${METRIC_KEY_MAX_LENGTH} characters: letters, digits, "-" and "_", starting with a letter or digit`, EXIT.USAGE);
  }
  return key;
}

function requireShortText(raw, max, flag) {
  const text = String(raw).trim();
  if (text === '' || length(text) > max) fail(`${flag} must be 1 to ${max} characters`, EXIT.USAGE);
  if (CONTROL.test(text)) fail(`${flag} must not contain control characters`, EXIT.USAGE);
  return text;
}

/**
 * A numeric value argument as the JSON number to send. `what` names it in the
 * error. Exits 2 for anything the server would refuse for a numeric format.
 */
export function requireMetricNumber(raw, what = 'value') {
  const text = String(raw).trim();
  if (!DECIMAL.test(text)) fail(`${what} must be a plain number such as 12400 or -3.5 (for the text format, pass --format text)`, EXIT.USAGE);
  const number = Number(text);
  if (!Number.isFinite(number) || Math.abs(number) > METRIC_MAX_ABSOLUTE_VALUE) {
    fail(`${what} must have an absolute value of at most ${METRIC_MAX_ABSOLUTE_VALUE.toLocaleString('en-US', { useGrouping: false })}`, EXIT.USAGE);
  }
  return number;
}

/**
 * Validate and shape one metric write from raw command-line strings.
 *
 * - `value` argv is always a string. With a numeric `--format` it must be a plain
 *   number and is sent as a JSON number; with `--format text` it is sent as the
 *   string; with no format a plain number is sent as a number (a new metric
 *   becomes `number`) and anything else as text (a new metric becomes `text`).
 *   A word that reads as NaN or Infinity is refused without `--format text`, so a
 *   script's bad arithmetic does not quietly create a text metric.
 * - `--unit` is refused for a format that never carries one.
 *
 * @returns {{ key: string, body: Record<string, unknown> }} the key and the
 *   fields to send (`value`, and `label`, `format`, `unit` when given)
 */
export function buildMetricWrite({ key, value, label, format, unit }) {
  const normalizedKey = requireMetricKey(key);
  const body = {};

  if (format !== undefined && !METRIC_FORMATS.includes(format)) {
    fail(`--format must be one of: ${METRIC_FORMATS.join(', ')}`, EXIT.USAGE);
  }
  if (label !== undefined) body.label = requireShortText(label, METRIC_LABEL_MAX_LENGTH, '--label');
  if (format !== undefined) body.format = format;

  if (unit !== undefined) {
    if (format !== undefined && !FORMATS_WITH_UNIT.includes(format)) {
      fail('--unit is only allowed with --format currency or --format unit', EXIT.USAGE);
    }
    const text = requireShortText(unit, METRIC_UNIT_MAX_LENGTH, '--unit');
    if (format === 'currency') {
      const code = text.toUpperCase();
      if (!METRIC_CURRENCY_PATTERN.test(code)) fail('--unit for --format currency must be an ISO 4217 code such as USD', EXIT.USAGE);
      body.unit = code;
    } else {
      body.unit = text;
    }
  }

  if (value === undefined) fail('a value is required', EXIT.USAGE);
  const text = String(value).trim();
  if (format === 'text') {
    if (text === '' || length(text) > METRIC_TEXT_VALUE_MAX_LENGTH) {
      fail(`value must be 1 to ${METRIC_TEXT_VALUE_MAX_LENGTH} characters for --format text`, EXIT.USAGE);
    }
    if (CONTROL.test(text)) fail('value must not contain control characters', EXIT.USAGE);
    body.value = text;
  } else if (format !== undefined || DECIMAL.test(text)) {
    body.value = requireMetricNumber(text);
  } else {
    if (NOT_A_NUMBER_WORD.test(text)) {
      fail(`value "${text}" is not a number; pass --format text to store it as text`, EXIT.USAGE);
    }
    if (text === '' || length(text) > METRIC_TEXT_VALUE_MAX_LENGTH || CONTROL.test(text)) {
      fail(`value must be a number, or text of 1 to ${METRIC_TEXT_VALUE_MAX_LENGTH} characters without control characters`, EXIT.USAGE);
    }
    body.value = text;
  }

  return { key: normalizedKey, body };
}
