// Runs the CLI's real validators against docs/contracts/structured-ping-vectors.json.
//
// Laravel writes that file: every vector is an input plus the verdict the real
// server gave it (laravel/tests/Feature/StructuredPingVectorsContractTest.php).
// The CLI re-implements three of those rules by hand, and each has been wrong
// before: the 8 KB `data` cap (measured as UTF-8 until 5cf94bd), the
// Idempotency-Key (refused spaces until 9372c7c; handoff bypassed the shared
// check until 493a331) and the button label length (counted UTF-16 units until
// acc5c1c). A disagreement fails here instead of surfacing as a 422 in prod.
//
// The fixture lives in the PingRoom workspace's docs/ repo, which a GitHub
// checkout of cli/ alone does not have. There every test below is SKIPPED with
// a message; run it from the workspace. Set REQUIRE_CONTRACT_FIXTURES=1 to turn
// a missing fixture into a failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  applyIdempotencyKey, CliExit, parseDataObject, requireDataWithinServerCap, serverJsonByteLength,
} from '../lib/util.js';
import { questionServer, runAsync } from './helpers.mjs';

const FIXTURE_PATH = fileURLToPath(new URL('../../docs/contracts/structured-ping-vectors.json', import.meta.url));
const fixtureMissing = !existsSync(FIXTURE_PATH);
if (fixtureMissing && process.env.REQUIRE_CONTRACT_FIXTURES) {
  throw new Error(`REQUIRE_CONTRACT_FIXTURES is set but ${FIXTURE_PATH} does not exist`);
}
const skip = fixtureMissing
  ? 'docs/contracts/structured-ping-vectors.json is not checked out beside cli/ (run this from the PingRoom workspace)'
  : false;
const fixture = fixtureMissing ? null : JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const REGENERATE = fixture?.regenerate ?? '';

// Where the CLI and the server disagree TODAY, asserted exactly: a new
// disagreement fails the test, and so does a fixed one still listed here.
// Nothing here is a runtime change; each is a fact about the current CLI.
const KNOWN_DRIFT = {
  data: [
    // The server decodes {"0":..,"1":..} to a PHP list and refuses it as one.
    { id: 'numeric-keys-look-like-list', check: 'accepted', client: true, server: false },
    { id: 'numeric-keys-look-like-list', check: 'mergedPathAccepted', client: true, server: false },
    // TrimStrings / ConvertEmptyStringsToNull run before the 8 KB rule: "" is
    // measured as null (4 bytes) and surrounding whitespace is not measured.
    { id: 'empty-string-becomes-null', check: 'serverBytes', client: 22, server: 24 },
    { id: 'empty-string-null-expansion-at-limit', check: 'accepted', client: true, server: false },
    { id: 'empty-string-null-expansion-at-limit', check: 'mergedPathAccepted', client: true, server: false },
    { id: 'empty-string-null-expansion-at-limit', check: 'serverBytes', client: 8192, server: 8194 },
    { id: 'padded-string-is-trimmed', check: 'serverBytes', client: 29, server: 23 },
  ],
  // The server accepts any bytes and counts code points. The CLI narrows the key
  // to printable ASCII on purpose, because it travels as an HTTP header: fetch
  // throws outside Latin-1, and a Latin-1 byte above 0x7E reaches the server as
  // invalid UTF-8 (see applyIdempotencyKey). Every entry is "the server would
  // accept it, the CLI refuses it"; there is none the other way round.
  idempotencyKey: [
    { id: 'form-feed-edges', check: 'accepted', client: false, server: true },
    { id: 'nbsp-edges', check: 'accepted', client: false, server: true },
    { id: 'non-ascii-persian', check: 'accepted', client: false, server: true },
    { id: 'non-ascii-latin1', check: 'accepted', client: false, server: true },
    { id: 'persian-130-chars', check: 'accepted', client: false, server: true },
    { id: 'emoji-255-chars', check: 'accepted', client: false, server: true },
    { id: 'inner-control-char', check: 'accepted', client: false, server: true },
    { id: 'inner-tab', check: 'accepted', client: false, server: true },
    { id: 'inner-del', check: 'accepted', client: false, server: true },
  ],
  buttonLabel: [],
};

/** Run a CLI helper that reports failure through fail(): which throws CliExit and writes stderr. */
function attempt(fn) {
  const exitCode = process.exitCode;
  const write = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  try {
    return { ok: true, value: fn(), message: '' };
  } catch (error) {
    if (!(error instanceof CliExit)) throw error;
    return { ok: false, value: undefined, message: stderr.trim() };
  } finally {
    process.stderr.write = write;
    process.exitCode = exitCode;
  }
}

function dataReason(message) {
  if (/top-level keys/.test(message)) return 'too_many_keys';
  if (/8 KB/.test(message)) return 'too_large';
  if (/JSON object/.test(message)) return 'not_object';
  return `unknown: ${message}`;
}

