#!/usr/bin/env node
// @pingroom/cli — pings and human-in-the-loop questions for CI, scripts, agents.
// Zero dependencies: uses Node's built-in fetch (Node >= 20).
//
// Commands:
//   ping     Send a ping to a room. Webhook mode (a room URL carries its own
//            secret — best for CI) or agent-token mode (Bearer + room code).
//   ask      Ask a human a question in a room and, with --wait, block until they
//            tap an answer — turning a human decision into a shell gate.
//   watch    Block until a question resolves and print the outcome.
//   list     List the agent's questions by state.
//   cancel   Withdraw a pending question.
//
// Exit codes: 0 success/answered · 1 error · 2 bad usage · 3 expired · 4 cancelled.

const DEFAULT_API = process.env.PINGROOM_API_URL || 'https://api.pingroom.io';

const HELP = `pingroom — send a ping, or ask a human a question, from CI/scripts/agents

Usage:
  pingroom <command> [options]

Commands:
  ping     Send a ping to a room (webhook URL, or agent token + room)
  ask      Ask a human a question; with --wait, block until they answer
  watch    Block until a question resolves and print the outcome
  list     List the agent's questions by state
  cancel   Withdraw a pending question

ping options:
  -m, --message <text>   Ping body text (required)
  -t, --title <text>     Ping title (<= 40 chars)
  -a, --action <1-4>     Quick-action slot to attribute the ping to
  -d, --data <json>      Extra JSON data object, e.g. '{"commit":"abc123"}'
  -w, --webhook <url>    Room webhook URL (or env PINGROOM_WEBHOOK_URL)
      --token <token>    Agent access token (or env PINGROOM_TOKEN)
      --room <code>      Room invite code (used with --token)

ask options (agent token required):
  -p, --prompt <text>    The question a human reads (required)
  -o, --option <v:label> An answer option; repeat for 2–4. Omit for Approve/Deny
  -c, --context <text>   Secondary line, e.g. a build number (<= 40 chars)
      --scope <s>        Who answers: 'direct' (default) or 'room'
      --target <uuid>    For --scope direct: a specific room member
      --ttl <seconds>    Expiry; omit for the server default (1h; 30..86400)
      --wait             Block until answered/expired/cancelled
      --timeout <sec>    Per long-poll hold with --wait/watch (0–30, default 25)
  -d, --data <json>      Structured data object echoed back on the answer
      --correlation-id <id>  Opaque id echoed on every read of this question
      --room <code>      Room invite code (required for ask)

list options:
      --state <s>        pending | answered | expired | cancelled | all

Shared:
      --token <token>    Agent access token (or env PINGROOM_TOKEN)
      --api <url>        API base URL (default ${DEFAULT_API}; env PINGROOM_API_URL)
      --json             Print the raw JSON response
  -h, --help             Show this help

Examples:
  pingroom ping -w "$PINGROOM_WEBHOOK_URL" -m "Deploy succeeded ✅"
  pingroom ping --token "$PINGROOM_TOKEN" --room ab12cd -m "Release shipped"

  # Gate a deploy on a human tap — the chosen value prints to stdout:
  if [ "$(pingroom ask --token "$T" --room ab12cd --wait \\
        -p 'Deploy 1.4.0 to production?')" = approve ]; then ./deploy.sh; fi

  # Multi-option question, blocking:
  pingroom ask --token "$T" --room ab12cd --scope room --wait \\
    -p 'Which environment?' -o prod:Production -o staging:Staging

  pingroom list --token "$T" --state pending
  pingroom watch --token "$T" q_01H...   # block on an existing question
  pingroom cancel --token "$T" q_01H...

Security:
  Prefer the env vars (PINGROOM_WEBHOOK_URL / PINGROOM_TOKEN) over passing
  secrets as --webhook / --token flags: argv is visible to other users via the
  process table (ps) and may be captured in shell history. URLs must use https
  (loopback http is allowed for local dev).

Exit codes: 0 on success (answered), 1 on error, 2 on bad usage,
3 when a question expired, 4 when it was cancelled.`;

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, EXPIRED: 3, CANCELLED: 4 };

function fail(message, code = EXIT.ERROR) {
  process.stderr.write(`pingroom: ${message}\n`);
  process.exit(code);
}

// --- ping (unchanged wire behaviour) ---------------------------------------

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
      fail(`Unknown option: ${token}`, EXIT.USAGE);
    } else {
      args._.push(token);
    }
  }
  return args;
}

