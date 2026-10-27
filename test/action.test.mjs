import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as parserModule from '../lib/parser.js';
import { CLI, baseEnv, run, transportServer } from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('GitHub Action forwards acknowledgement inputs to the CLI', () => {
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  assert.match(action, /^  require-ack:/m);
  assert.match(action, /^  ack-timeout:/m);
  assert.match(action, /args\+=\(--require-ack\)/);
  assert.match(action, /args\+=\(--ack-timeout "\$PR_ACK_TIMEOUT"\)/);
});

test('GitHub Action forwards urgency as its own input, separate from acknowledgement', () => {
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  assert.match(action, /^  urgent:/m);
  assert.match(action, /args\+=\(--urgent\)/);
});

test('GitHub Action can ask the room, not only the connecting account', () => {
  // Without a `scope` input every Action question defaults to responder_scope
  // "direct", so a workflow written to poll the room quietly polled one person
  // and still reported success.
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  assert.match(action, /^  scope:/m);
  assert.match(action, /PR_SCOPE: \$\{\{ inputs\.scope \}\}/);
  assert.match(action, /args\+=\(--scope "\$PR_SCOPE"\)/);
});

test('GitHub Action does not advertise "me" as an ask target', () => {
  // `me` is a handoff-only shorthand; the questions API wants a member uuid and
  // rejects it. One shared `target` input feeds both branches, so the
  // description has to say which is which.
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  const target = action.split('\n').find((l) => l.includes('For a handoff: "me"'));
  assert.ok(target, 'target input description not found');
  assert.match(target, /For an ask: a specific room member uuid/);
});

test('GitHub Action exposes handoff inputs and outputs', () => {
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  // Handoff inputs
  assert.match(action, /^  handoff:/m);
  assert.match(action, /^  question:/m);
  assert.match(action, /^  options:/m);
  assert.match(action, /^  idempotency-key:/m);
  assert.match(action, /^  target:/m);
  assert.match(action, /^  expires-in:/m);
  assert.match(action, /^  wait:/m);
  // Outputs
  assert.match(action, /^outputs:/m);
  assert.match(action, /^  handoff-id:/m);
  assert.match(action, /^  state:/m);
  assert.match(action, /^  acknowledged-by:/m);
  assert.match(action, /^  answer:/m);
  assert.match(action, /^  delivery-state:/m);
  // The CLI owns GitHub's output-file protocol; the shell never interprets
  // untrusted answer stdout as output commands.
  assert.match(action, /args=\(handoff -m "\$PR_MESSAGE"\)/);
  assert.match(action, /Idempotency-Key/i);
  assert.match(action, /--github-output "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(action, /while IFS=['"]?=['"]? read/);
  assert.doesNotMatch(action, />>\s*"\$GITHUB_OUTPUT"/);
  assert.match(action, /exit \$code/);
  assert.match(action, /@pingroom\/cli@\d+\.\d+\.\d+/);
});

test('GitHub Action exposes ask inputs and outputs through the same output protocol', () => {
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  // Inputs
  assert.match(action, /^  ask:/m);
  assert.match(action, /^  context:/m);
  assert.match(action, /^  timeout:/m);
  assert.match(action, /^  api:/m);
  // The API override rides an env var, not a flag, so it applies to every mode.
  assert.match(action, /^        PINGROOM_API_URL: \$\{\{ inputs\.api \}\}$/m);
  assert.doesNotMatch(action, /args\+=\(--api /);
  // Output
  assert.match(action, /^  question-id:/m);
  // The ask branch must be reachable — i.e. come before the unconditional ping
  // fallback — and reuse the shared splitter and the CLI-owned output file.
  assert.match(action, /if \[ "\$PR_ASK" = "true" \]; then/);
  assert.match(action, /args=\(ask -p "\$PR_MESSAGE" --room "\$PR_ROOM"\)/);
  assert.ok(
    action.indexOf('args=(ask -p "$PR_MESSAGE"') < action.indexOf('args=(ping -m "$PR_MESSAGE")'),
    'the ask branch must precede the ping fallback',
  );
  assert.match(action, /args\+=\(-c "\$PR_CONTEXT"\)/);
  assert.match(action, /args\+=\(--timeout "\$PR_TIMEOUT"\)/);
  // Two branches, two re-raised exit codes, plus the ping fallback's own path.
  assert.equal(action.match(/--github-output "\$GITHUB_OUTPUT"/g).length, 2);
  assert.equal(action.match(/exit \$code/g).length, 2);
});

test('GitHub Action passes --room to ping only alongside a token, and never with webhook-url', () => {
  // An explicit --room selects the agent-token path, so webhook-url + room
  // (no token) must keep pinging the webhook's room, and webhook-url + token
  // + room must too (the 0.13.0 precedence). Behaviour is covered by
  // "the Action keeps webhook-url ahead of token and room" below.
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  assert.match(action, /\[ -n "\$PINGROOM_WEBHOOK_URL" \] && unset PINGROOM_TOKEN\n\s*\[ -n "\$PR_ROOM" \] && \[ -n "\$PINGROOM_TOKEN" \] && args\+=\(--room "\$PR_ROOM"\)/);
  // The input descriptions say so.
  assert.match(action, /^  webhook-url:\n    description: '[^']*takes precedence/m);
  assert.match(action, /^  token:\n    description: '[^']*webhook-url wins when both are set/m);
});

