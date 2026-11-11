// Runs the CLI's button rules (lib/ping-actions.js) against
// docs/contracts/ping-actions.json.
//
// Laravel writes that file from App\Support\PingActionRules
// (laravel/tests/Unit/PingActionsContractTest.php): the limits, the reserved
// labels, and the verdict the real rules gave every label and URL vector. The
// CLI keeps its own copy of the rules (it cannot import the SDK), so a
// disagreement fails here instead of surfacing as a 422 in production.
//
// The fixture lives in the PingRoom workspace's docs/ repo; a GitHub checkout
// of cli/ alone does not have it and every test below is SKIPPED. Set
// REQUIRE_CONTRACT_FIXTURES=1 to turn a missing fixture into a failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as rules from '../lib/ping-actions.js';

const FIXTURE_PATH = fileURLToPath(new URL('../../docs/contracts/ping-actions.json', import.meta.url));
const fixtureMissing = !existsSync(FIXTURE_PATH);
if (fixtureMissing && process.env.REQUIRE_CONTRACT_FIXTURES) {
  throw new Error(`REQUIRE_CONTRACT_FIXTURES is set but ${FIXTURE_PATH} does not exist`);
}
const skip = fixtureMissing
  ? 'docs/contracts/ping-actions.json is not checked out beside cli/ (run this from the PingRoom workspace)'
  : false;
const fixture = fixtureMissing ? null : JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const REGENERATE = 'Regenerate the fixture only from Laravel: WRITE_PING_ACTIONS_CONTRACT=1 php artisan test --compact tests/Unit/PingActionsContractTest.php';

// Where the CLI and the server disagree TODAY, asserted exactly. Empty.
const KNOWN_DRIFT = { labels: [], urls: [] };

test('ping actions: the CLI limits are the server\'s', { skip }, () => {
  assert.deepEqual({
    max_actions: rules.PING_ACTIONS_MAX,
    id_pattern: rules.PING_ACTION_ID_PATTERN.source,
    label_max: rules.PING_ACTION_LABEL_MAX_LENGTH,
    url_max: rules.PING_ACTION_URL_MAX_LENGTH,
    body_max_bytes: rules.PING_ACTION_BODY_MAX_BYTES,
    body_max_keys: rules.PING_ACTION_BODY_MAX_KEYS,
    run_window_hours: rules.PING_ACTION_RUN_WINDOW_HOURS,
    types: rules.PING_ACTION_TYPES,
    styles: rules.PING_ACTION_STYLES,
  }, fixture.limits, `cli/lib/ping-actions.js disagrees with docs/contracts/ping-actions.json limits. ${REGENERATE}`);
});

test('ping actions: the CLI refuses exactly the server\'s reserved labels', { skip }, () => {
  assert.deepEqual(rules.RESERVED_PING_ACTION_LABELS, fixture.reserved_labels, `RESERVED_PING_ACTION_LABELS drifted from the fixture. ${REGENERATE}`);
  for (const label of fixture.reserved_labels) {
    assert.equal(rules.pingActionComparisonForm(label), label, `${label} is not in its comparison form`);
  }
});

test('ping actions: every label vector gets the server\'s verdict and cleaned text', { skip }, () => {
  assert.ok(fixture.label_vectors.length > 10, 'label vectors are missing');
  const observed = [];
  for (const vector of fixture.label_vectors) {
    const verdict = rules.cleanPingActionLabel(vector.label);
    const accepted = verdict.error === null;
    if (accepted !== vector.accepted) {
      observed.push({ label: vector.label, check: 'accepted', client: accepted, server: vector.accepted });
    } else if (accepted && verdict.label !== vector.cleaned) {
      observed.push({ label: vector.label, check: 'cleaned', client: verdict.label, server: vector.cleaned });
    } else if (!accepted && verdict.error !== vector.reason) {
      observed.push({ label: vector.label, check: 'reason', client: verdict.error, server: vector.reason });
    }
  }
  assert.deepEqual(observed, KNOWN_DRIFT.labels, `unexpected CLI/server disagreement on a label. ${REGENERATE}`);
});

test('ping actions: every URL vector gets the server\'s verdict and host', { skip }, () => {
  assert.ok(fixture.url_vectors.length > 10, 'url vectors are missing');
  const observed = [];
  for (const vector of fixture.url_vectors) {
    const verdict = rules.pingActionUrlVerdict(vector.url, vector.type);
    const accepted = verdict.error === null;
    if (accepted !== vector.accepted) {
      observed.push({ url: vector.url, type: vector.type, check: 'accepted', client: accepted, server: vector.accepted });
    } else if (accepted && verdict.host !== vector.host) {
      observed.push({ url: vector.url, type: vector.type, check: 'host', client: verdict.host, server: vector.host });
    } else if (!accepted && verdict.error !== vector.reason) {
      observed.push({ url: vector.url, type: vector.type, check: 'reason', client: verdict.error, server: vector.reason });
    }
  }
  assert.deepEqual(observed, KNOWN_DRIFT.urls, `unexpected CLI/server disagreement on a URL. ${REGENERATE}`);
});