// Parser for the question commands: supports repeatable --option and a trailing
// positional (a question id). Unknown flags fail like the ping parser.
function parseQArgs(argv) {
  const args = { _: [] };
  const alias = {
    '-p': 'prompt', '--prompt': 'prompt',
    '-o': 'option', '--option': 'option',
    '-c': 'context', '--context': 'context',
    '--scope': 'scope',
    '--target': 'target',
    '--ttl': 'ttl',
    '-d': 'data', '--data': 'data',
    '--correlation-id': 'correlation_id',
    '--timeout': 'timeout',
    '--state': 'state',
    '--token': 'token',
    '--room': 'room',
    '--api': 'api',
    '--wait': 'wait',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  };
  const booleans = new Set(['wait', 'json', 'help']);
  const multi = new Set(['option']);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const key = alias[token];
    if (key && booleans.has(key)) {
      args[key] = true;
    } else if (key) {
      const value = argv[++i];
      if (value === undefined) {
        fail(`option ${token} needs a value`, EXIT.USAGE);
      }
      if (multi.has(key)) {
        (args[key] ||= []).push(value);
      } else {
        args[key] = value;
      }
    } else if (token.startsWith('-') && token !== '-') {
      fail(`Unknown option: ${token}`, EXIT.USAGE);
    } else {
      args._.push(token);
    }
  }
  return args;
}

// Refuse to send a bearer token or webhook secret over cleartext http. A
// loopback host is allowed so local dev against http://localhost still works.
function requireSafeUrl(kind, raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail(`${kind} is not a valid URL`, EXIT.USAGE);
  }
  const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback)) {
    fail(`${kind} must use https (refusing to send credentials over cleartext)`, EXIT.USAGE);
  }
  return raw;
}

function parseDataObject(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail('--data must be valid JSON', EXIT.USAGE);
  }
  if (typeof data !== 'object' || Array.isArray(data) || data === null) {
    fail('--data must be a JSON object', EXIT.USAGE);
  }
  return data;
}

async function httpJson(method, url, { body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }

  const message = args.message;
  if (!message) fail('a --message is required', EXIT.USAGE);

  if (args.action !== undefined && !/^[1-4]$/.test(String(args.action))) {
    fail('--action must be an integer 1–4', EXIT.USAGE);
  }

  let data;
  if (args.data !== undefined) {
    data = parseDataObject(args.data);
  }

  const webhook = args.webhook || process.env.PINGROOM_WEBHOOK_URL;
  const token = args.token || process.env.PINGROOM_TOKEN;
  const apiBase = (args.api || DEFAULT_API).replace(/\/$/, '');

  let result;

  if (webhook) {
    requireSafeUrl('--webhook', webhook);
    const body = { message };
    if (args.title) body.title = args.title;
    if (args.action !== undefined) body.action = Number(args.action);
    if (data) body.data = data;
    result = await httpJson('POST', webhook, { body });
  } else if (token) {
    if (!args.room) fail('--room is required when using --token', EXIT.USAGE);
    requireSafeUrl('--api', apiBase);
    const url = `${apiBase}/api/agent/rooms/${encodeURIComponent(args.room)}/notifications`;
    const body = { message };
    if (args.title) body.title = args.title;
    if (args.action !== undefined) body.action_number = Number(args.action);
    if (data) body.data = data;
    result = await httpJson('POST', url, { body, headers: { Authorization: `Bearer ${token}` } });
  } else {
    fail('provide a webhook (--webhook / PINGROOM_WEBHOOK_URL) or an agent token (--token / PINGROOM_TOKEN)', EXIT.USAGE);
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
  return EXIT.OK;
}

// --- questions -------------------------------------------------------------

function agentContext(args, { needRoom = false } = {}) {
  const token = args.token || process.env.PINGROOM_TOKEN;
  if (!token) fail('an agent token is required (--token or PINGROOM_TOKEN)', EXIT.USAGE);
  const apiBase = (args.api || DEFAULT_API).replace(/\/$/, '');
  requireSafeUrl('--api', apiBase);
  if (needRoom && !args.room) fail('--room is required', EXIT.USAGE);
  return { token, apiBase, room: args.room };
}

// value:label -> {value, label}. Labels may contain colons (only the first
// splits). A bare token is both value and label. Omit all for Approve/Deny.
function buildOptions(list) {
  if (!list || list.length === 0) return undefined;
  return list.map((spec) => {
    const idx = spec.indexOf(':');
    const value = idx === -1 ? spec : spec.slice(0, idx);
    const label = idx === -1 ? spec : spec.slice(idx + 1);
    if (!value) fail(`--option must be "value" or "value:label" (got "${spec}")`, EXIT.USAGE);
    return { value, label };
  });
}

function exitForState(state) {
  switch (state) {
    case 'answered': return EXIT.OK;
    case 'expired': return EXIT.EXPIRED;
    case 'cancelled': return EXIT.CANCELLED;
    default: return EXIT.ERROR;
  }
}

// Print the outcome. On `answered`, the chosen value (or typed text) goes to
// stdout so `$(pingroom ask --wait ...)` captures it; other outcomes report to
// stderr and leave stdout empty.
function printResolution(q) {
  if (q.state === 'answered') {
    const out = q.answer && (q.answer.text || q.answer.value) || '';
    process.stdout.write(`${out}\n`);
  } else {
    process.stderr.write(`pingroom: question ${q.state}\n`);
  }
}

// Long-poll the wait endpoint until the question leaves `pending`, then print
// and return the state's exit code. The server expires it at its ttl, so this
// always terminates.
async function waitForResolution(id, args, { token, apiBase }) {
  let hold = args.timeout !== undefined ? Number(args.timeout) : 25;
  if (!Number.isFinite(hold) || hold < 0) fail('--timeout must be a non-negative integer', EXIT.USAGE);
  hold = Math.min(hold, 30);

  for (;;) {
    const url = `${apiBase}/api/agent/questions/${encodeURIComponent(id)}/wait?timeout=${hold}`;
    const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const detail = (json && (json.message || json.code)) || `HTTP ${res.status}`;
      fail(`wait failed: ${detail}`);
    }
    if (json && json.state && json.state !== 'pending') {
      if (args.json) process.stdout.write(`${text}\n`);
      else printResolution(json);
      return exitForState(json.state);
    }
    // Still pending at the hold timeout — poll again.
  }
}