test('GitHub Action splits options on newlines first so a label may contain a comma', () => {
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  // One shared splitter, used by every branch that forwards options.
  assert.match(action, /^        split_options\(\) \{$/m);
  // Newline-primary guard: a value containing a newline is never run through
  // `tr ',' '\n'`, which used to shred "ship:Ship it, now" into two options.
  assert.match(action, /if \[ "\$\{raw#\*\$'\\n'\}" != "\$raw" \]; then/);
  assert.match(action, /for opt in "\$\{PR_OPTS\[@\]\}"; do args\+=\(-o "\$opt"\); done/);
  // The comma fallback survives, but only for single-line input.
  assert.match(action, /tr ',' '\\n'/);
  // The input documents the newline form as the one that supports commas.
  assert.match(action, /one per line \(preferred\)/);
});

// Release policy: package.json is the single source of the version — bin/ reads
// it at startup — so no test hardcodes a literal. Keep the lockfile aligned;
// advance the Action's `npx` pin only after the new package is published.
test('source versions and the GitHub Action pin align for a completed release', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'));
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  // Release prep may temporarily differ. A completed release must update the
  // Action after npm publication; CI checks that the pinned package exists.
  const pinned = action.match(/@pingroom\/cli@(\d+\.\d+\.\d+)/)?.[1];
  assert.ok(pinned, 'Action must pin a concrete CLI version');
  assert.equal(pinned, pkg.version, 'Publish the CLI, then advance its Action pin before completing the release');
});

/** Read action.yml once; every static Action assertion below shares it. */
function readAction() {
  return readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
}

/**
 * Every flag `action.yml` hands the CLI, grouped by the subcommand it runs.
 * Flags are read out of three places inside each branch: the `args=(<cmd> …)`
 * initializer, every `args+=(…)` append, and anything appended directly to the
 * `$CLI "${args[@]}"` invocation.
 */
function actionFlagsByCommand() {
  const action = readAction();
  const run = action.slice(action.indexOf('      run: |'));
  const starts = [...run.matchAll(/args=\((\w+) /g)];
  assert.ok(starts.length > 0, 'no `args=(<command> …)` invocation found in action.yml');
  const byCommand = new Map();
  starts.forEach((start, i) => {
    const body = run.slice(start.index, starts[i + 1]?.index ?? run.length);
    const flags = byCommand.get(start[1]) ?? new Set();
    const groups = [
      ...body.matchAll(/args\+?=\(([^)]*)\)/g),
      ...body.matchAll(/\$CLI "\$\{args\[@\]\}"([^\n]*)/g),
    ];
    for (const [, group] of groups) {
      for (const [token] of group.matchAll(/(?<![\w-])--?[A-Za-z][\w-]*/g)) flags.add(token);
    }
    byCommand.set(start[1], flags);
  });
  return byCommand;
}

