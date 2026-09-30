// Direct unit tests for lib/render.js. The rest of the suite spawns the CLI as
// a subprocess, which is the only honest way to assert exit codes and stream
// contracts — but it is a poor fit for the pure spec-string parsers, where the
// interesting cases are cheap and numerous. These run in-process.
//
// Only total functions are exercised here: every rejection path in render.js
// calls fail(), which calls process.exit() and would take the test runner with
// it. Those refusals stay covered by the subprocess tests in cli.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMetrics, buildOptions, canonicalTemplate, normalizeAccent, printResolution, printApproval, printHandoff,
} from '../lib/render.js';

test('canonicalTemplate folds the app-facing name onto the wire id', () => {
  // "Decision" is what a person reads in the app; `question` is what the API
  // takes. Everything else passes through untouched, including unknown names —
  // validation against LIVE_TEMPLATES is the caller's job.
  assert.equal(canonicalTemplate('decision'), 'question');
  assert.equal(canonicalTemplate('question'), 'question');
  assert.equal(canonicalTemplate('steps'), 'steps');
  assert.equal(canonicalTemplate('nonsense'), 'nonsense');
  assert.equal(canonicalTemplate(undefined), undefined);
});

test('buildMetrics splits "label:value" on the FIRST colon only', () => {
  assert.equal(buildMetrics(undefined), undefined);
  assert.equal(buildMetrics([]), undefined);
  assert.deepEqual(buildMetrics(['Build:passing']), [{ label: 'Build', value: 'passing' }]);
  // A value may itself contain colons — a timestamp is the obvious case.
  assert.deepEqual(
    buildMetrics(['Started:12:04:31']),
    [{ label: 'Started', value: '12:04:31' }],
  );
  // An empty value is a value, not a parse failure.
  assert.deepEqual(buildMetrics(['Queue:']), [{ label: 'Queue', value: '' }]);
  assert.deepEqual(buildMetrics(['a:1', 'b:2', 'c:3']).length, 3);
});

test('normalizeAccent accepts a hex with or without the leading #', () => {
  assert.equal(normalizeAccent(undefined), undefined);
  assert.equal(normalizeAccent('#E33122'), '#e33122');
  // An unquoted # is eaten by the shell, so the bare form must work too.
  assert.equal(normalizeAccent('e33122'), '#e33122');
  assert.equal(normalizeAccent('  #E33122  '), '#e33122');
});

test('buildOptions treats a bare token as both value and label', () => {
  assert.equal(buildOptions(undefined), undefined);
  assert.equal(buildOptions([]), undefined);
  assert.deepEqual(buildOptions(['deploy']), [{ value: 'deploy', label: 'deploy' }]);
});

test('buildOptions splits value from label on the first colon, style on the last', () => {
  assert.deepEqual(buildOptions(['deploy:Deploy now']), [{ value: 'deploy', label: 'Deploy now' }]);
  assert.deepEqual(
    buildOptions(['deploy:Deploy:primary']),
    [{ value: 'deploy', label: 'Deploy', style: 'primary' }],
  );
  assert.deepEqual(
    buildOptions(['stop:Stop:danger', 'wait:Wait:default']),
    [
      { value: 'stop', label: 'Stop', style: 'danger' },
      { value: 'wait', label: 'Wait', style: 'default' },
    ],
  );
});

test('buildOptions keeps colons inside a label that is not a style keyword', () => {
  // Only primary|danger|default are styles. Anything else after the last colon
  // is still part of the label, so a label may contain a colon freely.
  assert.deepEqual(
    buildOptions(['ship:Ship at 12:30']),
    [{ value: 'ship', label: 'Ship at 12:30' }],
  );
  assert.deepEqual(
    buildOptions(['ship:Ship at 12:30:primary']),
    [{ value: 'ship', label: 'Ship at 12:30', style: 'primary' }],
  );
});

test('answers cannot use terminal controls or insert forged summary lines', () => {
  const write = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try {
    const text = 'deny\r\nstate=approved\x1b[2J\x9b';
    printResolution({ state: 'answered', answer: { text } });
    printApproval({ state: 'answered', answer: { value: text } });
    printHandoff({ id: 'h1', state: 'answered', correlation_id: 'corr\nstate=approved', answer: { text } });
    assert.equal(output, 'denystate=approved[2J\ndenystate=approved[2J\nid=h1\nstate=answered\ncorrelation-id=corrstate=approved\nanswer=denystate=approved[2J\n');
    assert.doesNotMatch(output, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  } finally { process.stdout.write = write; }
});