async function ask(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }

  const prompt = args.prompt;
  if (!prompt) fail('a --prompt is required', EXIT.USAGE);

  const { token, apiBase, room } = agentContext(args, { needRoom: true });

  const body = { prompt };
  const options = buildOptions(args.option);
  if (options) body.options = options;
  if (args.context) body.context = args.context;
  if (args.scope !== undefined) {
    if (args.scope !== 'direct' && args.scope !== 'room') fail("--scope must be 'direct' or 'room'", EXIT.USAGE);
    body.responder_scope = args.scope;
  }
  if (args.target !== undefined) body.target_user_id = args.target;
  if (args.ttl !== undefined) {
    if (!/^\d+$/.test(String(args.ttl))) fail('--ttl must be an integer number of seconds', EXIT.USAGE);
    body.ttl = Number(args.ttl);
  }
  if (args.correlation_id !== undefined) body.correlation_id = args.correlation_id;
  if (args.data !== undefined) body.data = parseDataObject(args.data);

  const url = `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/questions`;
  const { res, text, json } = await httpJson('POST', url, { body, headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = (json && (json.message || json.code)) || `HTTP ${res.status}`;
    fail(`ask failed: ${detail}`);
  }

  if (!args.wait) {
    if (args.json) process.stdout.write(`${text}\n`);
    else process.stdout.write(`${json.id}\n`);
    return EXIT.OK;
  }

  return waitForResolution(json.id, args, { token, apiBase });
}

async function watch(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }
  const id = args._[0];
  if (!id) fail('a question id is required (pingroom watch <id>)', EXIT.USAGE);
  const { token, apiBase } = agentContext(args);
  return waitForResolution(id, args, { token, apiBase });
}

async function cancel(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }
  const id = args._[0];
  if (!id) fail('a question id is required (pingroom cancel <id>)', EXIT.USAGE);
  const { token, apiBase } = agentContext(args);
  const url = `${apiBase}/api/agent/questions/${encodeURIComponent(id)}/cancel`;
  const { res, text, json } = await httpJson('POST', url, { body: {}, headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = (json && (json.message || json.code)) || `HTTP ${res.status}`;
    fail(`cancel failed: ${detail}`);
  }
  if (args.json) process.stdout.write(`${text}\n`);
  else process.stdout.write(`cancelled (${json && json.state})\n`);
  return EXIT.OK;
}

async function list(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }
  const { token, apiBase } = agentContext(args);
  const qs = args.state ? `?state=${encodeURIComponent(args.state)}` : '';
  const url = `${apiBase}/api/agent/questions${qs}`;
  const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = (json && (json.message || json.code)) || `HTTP ${res.status}`;
    fail(`list failed: ${detail}`);
  }
  if (args.json) { process.stdout.write(`${text}\n`); return EXIT.OK; }

  const questions = (json && json.questions) || [];
  if (questions.length === 0) { process.stdout.write('no questions\n'); return EXIT.OK; }
  for (const q of questions) {
    const answer = q.answer && q.answer.value ? ` → ${q.answer.value}` : '';
    process.stdout.write(`${q.id}  ${String(q.state).padEnd(9)}  ${q.prompt}${answer}\n`);
  }
  return EXIT.OK;
}

const COMMANDS = {
  ping: (rest) => ping(parseArgs(rest)),
  ask: (rest) => ask(parseQArgs(rest)),
  watch: (rest) => waitFrom(watch, rest),
  await: (rest) => waitFrom(watch, rest),
  cancel: (rest) => cancel(parseQArgs(rest)),
  list: (rest) => list(parseQArgs(rest)),
};

function waitFrom(handler, rest) {
  return handler(parseQArgs(rest));
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    process.exit(EXIT.OK);
  }

  const handler = COMMANDS[command];
  if (!handler) {
    fail(`unknown command: ${command}\nRun "pingroom --help".`, EXIT.USAGE);
  }

  const code = await handler(argv.slice(1));
  process.exit(code);
}

main();