/** command name -> the parser bin/pingroom.js dispatches it to. */
function parserByCommand() {
  const bin = readFileSync(CLI, 'utf8');
  const table = bin.slice(bin.indexOf('const COMMANDS = {'));
  const map = new Map();
  for (const [, command, parserName] of table.matchAll(/^ {2}(\w+): \(rest\) => \w+\((parse\w+)\(rest\)\)/gm)) {
    map.set(command, parserModule[parserName]);
  }
  return map;
}

test('every flag the GitHub Action passes is one the CLI parser accepts', () => {
  // The gate a version comparison alone cannot provide. `ask --github-output`
  // shipped dead because the flag was wired into the handoff parser only:
  // action.yml and package.json both still read "0.7.2", so the release test
  // passed while every ask run exited 2 with "Unknown option: --github-output".
  //
  // Both sides are derived — flags from action.yml, vocabulary from the parser
  // tables — so a newly forwarded flag is covered without editing this test.
  // The pin/version equality asserted above is what carries this check from
  // this tree onto the release the Action actually invokes.
  const parserFor = parserByCommand();
  const byCommand = actionFlagsByCommand();

  // The branches the Action can take. If one is renamed or dropped, fail here
  // instead of silently checking less.
  assert.deepEqual([...byCommand.keys()].sort(), ['ask', 'handoff', 'ping']);

  for (const [command, flags] of byCommand) {
    const parser = parserFor.get(command);
    assert.ok(parser, `bin/pingroom.js does not dispatch "${command}" to a parser`);
    assert.ok(parser.flags instanceof Set, `parser for "${command}" publishes no flag table`);
    assert.ok(flags.size > 0, `no flags were parsed out of the ${command} branch`);
    for (const flag of flags) {
      assert.ok(
        parser.flags.has(flag),
        `action.yml passes "${command} ${flag}", which the CLI parser rejects as an unknown option`,
      );
    }
  }
});

// `ask`, `context`, `timeout` and the `question-id` output landed in this
// release. Anything older silently drops them.
const MIN_ASK_VERSION = [0, 7, 3];

const ASK_ERA_INPUTS = ['ask', 'context', 'timeout'];

