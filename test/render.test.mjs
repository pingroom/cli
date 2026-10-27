// Direct unit tests for lib/render.js. The rest of the suite spawns the CLI as
// a subprocess, which is the only honest way to assert exit codes and stream
// contracts — but it is a poor fit for the pure spec-string parsers, where the
// interesting cases are cheap and numerous. These run in-process.
//
// Only total functions are exercised here: every rejection path in render.js
// calls fail(), which writes to stderr and ends the command. Those refusals
// stay covered by the subprocess tests in cli.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMetrics, buildOptions, canonicalTemplate, exitForWatch, formatPollProgress, formatPollTally, isApprovalShape,
  normalizeAccent, printResolution, printApproval, printHandoff,
} from '../lib/render.js';
import { stripControlChars } from '../lib/util.js';

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
    assert.equal(output, 'deny state=approved[2J\ndeny state=approved[2J\nid=h1\nstate=answered\ncorrelation-id=corr state=approved\nanswer=deny state=approved[2J\n');
    assert.doesNotMatch(output, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  } finally { process.stdout.write = write; }
});

test('stripControlChars turns tabs and line breaks into one space instead of gluing words', () => {
  assert.equal(stripControlChars('ship it\nnow'), 'ship it now');
  assert.equal(stripControlChars('a\r\nb\tc'), 'a b c');
  assert.equal(stripControlChars('x\x1b[2J\x07y\x9b'), 'x[2Jy');
  assert.doesNotMatch(stripControlChars('one\n\ttwo\rthree'), /[\x00-\x1f\x7f-\x9f]/);
});

test('formatPollTally lists every option in order and cannot be forged by an option value', () => {
  const results = {
    audience_count: 5,
    response_count: 4,
    options: [{ value: 'pizza', count: 3 }, { value: 'tacos\nstate=approved', count: 1 }, { value: 'sushi', count: 0 }],
  };
  assert.equal(formatPollTally(results), 'pizza 3 · tacos state=approved 1 · sushi 0 · 4 of 5 voted');
  assert.equal(formatPollTally(null), '');
  assert.equal(formatPollTally({ audience_count: 2 }), '');
});

test('formatPollProgress marks polls only', () => {
  assert.equal(formatPollProgress({ resolution_policy: 'all', results: { audience_count: 5, response_count: 2, options: [] } }), '  [poll 2/5 voted]');
  assert.equal(formatPollProgress({ resolution_policy: 'first', results: null }), '');
  assert.equal(formatPollProgress({ resolution_policy: 'all', results: null }), '');
});

test('a closed poll prints its winner to stdout and the tally to stderr; a tie prints no winner', () => {
  const write = process.stdout.write;
  const writeErr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = (chunk) => { out += chunk; return true; };
  process.stderr.write = (chunk) => { err += chunk; return true; };
  try {
    const results = { audience_count: 3, response_count: 3, options: [{ value: 'a', count: 2 }, { value: 'b', count: 1 }] };
    printResolution({ state: 'answered', resolution_policy: 'all', answer: { value: 'a', text: null }, results });
    printResolution({ state: 'answered', resolution_policy: 'all', answer: null, results: { ...results, options: [{ value: 'a', count: 1 }, { value: 'b', count: 1 }], response_count: 2 } });
    printResolution({ state: 'cancelled', resolution_policy: 'all', answer: null, results });
    assert.equal(out, 'a\n');
    assert.equal(err,
      'pingroom: poll closed: a 2 · b 1 · 3 of 3 voted\n'
      + 'pingroom: poll tied: a 1 · b 1 · 2 of 3 voted\n'
      + 'pingroom: question cancelled\n'
      + 'pingroom: poll: a 2 · b 1 · 3 of 3 voted\n');
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
});

test('watch treats exactly the approve/deny pair as a gate, and nothing else', () => {
  const pair = [{ value: 'approve', label: 'Approve' }, { value: 'deny', label: 'Deny' }];
  assert.equal(isApprovalShape({ options: pair }), true);
  assert.equal(isApprovalShape({ options: [...pair].reverse() }), true);
  assert.equal(isApprovalShape({ options: ['approve', 'deny'] }), true);
  assert.equal(isApprovalShape({ options: [...pair, { value: 'hold' }] }), false);
  assert.equal(isApprovalShape({ options: [{ value: 'allow' }, { value: 'deny' }] }), false);
  assert.equal(isApprovalShape({}), false);

  const answered = (value, options = pair) => ({ state: 'answered', options, answer: value === null ? null : { value } });
  assert.equal(exitForWatch(answered('approve')), 0);
  assert.equal(exitForWatch(answered('deny')), 4);
  assert.equal(exitForWatch(answered(null)), 4, 'a tied approve/deny poll did not approve');
  assert.equal(exitForWatch({ state: 'expired', options: pair, answer: null }), 3);
  assert.equal(exitForWatch(answered('deny', [{ value: 'hold' }, { value: 'deny' }])), 0);
});
