import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CliExit, POLL_FLOOR_MS, encodePathSegment, isPathSegment, numberOption, pathSegment, requireCreatedId,
  requireLinkUrl, resolveWaitHold,
} from '../lib/util.js';

/** Run a helper that reports failure through fail(), keeping its stderr and exit code out of the runner. */
function attempt(fn) {
  const exitCode = process.exitCode;
  const write = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (!(error instanceof CliExit)) throw error;
    return { ok: false, code: error.code, message: stderr.trim() };
  } finally {
    process.stderr.write = write;
    process.exitCode = exitCode;
  }
}

test('the poll floor keeps one account under the wait routes\' 30-requests-a-minute throttle', () => {
  assert.ok(POLL_FLOOR_MS >= 2000, `${POLL_FLOOR_MS} ms is faster than 30 requests a minute`);
});

test('--timeout is digits only: an empty or non-numeric value is a usage error, not a zero hold', () => {
  for (const timeout of ['', ' ', 'abc', '-1', '1.5', '0x10', '1e1', '+5']) {
    const result = attempt(() => resolveWaitHold({ timeout }, { def: 25, cap: 30 }));
    assert.equal(result.ok, false, JSON.stringify(timeout));
    assert.equal(result.code, 2);
    assert.match(result.message, /--timeout must be a non-negative integer/);
  }
  assert.equal(resolveWaitHold({}, { def: 25, cap: 30 }), 25);
  assert.equal(resolveWaitHold({ timeout: '0' }, { def: 25, cap: 30 }), 0);
  assert.equal(resolveWaitHold({ timeout: '7' }, { def: 25, cap: 30 }), 7);
  assert.equal(resolveWaitHold({ timeout: '99' }, { def: 25, cap: 30 }), 30);
});

test('numeric flags take plain decimal text: Number() readings of nothing, hex and exponents are refused', () => {
  const options = { min: 0, max: 1 };
  for (const raw of ['', ' ', '  ', '\t', 'abc', '0x1', '1e-1', '.5', '5.', 'NaN', 'Infinity', '1,5', '+1']) {
    const result = attempt(() => numberOption(raw, '--progress', options));
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.match(result.message, /--progress must be a number/);
  }
  assert.equal(numberOption(undefined, '--progress', options), undefined);
  assert.equal(numberOption('0', '--progress', options), 0);
  assert.equal(numberOption('0.5', '--progress', options), 0.5);
  assert.equal(numberOption('1', '--progress', options), 1);
  assert.match(attempt(() => numberOption('-1', '--progress', options)).message, /--progress must be at least 0/);
  assert.match(attempt(() => numberOption('2', '--progress', options)).message, /--progress must be at most 1/);
  assert.match(attempt(() => numberOption('1.5', '--step', { integer: true })).message, /--step must be an integer/);
  assert.equal(numberOption('1700000000000', '--deadline-at', { min: 0, integer: true }), 1_700_000_000_000);
});

test('a link URL is measured in code points, as the server counts it', () => {
  const origin = 'https://example.com/';
  // 1,120 code points but 2,220 UTF-16 units: over the old length check, well under the limit.
  const astral = `${origin}${'😀'.repeat(1100)}`;
  assert.equal(requireLinkUrl(astral), astral);
  const exact = `${origin}${'😀'.repeat(2048 - origin.length)}`;
  assert.equal(Array.from(exact).length, 2048);
  assert.equal(requireLinkUrl(exact), exact);
  const over = `${exact}😀`;
  const result = attempt(() => requireLinkUrl(over));
  assert.equal(result.ok, false);
  assert.match(result.message, /--url must be at most 2048 characters/);
});

test('a path segment is never empty, "." or ".."', () => {
  for (const bad of ['', '.', '..']) {
    assert.equal(isPathSegment(bad), false, JSON.stringify(bad));
    assert.throws(() => encodePathSegment(bad, 'room'), /room may not be empty, "\." or "\.\."/);
    const result = attempt(() => pathSegment(bad, 'room'));
    assert.equal(result.ok, false);
    assert.equal(result.code, 2);
    assert.match(result.message, /room may not be empty, "\." or "\.\."/);
  }
  for (const good of ['ab12cd', '.a', 'a.', '...', '%2e%2e', 'a b']) {
    assert.equal(isPathSegment(good), true, good);
  }
  assert.equal(encodePathSegment('a/b?c'), 'a%2Fb%3Fc');
  assert.equal(pathSegment('%2e%2e', 'id'), '%252e%252e', 'an already-encoded dot segment stays inert');
  assert.equal(isPathSegment(undefined), false);
});

test('a created resource whose id is a dot segment is not a success', () => {
  for (const id of ['', '  ', '.', '..']) {
    assert.equal(attempt(() => requireCreatedId({ id }, 'ask')).ok, false, JSON.stringify(id));
  }
  assert.equal(requireCreatedId({ id: 'q_1' }, 'ask'), 'q_1');
});