test('structured-ping vectors: the fixture is the shape this test reads', { skip }, () => {
  assert.equal(fixture.contract, 'structured-ping-vectors');
  assert.equal(fixture.version, 1);
  assert.deepEqual(fixture.limits, {
    dataMaxBytes: 8192, dataMaxKeys: 25, idempotencyKeyMaxCodePoints: 255, buttonLabelMaxCodePoints: 26,
  });
  for (const section of ['data', 'idempotencyKey', 'buttonLabel']) {
    assert.ok(fixture[section].length > 5, `${section} vectors are missing`);
  }
});

test('data: parseDataObject, requireDataWithinServerCap and serverJsonByteLength agree with the server on every vector', { skip }, () => {
  const observed = [];
  for (const vector of fixture.data) {
    const sent = JSON.stringify(vector.data);
    const parsed = attempt(() => parseDataObject(sent));

    if (parsed.ok !== vector.accepted) {
      observed.push({ id: vector.id, check: 'accepted', client: parsed.ok, server: vector.accepted });
    } else if (!parsed.ok) {
      // Both refuse: the CLI must name a reason the server also found.
      const reason = dataReason(parsed.message);
      assert.ok(vector.reasons.includes(reason), `${vector.id}: the CLI refused as ${reason}; the server's reasons are ${vector.reasons}. ${REGENERATE}`);
    } else {
      assert.deepEqual(parsed.value, vector.data, `${vector.id}: parseDataObject changed the data`);
    }

    // ping merges --item/--url/--location into `data` and checks the merged object.
    if (!Array.isArray(vector.data)) {
      const merged = attempt(() => requireDataWithinServerCap(vector.data));
      if (merged.ok !== vector.accepted) {
        observed.push({ id: vector.id, check: 'mergedPathAccepted', client: merged.ok, server: vector.accepted });
      }
    }

    if (vector.serverBytes !== null) {
      const bytes = serverJsonByteLength(vector.data);
      if (bytes !== vector.serverBytes) {
        observed.push({ id: vector.id, check: 'serverBytes', client: bytes, server: vector.serverBytes });
      }
    }
  }
  assert.deepEqual(observed, KNOWN_DRIFT.data, `unexpected CLI/server disagreement on data. ${REGENERATE}`);
});

test('idempotency key: applyIdempotencyKey agrees with the server on every vector, and sends the trimmed key', { skip }, () => {
  const observed = [];
  for (const vector of fixture.idempotencyKey) {
    const result = attempt(() => applyIdempotencyKey({ idempotency_key: vector.key }, {}));
    if (result.ok !== vector.accepted) {
      observed.push({ id: vector.id, check: 'accepted', client: result.ok, server: vector.accepted });
    } else if (result.ok && result.value['Idempotency-Key'] !== vector.trimmed) {
      observed.push({ id: vector.id, check: 'trimmed', client: result.value['Idempotency-Key'], server: vector.trimmed });
    }
  }
  assert.deepEqual(observed, KNOWN_DRIFT.idempotencyKey, `unexpected CLI/server disagreement on Idempotency-Key. ${REGENERATE}`);
});

// --- through the real commands ----------------------------------------------
//
// The helpers above are only as good as the commands that call them: handoff
// once skipped the shared key check (493a331) and ask/handoff/live once skipped
// the shared data measure (5cf94bd). Each command runs as a subprocess against a
// local stub server and held to the server's verdict (or, where KNOWN_DRIFT says
// the CLI differs, to that known verdict): a refused vector must exit 2 before any
// request, an accepted one must put exactly the expected value on the wire.

/** The server's verdict, except where KNOWN_DRIFT records that the CLI answers differently. */
function expectedVerdict(drift, vector) {
  const known = drift.find((entry) => entry.id === vector.id && entry.check === 'accepted');
  return known ? known.client : vector.accepted;
}

const API_ROOM = 'ab12cd';
const COMMANDS = {
  ask: {
    route: `POST /api/agent/rooms/${API_ROOM}/questions`,
    reply: { id: 'q_1', state: 'pending' },
    args: (base, extra) => ['ask', '--token', 'tok', '--room', API_ROOM, '--api', base, '-p', 'Ship?', ...extra],
  },
  handoff: {
    route: 'POST /api/agent/handoffs',
    reply: { id: 'h_1', state: 'pending', delivery_state: 'pending' },
    args: (base, extra) => ['handoff', '--token', 'tok', '--api', base, '-m', 'Ship?', ...extra],
  },
  ping: {
    route: `POST /api/agent/rooms/${API_ROOM}/notifications`,
    reply: { id: 'n_1' },
    args: (base, extra) => ['ping', '--token', 'tok', '--room', API_ROOM, '--api', base, '-m', 'hi', ...extra],
  },
  'live start': {
    route: `POST /api/agent/rooms/${API_ROOM}/live`,
    reply: { success: true, state: 'active' },
    args: (base, extra) => ['live', 'start', '-c', 'run-1', '-m', 'x', '--token', 'tok', '--room', API_ROOM, '--api', base, ...extra],
  },
  approval: {
    route: `POST /api/agent/rooms/${API_ROOM}/questions`,
    reply: { id: 'q_2', state: 'pending' },
    args: (base, extra) => ['approval', '--token', 'tok', '--room', API_ROOM, '--api', base, '-p', 'Ship?', ...extra],
  },
  'actions trigger': {
    route: `POST /api/agent/rooms/${API_ROOM}/actions/1/trigger`,
    reply: { id: 'n_2' },
    args: (base, extra) => ['actions', 'trigger', '1', '--room', API_ROOM, '--token', 'tok', '--api', base, ...extra],
  },
};

