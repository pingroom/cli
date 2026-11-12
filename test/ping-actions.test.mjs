import test from 'node:test';
import assert from 'node:assert/strict';
import { run, runAsync, startServer } from './helpers.mjs';
import { splitPingActionFlag } from '../lib/ping-actions.js';

const SECRET = '81a29861609a0f98edae7253d871a336aa20ef1df78d1dac0da521d983b54623';

/** A stub that records every request body and answers with `reply`. */
async function recordingServer(reply = { success: true, notification_id: 'n1' }) {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  return { server, baseUrl, received };
}

test('splitPingActionFlag splits at the = before the URL scheme', () => {
  assert.deepEqual(splitPingActionFlag('Open dashboard=https://grafana.example.com/d?x=1'), { label: 'Open dashboard', url: 'https://grafana.example.com/d?x=1' });
  assert.deepEqual(splitPingActionFlag('a=b=https://x.example.com/'), { label: 'a=b', url: 'https://x.example.com/' });
  assert.deepEqual(splitPingActionFlag('Go=http://x.example.com/'), { label: 'Go', url: 'http://x.example.com/' });
  assert.equal(splitPingActionFlag('Open dashboard'), null);
  assert.equal(splitPingActionFlag('https://x.example.com/'), null);
});

test('--action-url and --action-webhook build data.actions in order, with paired --action-body', async () => {
  const { server, baseUrl, received } = await recordingServer();
  try {
    const r = await runAsync([
      'ping', '-w', `${baseUrl}/hook`, '-m', 'Disk 91% on db-2', '-d', '{"run":7}',
      '--action-webhook', 'Clean up now=https://ops.example.com/cleanup',
      '--action-url', 'Open dashboard=https://grafana.example.com/d/disk',
      '--action-body', '{"host":"db-2"}',
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(received[0].body.data, {
      run: 7,
      actions: [
        { label: 'Open dashboard', type: 'open_url', url: 'https://grafana.example.com/d/disk' },
        { label: 'Clean up now', type: 'webhook', url: 'https://ops.example.com/cleanup', body: { host: 'db-2' } },
      ],
    });
  } finally {
    server.close();
  }
});

test('the agent-token send carries buttons too and prints the signing secret', async () => {
  const { server, baseUrl, received } = await recordingServer({ id: 'n1', message: 'x', action_signing_secret: SECRET });
  try {
    const r = await runAsync([
      'ping', '--token', 'pr_test', '--room', 'AB12CD', '--api', baseUrl, '-m', 'Disk 91%',
      '--action-webhook', 'Clean up now=https://ops.example.com/cleanup',
    ], { GITHUB_ACTIONS: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(received[0].url, '/api/agent/rooms/AB12CD/notifications');
    assert.deepEqual(received[0].body.data.actions, [{ label: 'Clean up now', type: 'webhook', url: 'https://ops.example.com/cleanup' }]);
    assert.match(r.stdout, new RegExp(`Button signing secret: ${SECRET}`));
    assert.doesNotMatch(r.stdout, /::add-mask::/);

    // Inside GitHub Actions the secret is masked in the log first.
    const masked = await runAsync([
      'ping', '--token', 'pr_test', '--room', 'AB12CD', '--api', baseUrl, '-m', 'Disk 91%',
      '--action-webhook', 'Clean up now=https://ops.example.com/cleanup',
    ], { GITHUB_ACTIONS: 'true' });
    assert.equal(masked.status, 0, masked.stderr);
    assert.ok(masked.stdout.indexOf(`::add-mask::${SECRET}`) < masked.stdout.indexOf('Button signing secret'));

    // --json prints the raw response, the secret included, and nothing else.
    const json = await runAsync([
      'ping', '--token', 'pr_test', '--room', 'AB12CD', '--api', baseUrl, '-m', 'Disk 91%', '--json',
      '--action-webhook', 'Clean up now=https://ops.example.com/cleanup',
    ]);
    assert.equal(JSON.parse(json.stdout).action_signing_secret, SECRET);
    assert.doesNotMatch(json.stdout, /Button signing secret/);
  } finally {
    server.close();
  }
});

test('a button the server would refuse fails before any request, naming the flag', () => {
  const base = ['ping', '-w', 'http://127.0.0.1:9/hook', '-m', 'hi'];
  const cases = [
    [['--action-url', 'paypal.com=https://evil.example.com/'], /--action-url #1 label: .*web address, domain name or IP address/],
    [['--action-url', '👍 Pong Back=https://example.com/'], /--action-url #1 label: That label is one of PingRoom's own buttons/],
    [['--action-url', 'Go=http://example.com/'], /--action-url #1 url: A button url must start with https:\/\//],
    [['--action-url', 'Go=https://paypal.com@evil.example.com/'], /plain hostname/],
    [['--action-url', 'Go=https://127.0.0.1/'], /public hostname/],
    [['--action-webhook', 'Run=https://ops.example.com:8443/'], /--action-webhook #1 url: .*cannot name a port/],
    [['--action-webhook', 'Run=https://ops.example.com/', '--action-body', '["x"]'], /--action-webhook #1 \(--action-body\): .*JSON object/],
    [['--action-webhook', 'Run=https://ops.example.com/', '--action-body', '{nope'], /--action-body #1 must be valid JSON/],
    [['--action-url', 'Open dashboard'], /--action-url must be "Label=https:\/\/…"/],
    [['--action-body', '{"a":1}'], /--action-body requires --action-webhook/],
    [['--action-webhook', 'A=https://a.example.com/', '--action-webhook', 'B=https://b.example.com/', '--action-body', '{}'], /pairs with --action-webhook by position/],
    [['--action-url', 'A=https://a.example.com/', '--action-url', 'B=https://b.example.com/', '--action-url', 'C=https://c.example.com/', '--action-url', 'D=https://d.example.com/'], /1 to 3 buttons/],
    [['--action-url', 'Go=https://example.com/', '-d', '{"actions":[]}'], /cannot be combined with data\.actions in --data/],
    [['-d', '{"actions":[{"label":"Go","type":"open_url","url":"https://localhost/"}]}'], /--data data\.actions\.0\.url: .*public hostname/],
    [['--action-url', 'Go=https://example.com/', '--require-ack'], /cannot use --require-ack/],
  ];
  for (const [flags, pattern] of cases) {
    const r = run([...base, ...flags]);
    assert.equal(r.status, 2, `${flags.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, pattern, flags.join(' '));
  }
});

test('--replace and --withdraw refuse the button flags, and --replace refuses data.actions', () => {
  const token = ['--token', 'pr_test', '--room', 'AB12CD', '--api', 'http://127.0.0.1:9'];
  let r = run(['ping', ...token, '-m', 'hi', '--replace', 'n1', '--action-url', 'Go=https://example.com/']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--action-url cannot be used with --replace/);
  r = run(['ping', ...token, '-m', 'hi', '--replace', 'n1', '-d', '{"actions":[{"label":"Go","type":"open_url","url":"https://example.com/"}]}']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ping --replace cannot carry buttons/);
  r = run(['ping', ...token, '--withdraw', 'n1', '--action-webhook', 'Run=https://ops.example.com/']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--action-webhook cannot be used with --withdraw/);
});

test('ask, handoff and live refuse data.actions before the request', () => {
  const data = ['--data', '{"actions":[{"label":"Go","type":"open_url","url":"https://example.com/"}]}'];
  const token = ['--token', 'pr_test', '--room', 'AB12CD', '--api', 'http://127.0.0.1:9'];
  const cases = [
    [['ask', '-p', 'Ship?', '-o', 'yes', '-o', 'no', ...token, ...data], /A question cannot carry buttons/],
    [['handoff', '-m', 'Look', '--token', 'pr_test', '--api', 'http://127.0.0.1:9', ...data], /A handoff cannot carry buttons/],
    [['live', 'start', '-c', 'c1', '-m', 'Deploying', ...token, ...data], /A live-progress stream cannot carry buttons/],
  ];
  for (const [argv, pattern] of cases) {
    const r = run(argv);
    assert.notEqual(r.status, 0, argv.join(' '));
    assert.match(r.stderr, pattern, `${argv.join(' ')}: ${r.stderr}`);
  }
});

test('ping --help documents the button flags', () => {
  const { status, stdout } = run(['ping', '-h']);
  assert.equal(status, 0);
  for (const flag of ['--action-url', '--action-webhook', '--action-body']) {
    assert.match(stdout, new RegExp(flag));
  }
});
