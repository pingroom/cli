#!/usr/bin/env node
// @pingroom/cli — send a PingRoom ping from CI, a script, or an agent.
// Zero dependencies: uses Node's built-in fetch (Node >= 20).
//
// Two delivery modes:
//   1. Webhook (best for CI) — a room webhook URL carries its own secret, so no
//      browser auth is needed. `pingroom ping -w <url> -m "deploy ok"`.
//   2. Agent token — a Bearer credential + room invite code hits the agent API.
//      `pingroom ping --token <t> --room <code> -m "deploy ok"`.

const DEFAULT_API = process.env.PINGROOM_API_URL || 'https://api.pingroom.io';

const HELP = `pingroom — send a ping to a PingRoom room

Usage:
  pingroom ping [options]

Options:
  -m, --message <text>   Ping body text (required)
  -t, --title <text>     Ping title (<= 40 chars)
  -a, --action <1-4>     Quick-action slot to attribute the ping to
  -d, --data <json>      Extra JSON data object, e.g. '{"commit":"abc123"}'
  -w, --webhook <url>    Room webhook URL (or env PINGROOM_WEBHOOK_URL)
      --token <token>    Agent access token (or env PINGROOM_TOKEN)
      --room <code>      Room invite code (used with --token)
      --api <url>        API base URL (default ${DEFAULT_API}; env PINGROOM_API_URL)
      --json             Print the raw JSON response
  -h, --help             Show this help

Examples:
  pingroom ping -w "$PINGROOM_WEBHOOK_URL" -m "Deploy succeeded ✅"
  pingroom ping -w "$PINGROOM_WEBHOOK_URL" -t "CI" -m "Build #42 failed" -a 2
  pingroom ping --token "$PINGROOM_TOKEN" --room ab12cd -m "Release shipped" \\
    -d '{"version":"1.4.0","env":"prod"}'

Exit codes: 0 on success, 1 on delivery failure, 2 on bad usage.`;

function parseArgs(argv) {
  const args = { _: [] };
  const alias = {
    '-m': 'message', '--message': 'message',
    '-t': 'title', '--title': 'title',
    '-a': 'action', '--action': 'action',
    '-d': 'data', '--data': 'data',
    '-w': 'webhook', '--webhook': 'webhook',
    '--token': 'token',
    '--room': 'room',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--json' || token === '-h' || token === '--help') {
      args[alias[token]] = true;
      continue;
    }
    const key = alias[token];
    if (key) {
      args[key] = argv[++i];
    } else if (token.startsWith('-')) {
      fail(`Unknown option: ${token}`, 2);
    } else {
      args._.push(token);
    }
  }
  return args;
}

function fail(message, code = 1) {
  process.stderr.write(`pingroom: ${message}\n`);
  process.exit(code);
}

async function postJson(url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    fail(`network error: ${err.message}`);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }

  return { res, text, json };
}

async function ping(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return 0; }

  const message = args.message;
  if (!message) fail('a --message is required', 2);

  if (args.action !== undefined && !/^[1-4]$/.test(String(args.action))) {
    fail('--action must be an integer 1–4', 2);
  }

  let data;
  if (args.data !== undefined) {
    try {
      data = JSON.parse(args.data);
    } catch {
      fail('--data must be valid JSON', 2);
    }
    if (typeof data !== 'object' || Array.isArray(data) || data === null) {
      fail('--data must be a JSON object', 2);
    }
  }

  const webhook = args.webhook || process.env.PINGROOM_WEBHOOK_URL;
  const token = args.token || process.env.PINGROOM_TOKEN;
  const apiBase = (args.api || DEFAULT_API).replace(/\/$/, '');

  let result;

  if (webhook) {
    const body = { message };
    if (args.title) body.title = args.title;
    if (args.action !== undefined) body.action = Number(args.action);
    if (data) body.data = data;
    result = await postJson(webhook, body);
  } else if (token) {
    if (!args.room) fail('--room is required when using --token', 2);
    const url = `${apiBase}/api/agent/rooms/${encodeURIComponent(args.room)}/notifications`;
    const body = { message };
    if (args.title) body.title = args.title;
    if (args.action !== undefined) body.action_number = Number(args.action);
    if (data) body.data = data;
    result = await postJson(url, body, { Authorization: `Bearer ${token}` });
  } else {
    fail('provide a webhook (--webhook / PINGROOM_WEBHOOK_URL) or an agent token (--token / PINGROOM_TOKEN)', 2);
  }

  const { res, text, json } = result;

  if (args.json) {
    process.stdout.write(`${text || '{}'}\n`);
  }

  const ok = res.ok && !(json && json.success === false);

  if (!ok) {
    const detail = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    fail(`delivery failed: ${detail}`);
  }

  if (!args.json) process.stdout.write('ping sent ✅\n');
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }

  if (command === 'ping') {
    const code = await ping(parseArgs(argv.slice(1)));
    process.exit(code);
  }

  fail(`unknown command: ${command}\nRun "pingroom --help".`, 2);
}

main();
