// Checks the CLI's own copies of server text limits against docs/contracts/text-limits.json.
//
// Laravel writes that file from the real Form Requests
// (laravel/tests/Unit/TextLimitsContractTest.php). The CLI copies one limit by hand,
// the `--agent-label` length in lib/commands/connect-pairing.js, and a hand copy
// drifts: it stopped at 100 where the server takes 120 (RL-17). A disagreement fails
// here instead of turning away a label the server would have accepted.
//
// The fixture lives in the PingRoom workspace's docs/ repo, which a GitHub checkout
// of cli/ alone does not have. There every test below is SKIPPED with a message;
// run it from the workspace. Set REQUIRE_CONTRACT_FIXTURES=1 to turn a missing
// fixture into a failure. When the server changes a limit, regenerate the fixture:
//   cd laravel && WRITE_TEXT_LIMITS_CONTRACT=1 php artisan test --compact tests/Unit/TextLimitsContractTest.php

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE_PATH = fileURLToPath(new URL('../../docs/contracts/text-limits.json', import.meta.url));
const fixtureMissing = !existsSync(FIXTURE_PATH);
if (fixtureMissing && process.env.REQUIRE_CONTRACT_FIXTURES) {
  throw new Error(`REQUIRE_CONTRACT_FIXTURES is set but ${FIXTURE_PATH} does not exist`);
}
const skip = fixtureMissing
  ? 'docs/contracts/text-limits.json is not checked out beside cli/ (run this from the PingRoom workspace)'
  : false;
const fixture = fixtureMissing ? null : JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const REGENERATE = 'cd laravel && WRITE_TEXT_LIMITS_CONTRACT=1 php artisan test --compact tests/Unit/TextLimitsContractTest.php';

// Fixture fields the CLI has no copy of. Every other field needs a row in SOURCES.
const NOT_ENFORCED_BY_CLI = new Set([
  'room.name', 'room.description', 'room.handle', 'room.password.create', 'room.password.update',
  'personal_room.name', 'personal_room.handle', 'personal_room.pause_message', 'contact_share.note',
  'qr_image.size', 'quick_ping.label', 'preset.title', 'preset.slot_label', 'question.option_label',
  'ping.message.private', 'ping.message.public', 'ping.title',
]);

// Where a CLI source file keeps a limit. `pattern` has the number as its last capture group.
const SOURCES = [
  {
    id: 'agent.label',
    name: '--agent-label length',
    file: 'lib/commands/connect-pairing.js',
    pattern: /\[\.\.\.label\]\.length > (\d+)/,
  },
];

// Where the CLI and the server disagree TODAY, asserted exactly: a new disagreement
// fails the test, and so does a fixed one still listed here. Key: `<field id>#<source name>`.
const KNOWN_DRIFT = {
};

function readLimit({ file, pattern }) {
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
  const text = readFileSync(path, 'utf8');
  const match = pattern.exec(text);
  assert.ok(match, `${file}: nothing matches ${pattern}. The limit moved or was renamed, so update SOURCES in test/text-limits-contract.test.mjs.`);
  const captured = match[match.length - 1];
  const line = text.slice(0, match.index + match[0].lastIndexOf(captured)).split('\n').length;
  return { value: Number(captured), where: `${file}:${line}` };
}

for (const source of SOURCES) {
  test(`text limit ${source.id} / ${source.name}`, { skip }, () => {
    const field = fixture.fields[source.id];
    assert.ok(field, `Field "${source.id}" is not in docs/contracts/text-limits.json. Regenerate it: ${REGENERATE}`);
    const expected = field.app_cap ?? field.max;
    const hit = readLimit(source);
    const drift = KNOWN_DRIFT[`${source.id}#${source.name}`];

    if (drift) {
      assert.deepEqual(
        { field: source.id, finding: drift.finding, fixture: expected },
        { field: source.id, finding: drift.finding, fixture: drift.server },
      );
      assert.notEqual(hit.value, expected, `${drift.finding}: ${source.id} now matches the fixture at ${hit.where} (${expected}). Remove its KNOWN_DRIFT entry.`);
      assert.deepEqual(
        { field: source.id, finding: drift.finding, source: hit.where, value: hit.value },
        { field: source.id, finding: drift.finding, source: hit.where, value: drift.client },
      );
      return;
    }

    assert.deepEqual(
      { field: source.id, source: hit.where, value: hit.value },
      { field: source.id, source: hit.where, value: expected },
    );
  });
}

test('text limits account for every field in the fixture', { skip }, () => {
  const covered = new Set(SOURCES.map((source) => source.id));
  const ids = Object.keys(fixture.fields);

  assert.deepEqual(ids.filter((id) => !covered.has(id) && !NOT_ENFORCED_BY_CLI.has(id)), [],
    `fields in docs/contracts/text-limits.json that the CLI test neither checks nor lists as not enforced; regenerate or extend: ${REGENERATE}`);
  assert.deepEqual([...covered, ...NOT_ENFORCED_BY_CLI].filter((id) => !ids.includes(id)), []);
});

test('text limits keep KNOWN_DRIFT pointed at real sources', { skip }, () => {
  const keys = new Set(SOURCES.map((source) => `${source.id}#${source.name}`));
  assert.deepEqual(Object.keys(KNOWN_DRIFT).filter((key) => !keys.has(key)), []);
});