const COMMAND_DATA_VECTORS = [
  'ascii-small', 'persian-at-limit', 'persian-one-over', 'persian-1500-chars', 'emoji-at-limit', 'emoji-one-over',
  'keys-25', 'keys-26', 'top-level-list', 'slash-one-over',
];
const COMMAND_KEY_VECTORS = [
  'uuid', 'inner-spaces', 'leading-trailing-spaces', 'tab-newline-edges', 'len-255-after-trim', 'len-256',
  'empty', 'only-spaces', 'non-ascii-persian', 'inner-control-char',
];

async function withStub(command, fn) {
  const spec = COMMANDS[command];
  const { server, baseUrl, received } = await questionServer({ [spec.route]: () => ({ status: 201, body: spec.reply }) });
  try {
    return await fn(baseUrl, received, spec);
  } finally {
    server.close();
  }
}

for (const command of ['ask', 'handoff', 'ping', 'live start']) {
  test(`${command}: --data is refused or sent as the server's verdict says`, { skip }, async () => {
    await withStub(command, async (base, received, spec) => {
      for (const id of COMMAND_DATA_VECTORS) {
        const vector = fixture.data.find((candidate) => candidate.id === id);
        assert.ok(vector, `fixture has no data vector ${id}`);
        const expected = expectedVerdict(KNOWN_DRIFT.data, vector);
        const before = received.length;
        const { status, stderr } = await runAsync(spec.args(base, ['-d', JSON.stringify(vector.data)]));
        if (expected) {
          assert.equal(status, 0, `${command} ${id}: ${stderr}`);
          assert.equal(received.length, before + 1, `${command} ${id}: no request was made`);
          assert.deepEqual(JSON.parse(received.at(-1).body).data, vector.data, `${command} ${id}: data changed on the wire`);
        } else {
          assert.equal(status, 2, `${command} ${id}: expected a usage error, got ${status}: ${stderr}`);
          assert.equal(received.length, before, `${command} ${id}: sent a request the shared measure refuses`);
        }
      }
    });
  });
}

for (const command of ['ask', 'handoff', 'approval', 'actions trigger']) {
  test(`${command}: --idempotency-key is refused or sent trimmed as the server's verdict says`, { skip }, async () => {
    await withStub(command, async (base, received, spec) => {
      for (const id of COMMAND_KEY_VECTORS) {
        const vector = fixture.idempotencyKey.find((candidate) => candidate.id === id);
        assert.ok(vector, `fixture has no key vector ${id}`);
        const expected = expectedVerdict(KNOWN_DRIFT.idempotencyKey, vector);
        const before = received.length;
        const { status, stderr } = await runAsync(spec.args(base, ['--idempotency-key', vector.key]));
        if (expected) {
          assert.equal(status, 0, `${command} ${id}: ${stderr}`);
          assert.equal(received.length, before + 1, `${command} ${id}: no request was made`);
          assert.equal(received.at(-1).idempotency, vector.trimmed, `${command} ${id}: wrong Idempotency-Key on the wire`);
        } else {
          assert.equal(status, 2, `${command} ${id}: expected a usage error, got ${status}: ${stderr}`);
          assert.equal(received.length, before, `${command} ${id}: sent a request the shared check refuses`);
        }
      }
    });
  });
}

test('button label: ping --url --button-label counts code points like the server', { skip }, async () => {
  const observed = [];
  await withStub('ping', async (base, received, spec) => {
    for (const vector of fixture.buttonLabel) {
      const before = received.length;
      const { status, stderr } = await runAsync(spec.args(base, ['--url', 'https://example.com/build/512', '--button-label', vector.label]));
      const accepted = status === 0;
      if (status !== 0 && status !== 2) assert.fail(`${vector.id}: unexpected exit ${status}: ${stderr}`);
      if (accepted !== vector.accepted) {
        observed.push({ id: vector.id, check: 'accepted', client: accepted, server: vector.accepted });
      } else if (accepted) {
        assert.equal(JSON.parse(received.at(-1).body).data.button_label, vector.label, `${vector.id}: label changed on the wire`);
      } else {
        assert.equal(received.length, before, `${vector.id}: sent a request with a label the server refuses`);
      }
    }
  });
  assert.deepEqual(observed, KNOWN_DRIFT.buttonLabel, `unexpected CLI/server disagreement on button_label. ${REGENERATE}`);
});