test('README pins the ask example to a tag that actually carries the ask inputs', () => {
  // Documented under `@v0`, these inputs are dropped by GitHub as unexpected,
  // the step falls through to the unconditional ping fallback, `outputs.answer`
  // never sets, and the downstream approval gate silently never fires. A doc bug
  // that fails OPEN, so the pin and the inputs must agree in the same example.
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let checked = 0;
  for (const chunk of readme.split(/(?=^ *-? *uses: pingroom\/cli@)/m)) {
    const ref = chunk.match(/^ *-? *uses: pingroom\/cli@(\S+)/m)?.[1];
    if (!ref) continue;
    // Bound the step at the end of its fenced block so later prose can't leak in.
    const step = chunk.split(/^```/m)[0];
    const used = ASK_ERA_INPUTS.filter((input) => new RegExp(`^ +${input}:`, 'm').test(step));
    if (used.length === 0) continue;
    checked += 1;
    const version = ref.match(/^v(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
    const want = `v${MIN_ASK_VERSION.join('.')}`;
    assert.ok(version, `README documents ${used.join('/')} under the floating pin "${ref}"; pin an exact tag >= ${want}`);
    assert.ok(
      compare(version, MIN_ASK_VERSION) >= 0,
      `README documents ${used.join('/')} under "${ref}", which predates ${want}`,
    );
  }
  assert.ok(checked > 0, 'the README no longer documents the ask inputs at all');
  // And the requirement is stated in prose, not left for the reader to infer.
  assert.match(readme, new RegExp(`v${MIN_ASK_VERSION.join('\\.')}`));
});

/**
 * Extract the Action's split_options() helper and run it under real bash, so the
 * separator rule is exercised against the shipped shell rather than a paraphrase
 * of it. Returns the resulting PR_OPTS elements.
 */
function runSplitOptions(input) {
  const fn = readAction().match(/^( *)split_options\(\) \{\n[\s\S]*?\n\1\}$/m)?.[0];
  assert.ok(fn, 'split_options() not found in action.yml');
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-split-'));
  const script = join(dir, 'split.sh');
  writeFileSync(script, [
    fn,
    'split_options "$1"',
    'for o in "${PR_OPTS[@]}"; do printf \'%s\\n\' "$o"; done',
    '',
  ].join('\n'));
  try {
    const r = spawnSync('bash', [script, input], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').filter((line) => line !== '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('split_options strips trailing newlines before choosing a separator', () => {
  // `options: |` always carries a trailing newline. Choosing the separator
  // BEFORE stripping it sent every single-line block scalar down the newline
  // path, yielding ONE option whose label had swallowed the commas and the rest
  // of the line — the exact input the `options` description tells users to send.
  assert.deepEqual(runSplitOptions('deploy:Deploy,hold:Hold'), ['deploy:Deploy', 'hold:Hold']);
  assert.deepEqual(runSplitOptions('deploy:Deploy,hold:Hold\n'), ['deploy:Deploy', 'hold:Hold']);
  assert.deepEqual(runSplitOptions('deploy:Deploy\nhold:Hold\n'), ['deploy:Deploy', 'hold:Hold']);
  // A newline surviving the strip still wins, so a comma inside a label is kept.
  assert.deepEqual(runSplitOptions('ship:Ship it, now\nhold:Hold'), ['ship:Ship it, now', 'hold:Hold']);
  // The strip runs before the decision, not instead of it: an all-blank value
  // yields no options rather than one empty one.
  assert.deepEqual(runSplitOptions('  \n '), []);
});

/**
 * Run the Action's `run:` script under bash the way a composite step does
 * (`bash --noprofile --norc -eo pipefail`), with the npx pin swapped for this
 * tree's CLI. `env` carries the step's inputs.
 */
function runActionScript(env) {
  const action = readAction();
  const marker = '      run: |\n';
  const script = action
    .slice(action.indexOf(marker) + marker.length)
    .split('\n')
    .map((line) => (line.startsWith('        ') ? line.slice(8) : line))
    .join('\n');
  const pin = /^CLI="npx --yes @pingroom\/cli@\d+\.\d+\.\d+"$/m;
  assert.match(script, pin, 'the Action must still invoke the pinned CLI through $CLI');
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-action-'));
  const wrapper = join(dir, 'pingroom');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const step = join(dir, 'step.sh');
  writeFileSync(step, script.replace(pin, `CLI="${wrapper}"`));
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', step], {
      env: { ...baseEnv(), GITHUB_OUTPUT: join(dir, 'github-output'), ...env },
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (status) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ status, stderr });
    });
  });
}

test('the Action keeps webhook-url ahead of token and room for a ping, so a pin bump changes no transport', async () => {
  // 0.13.0 pinged the webhook whenever one was set. From 0.14.0 an explicit
  // --room selects the token path, so the Action must hand the ping neither.
  const { server, baseUrl, received } = await transportServer();
  const webhook = `${baseUrl}/webhooks/room/HOOKSECRET`;
  try {
    for (const [inputs, path, auth] of [
      [{ PINGROOM_WEBHOOK_URL: webhook, PINGROOM_TOKEN: 'tok', PR_ROOM: 'ab12cd' }, '/webhooks/room/HOOKSECRET', undefined],
      [{ PINGROOM_WEBHOOK_URL: webhook, PR_ROOM: 'ab12cd' }, '/webhooks/room/HOOKSECRET', undefined],
      [{ PINGROOM_WEBHOOK_URL: webhook, PINGROOM_TOKEN: 'tok' }, '/webhooks/room/HOOKSECRET', undefined],
      [{ PINGROOM_TOKEN: 'tok', PR_ROOM: 'ab12cd' }, '/api/agent/rooms/ab12cd/notifications', 'Bearer tok'],
    ]) {
      const before = received.length;
      const { status, stderr } = await runActionScript({ PINGROOM_API_URL: baseUrl, PR_MESSAGE: 'Deploy shipped', ...inputs });
      const label = Object.keys(inputs).join(' + ');
      assert.equal(status, 0, `${label}: ${stderr}`);
      assert.deepEqual(received.slice(before).map((r) => r.path), [path], label);
      assert.equal(received.at(-1).auth, auth, label);
    }
  } finally {
    server.close();
  }
});
