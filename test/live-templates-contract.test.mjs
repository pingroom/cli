// Checks the CLI's live-status template list and limits against
// docs/contracts/live-templates.json.
//
// Laravel writes that file from App\Support\LiveStatusRules
// (laravel/tests/Unit/LiveTemplatesContractTest.php). The CLI keeps its own copy
// of the list (lib/render.js, so a typo is a usage error rather than a 422) and
// of the limits it checks before sending (lib/constants.js). A template the
// server learned that the CLI did not would be rejected here as a typo.
//
// The fixture lives in the PingRoom workspace's docs/ repo, which a GitHub
// checkout of cli/ alone does not have. There every test below is SKIPPED with a
// message; run it from the workspace. Set REQUIRE_CONTRACT_FIXTURES=1 to turn a
// missing fixture into a failure. When the server changes the list, regenerate:
//   cd laravel && WRITE_LIVE_TEMPLATES_CONTRACT=1 php artisan test --compact tests/Unit/LiveTemplatesContractTest.php

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LIVE_DELTA_MAX_LENGTH, LIVE_SEGMENTS_MAX, LIVE_SEGMENTS_MIN, LIVE_STAT_LABEL_MAX_LENGTH,
  LIVE_STAT_VALUE_MAX_LENGTH, LIVE_STATS_MAX, LIVE_STATS_MIN, LIVE_TRENDS, LIVE_VALUE_LABEL_MAX_LENGTH,
  LIVE_VALUE_MAX_LENGTH,
} from '../lib/constants.js';
import { LIVE_TEMPLATE_ALIASES, LIVE_TEMPLATE_NAMES, LIVE_TEMPLATES } from '../lib/render.js';
import { runAsync } from './helpers.mjs';

const FIXTURE_PATH = fileURLToPath(new URL('../../docs/contracts/live-templates.json', import.meta.url));
const fixtureMissing = !existsSync(FIXTURE_PATH);
if (fixtureMissing && process.env.REQUIRE_CONTRACT_FIXTURES) {
  throw new Error(`REQUIRE_CONTRACT_FIXTURES is set but ${FIXTURE_PATH} does not exist`);
}
const skip = fixtureMissing
  ? 'docs/contracts/live-templates.json is not checked out beside cli/ (run this from the PingRoom workspace)'
  : false;
const fixture = fixtureMissing ? null : JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const REGENERATE = fixture?.regenerate ?? '';

test('the CLI accepts exactly the fixture templates, in the fixture order', { skip }, () => {
  assert.deepEqual(
    LIVE_TEMPLATES,
    fixture.templates,
    `lib/render.js LIVE_TEMPLATES disagrees with docs/contracts/live-templates.json. The server's list is the truth. Regenerate the fixture only from Laravel: ${REGENERATE}`,
  );
});

test('the names help and errors offer are the wire names with only the documented aliases swapped in', { skip }, () => {
  const canonical = LIVE_TEMPLATE_NAMES.map((name) => LIVE_TEMPLATE_ALIASES[name] ?? name);
  assert.deepEqual(canonical, fixture.templates);
});

test('live start accepts every fixture template and refuses one that is not', { skip }, async () => {
  for (const name of fixture.templates) {
    // No transport configured: a valid template falls through to the
    // "provide a webhook or a token" error, never to a --template one.
    const { stderr } = await runAsync(['live', 'start', '-c', 'x', '--template', name]);
    assert.doesNotMatch(stderr, /--template must be one of/, `rejected fixture template "${name}"`);
  }
  const { status, stderr } = await runAsync(['live', 'start', '-c', 'x', '--template', 'not-a-template']);
  assert.equal(status, 2);
  assert.match(stderr, /--template must be one of/);
});

test('the limits the CLI checks are the fixture limits', { skip }, () => {
  const { fields } = fixture;
  assert.deepEqual(
    {
      value: LIVE_VALUE_MAX_LENGTH,
      valueLabel: LIVE_VALUE_LABEL_MAX_LENGTH,
      delta: LIVE_DELTA_MAX_LENGTH,
      trends: LIVE_TRENDS,
      statsMin: LIVE_STATS_MIN,
      statsMax: LIVE_STATS_MAX,
      statLabel: LIVE_STAT_LABEL_MAX_LENGTH,
      statValue: LIVE_STAT_VALUE_MAX_LENGTH,
      segmentsMin: LIVE_SEGMENTS_MIN,
      segmentsMax: LIVE_SEGMENTS_MAX,
    },
    {
      value: fields.value.max,
      valueLabel: fields.value_label.max,
      delta: fields.delta.max,
      trends: fields.trend.one_of,
      statsMin: fields.stats.min,
      statsMax: fields.stats.max,
      statLabel: fields.stats.item.label.max,
      statValue: fields.stats.item.value.max,
      segmentsMin: fields.segments.min,
      segmentsMax: fields.segments.max,
    },
    `lib/constants.js live limits disagree with docs/contracts/live-templates.json. Regenerate the fixture only from Laravel: ${REGENERATE}`,
  );
});

test('the CLI enforces those limits at the edge: the limit passes and one more is refused', { skip }, async () => {
  const { fields } = fixture;
  const send = (extra) => runAsync([
    'live', 'start', '--token', 't', '--room', 'r', '--api', 'http://127.0.0.1:1', '-c', 'c1', ...extra,
  ]);
  const edges = [
    ['--value', fields.value.max, /--value must be at most/],
    ['--value-label', fields.value_label.max, /--value-label must be at most/],
    ['--delta', fields.delta.max, /--delta must be at most/],
  ];
  for (const [flag, max, pattern] of edges) {
    const over = await send([flag, 'x'.repeat(max + 1)]);
    assert.equal(over.status, 2, `${flag} ${max + 1}`);
    assert.match(over.stderr, pattern);
    // At the limit the flag is accepted: the request then fails to connect, which is not a usage error.
    const atLimit = await send([flag, 'x'.repeat(max)]);
    assert.notEqual(atLimit.status, 2, `${flag} ${max}: ${atLimit.stderr}`);
  }
  const pairs = (n, label = 'L', value = 'V') => Array.from({ length: n }, (_, i) => ['--stat', `${label}${i}=${value}`]).flat();
  assert.notEqual((await send(pairs(fields.stats.min))).status, 2);
  assert.notEqual((await send(pairs(fields.stats.max))).status, 2);
  assert.equal((await send(pairs(fields.stats.min - 1))).status, 2);
  assert.equal((await send(pairs(fields.stats.max + 1))).status, 2);
  const statLabel = fields.stats.item.label.max;
  const statValue = fields.stats.item.value.max;
  assert.equal((await send([...pairs(3), '--stat', `${'l'.repeat(statLabel + 1)}=v`])).status, 2);
  assert.notEqual((await send([...pairs(3), '--stat', `${'l'.repeat(statLabel)}=${'v'.repeat(statValue)}`])).status, 2);
  assert.equal((await send([...pairs(3), '--stat', `l=${'v'.repeat(statValue + 1)}`])).status, 2);
  assert.notEqual((await send(['--segments', String(fields.segments.min)])).status, 2);
  assert.notEqual((await send(['--segments', String(fields.segments.max)])).status, 2);
  assert.equal((await send(['--segments', String(fields.segments.min - 1)])).status, 2);
  assert.equal((await send(['--segments', String(fields.segments.max + 1)])).status, 2);
});
