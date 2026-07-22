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
//   handoff  Hand a decision to a specific human (ack or question) and, with
//            --wait, block until they acknowledge / answer.
//   handoffs List the agent's open handoffs or bounded recent history.
//
// Exit codes: 0 success/answered/acked · 1 error · 2 bad usage · 3 expired ·
// 4 cancelled/recipient-not-ready.

import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

// Kept in lockstep with package.json / package-lock.json / action.yml (a test
// asserts the GitHub Action pins this exact version). `hook --print-config`
// emits an `npx @pingroom/cli@<VERSION>` command, so it must match too.
const VERSION = '0.4.0';

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
  handoff  Hand a decision (ack or question) to a specific human; with --wait,
           block until they acknowledge or answer
  handoffs List the agent's open handoffs or bounded recent history
  hook     Claude Code hook: ping on Stop/Notification, and route tool
           permission prompts to a PingRoom question you answer from your phone

ping options:
  -m, --message <text>   Ping body text (required)
  -t, --title <text>     Ping title (<= 40 chars)
  -a, --action <1-4>     Quick-action slot to attribute the ping to
  -d, --data <json>      Extra JSON data object, e.g. '{"commit":"abc123"}'
      --require-ack      Keep the ping open until an eligible recipient acknowledges it
      --ack-timeout <s>  Ack deadline in seconds (requires --require-ack)
  -w, --webhook <url>    Room webhook URL (or env PINGROOM_WEBHOOK_URL)
      --token <token>    Agent access token (or env PINGROOM_TOKEN)
      --room <code>      Room invite code (used with --token)

ask options (agent token required):
  -p, --prompt <text>    The question a human reads (required)
  -o, --option <v:label[:style]>
                         An answer option (style: primary|danger|default);
                         repeat for 2–4. Omit for Approve/Deny
  -c, --context <text>   Secondary line, e.g. a build number (<= 40 chars)
      --scope <s>        Who answers: 'direct' (default) or 'room'
      --target <uuid>    For --scope direct: a specific room member
      --ttl <seconds>    Expiry; omit for the server default (1h; 30..86400)
      --text-input <ph>  Invite a short typed answer; <ph> is the placeholder
      --text-max <n>     Max typed-answer length (1..60)
      --wait             Block until answered/expired/cancelled
      --timeout <sec>    Per long-poll hold with --wait/watch (0–30, default 25)
  -d, --data <json>      Structured data object echoed back on the answer
      --correlation-id <id>  Opaque id echoed on every read of this question
      --reply-to <id>    Id of the ping this question replies to
      --room <code>      Room invite code (required for ask)

list options:
      --state <s>        pending | answered | expired | cancelled | all

handoff options (agent token required; consent scope pingroom:handoffs:create):
  -m, --message <text>   The prompt a human reads (required)
      --question         Make it a question (else a simple acknowledge). Also
                         implied whenever one or more --option is given.
  -o, --option <v:label> A question option; repeat for 2–4. Requires --question.
      --target <id>      Recipient: 'me' (default) or a specific user uuid
      --expires-in <s>   Expiry in seconds (120..86400, default 900)
      --urgency <u>      'active' (default) or 'passive'
      --idempotency-key <key>  Dedupe key; retries reuse it (Idempotency-Key)
      --correlation-id <id>    Opaque id echoed on every read of this handoff
      --reply-to <id>    Opaque reply-to id echoed back
  -d, --data <json>      Structured data object echoed on the handoff
      --wait             Block until acked / answered / expired / cancelled
      --timeout <sec>    Per long-poll hold with --wait (0–20, server caps 25)
      --github-output <path>  Safely append handoff outputs for GitHub Actions

handoffs options (agent token required; consent scope pingroom:handoffs:create):
      --state <s>        open | all (default open)

hook options (agent token required; reads a Claude Code hook event on stdin):
      --room <code>      Room invite code (or env PINGROOM_ROOM)
      --ttl <seconds>    Approval-question expiry for PreToolUse (default 900)
      --quiet            Suppress the informational stderr lines
      --print-config     Print a ready-to-paste ~/.claude/settings.json block

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

  # Hand a deploy decision to yourself and block on the acknowledgement:
  pingroom handoff --token "$T" -m "Prod deploy 1.4.0 — ack to proceed" --wait

  # A blocking question handed to a specific human; branch in CI on exit code:
  pingroom handoff --token "$T" -m "Ship 1.4.0?" --question \\
    -o deploy:Deploy -o hold:Hold --wait
  # -> exit 0 (answered, any value incl. 'hold'); 3 expired; 4 recipient-not-ready

  pingroom handoffs --token "$T" --state all   # recent history (up to 200/kind)

  # Connect Claude Code to your phone (prints the settings.json to paste):
  pingroom hook --print-config

Security:
  Prefer the env vars (PINGROOM_WEBHOOK_URL / PINGROOM_TOKEN) over passing
  secrets as --webhook / --token flags: argv is visible to other users via the
  process table (ps) and may be captured in shell history. URLs must use https
  (loopback http is allowed for local dev).

Exit codes: 0 on success (answered / acked), 1 on error (network/auth/5xx),
2 on bad usage, 3 when a handoff or question expired, 4 when it was cancelled
or the recipient was not ready (409 recipient_not_ready). A question answered
with ANY value — including a negative one like 'hold' or 'deny' — exits 0: a
human decision is not an infrastructure failure.`;

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
    '--require-ack': 'require_ack',
    '--ack-timeout': 'ack_timeout',
    '--token': 'token',
    '--room': 'room',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  };
  const booleans = new Set(['require_ack', 'json', 'help']);

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
      args[key] = value;
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
    '--reply-to': 'reply_to',
    '--text-input': 'text_input',
    '--text-max': 'text_max',
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

// Parser for `handoff`: --message plus repeatable --option, boolean --question,
// and the handoff-specific flags. Unknown flags fail like the other parsers.
function parseHandoffArgs(argv) {
  const args = { _: [] };
  const alias = {
    '-m': 'message', '--message': 'message',
    '--question': 'question',
    '-o': 'option', '--option': 'option',
    '--target': 'target',
    '--expires-in': 'expires_in',
    '--urgency': 'urgency',
    '--idempotency-key': 'idempotency_key',
    '--correlation-id': 'correlation_id',
    '--reply-to': 'reply_to',
    '-d': 'data', '--data': 'data',
    '--timeout': 'timeout',
    '--github-output': 'github_output',
    '--token': 'token',
    '--api': 'api',
    '--wait': 'wait',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  };
  const booleans = new Set(['question', 'wait', 'json', 'help']);
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

  let ackTimeout;
  if (args.ack_timeout !== undefined) {
    if (!args.require_ack) {
      fail('--ack-timeout requires --require-ack', EXIT.USAGE);
    }
    if (!/^\d+$/.test(String(args.ack_timeout))) {
      fail('--ack-timeout must be an integer number of seconds', EXIT.USAGE);
    }
    ackTimeout = Number(args.ack_timeout);
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
    if (ackTimeout !== undefined && (ackTimeout < 1 || ackTimeout > 86_400)) {
      fail('--ack-timeout must be between 1 and 86400 seconds for a webhook ping', EXIT.USAGE);
    }
    requireSafeUrl('--webhook', webhook);
    const body = { message };
    if (args.title) body.title = args.title;
    if (args.action !== undefined) body.action = Number(args.action);
    if (data) body.data = data;
    if (args.require_ack) body.requires_ack = true;
    if (ackTimeout !== undefined) body.ack_timeout_seconds = ackTimeout;
    result = await httpJson('POST', webhook, { body });
  } else if (token) {
    if (!args.room) fail('--room is required when using --token', EXIT.USAGE);
    if (ackTimeout !== undefined && (ackTimeout < 60 || ackTimeout > 86_400)) {
      fail('--ack-timeout must be between 60 and 86400 seconds for an agent room ping', EXIT.USAGE);
    }
    requireSafeUrl('--api', apiBase);
    const url = `${apiBase}/api/agent/rooms/${encodeURIComponent(args.room)}/notifications`;
    const body = { message };
    if (args.title) body.title = args.title;
    if (args.action !== undefined) body.action_number = Number(args.action);
    if (data) body.data = data;
    if (args.require_ack) body.requires_ack = true;
    if (ackTimeout !== undefined) body.ack_timeout_seconds = ackTimeout;
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
    let label = idx === -1 ? spec : spec.slice(idx + 1);
    if (!value) fail(`--option must be "value", "value:label" or "value:label:style" (got "${spec}")`, EXIT.USAGE);
    // A trailing :primary|:danger|:default segment styles the button; any other
    // trailing segment stays part of the label (labels may contain colons).
    let style;
    const lastColon = label.lastIndexOf(':');
    if (lastColon !== -1) {
      const candidate = label.slice(lastColon + 1);
      if (candidate === 'primary' || candidate === 'danger' || candidate === 'default') {
        style = candidate;
        label = label.slice(0, lastColon);
      }
    }
    return style ? { value, label, style } : { value, label };
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
  if (args.reply_to !== undefined) body.reply_to = args.reply_to;
  if (args.text_input !== undefined || args.text_max !== undefined) {
    const textInput = {};
    if (args.text_input) textInput.placeholder = String(args.text_input).slice(0, 60);
    if (args.text_max !== undefined) {
      const n = Number(args.text_max);
      if (!/^\d+$/.test(String(args.text_max)) || n < 1 || n > 60) {
        fail('--text-max must be an integer between 1 and 60', EXIT.USAGE);
      }
      textInput.max_length = n;
    }
    body.text_input = textInput;
  }
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

async function listHandoffs(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }
  const { token, apiBase } = agentContext(args);
  const state = args.state || 'open';
  if (state !== 'open' && state !== 'all') {
    fail("--state must be 'open' or 'all' for handoffs", EXIT.USAGE);
  }

  const url = `${apiBase}/api/agent/handoffs?state=${encodeURIComponent(state)}`;
  const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = (json && (json.message || json.code)) || `HTTP ${res.status}`;
    fail(`handoffs list failed: ${detail}`);
  }
  if (args.json) { process.stdout.write(`${text}\n`); return EXIT.OK; }

  const handoffs = (json && json.handoffs) || [];
  if (handoffs.length === 0) { process.stdout.write('no handoffs\n'); return EXIT.OK; }
  for (const h of handoffs) {
    const answer = h.answer && (h.answer.value ?? h.answer.text);
    const outcome = answer !== undefined && answer !== null ? ` → ${answer}` : '';
    process.stdout.write(
      `${h.id}  ${String(h.kind || '').padEnd(8)}  ${String(h.state || '').padEnd(9)}  ${h.prompt || ''}${outcome}\n`,
    );
  }
  return EXIT.OK;
}

// --- handoff ---------------------------------------------------------------

// Terminal wire states across both kinds. ack: open→acked|expired.
// question: pending→answered|expired|cancelled. `open`/`pending` are the only
// non-terminal states, so a wait loop against these always terminates.
const HANDOFF_PENDING = new Set(['open', 'pending']);

// Map a terminal handoff state to an exit code. A `question` answered with ANY
// value is a success (0) — a negative human decision ('hold'/'deny') is NOT an
// infra failure. `acked` is likewise 0. `expired` is a distinct 3 so CI can
// branch; `cancelled` shares 4 with recipient_not_ready.
function exitForHandoffState(state) {
  switch (state) {
    case 'acked': return EXIT.OK;
    case 'answered': return EXIT.OK;
    case 'expired': return EXIT.EXPIRED;
    case 'cancelled': return EXIT.CANCELLED;
    default: return EXIT.ERROR;
  }
}

// Print a machine-readable summary of a handoff: id, state, delivery-state, and
// the answer value / acked-by when present, one `key=value` per line to stdout.
function printHandoff(h) {
  const lines = [`id=${h.id ?? ''}`, `state=${h.state ?? ''}`];
  if (h.delivery_state != null) lines.push(`delivery-state=${h.delivery_state}`);
  if (h.correlation_id) lines.push(`correlation-id=${h.correlation_id}`);
  if (h.state === 'answered') {
    const value = h.answer && (h.answer.value ?? h.answer.text) || '';
    lines.push(`answer=${value}`);
  }
  if (h.state === 'acked') {
    // The Handoff API returns a privacy-aware actor object. Only expose its id
    // in the machine-readable CLI/GitHub Action output; a redacted actor yields
    // an empty value instead of the unhelpful "[object Object]" string.
    const ackerId = h.acked_by && typeof h.acked_by === 'object'
      ? h.acked_by.id
      : h.acked_by;
    lines.push(`acked-by=${ackerId ?? ''}`);
    if (h.acked_at) lines.push(`acked-at=${h.acked_at}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Append the composite Action's declared outputs without interpreting stdout.
 * Values use GitHub's multiline protocol with a fresh random delimiter. Output
 * names are a fixed allowlist; untrusted answer text can never create a key.
 */
function writeGitHubHandoffOutputs(path, h) {
  if (typeof path !== 'string' || path.length === 0) {
    fail('--github-output must be a non-empty path', EXIT.USAGE);
  }

  const ackerId = h.acked_by && typeof h.acked_by === 'object'
    ? h.acked_by.id
    : h.acked_by;
  const fields = [
    ['handoff-id', h.id ?? ''],
    ['state', h.state ?? ''],
  ];
  if (h.delivery_state != null) fields.push(['delivery-state', h.delivery_state]);
  if (h.state === 'answered') {
    fields.push(['answer', h.answer && (h.answer.value ?? h.answer.text) || '']);
  }
  if (h.state === 'acked') fields.push(['acknowledged-by', ackerId ?? '']);

  const blocks = fields.map(([name, rawValue]) => {
    const value = String(rawValue ?? '');
    let delimiter;
    do {
      delimiter = `pingroom_${randomBytes(24).toString('hex')}`;
    } while (value.includes(delimiter));
    // Keep the collision check next to serialization: a delimiter must never
    // occur in an untrusted value, even though a 192-bit collision is remote.
    if (value.includes(delimiter)) {
      fail('could not create a safe GitHub output delimiter');
    }
    return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  });

  try {
    appendFileSync(path, blocks.join(''), { encoding: 'utf8' });
  } catch {
    fail('could not write GitHub outputs');
  }
}

// Long-poll GET /handoffs/{id}/wait until the handoff leaves open/pending, then
// print it and return the state's exit code. Reuses the shared bounded hold.
async function waitForHandoff(id, args, { token, apiBase }, initialDeliveryState) {
  let hold = args.timeout !== undefined ? Number(args.timeout) : 20;
  if (!Number.isFinite(hold) || hold < 0) fail('--timeout must be a non-negative integer', EXIT.USAGE);
  hold = Math.min(hold, 25);

  for (;;) {
    const url = `${apiBase}/api/agent/handoffs/${encodeURIComponent(id)}/wait?timeout=${hold}`;
    const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const detail = (json && (json.message || json.code)) || `HTTP ${res.status}`;
      fail(`wait failed: ${detail}`);
    }
    if (json && json.state && !HANDOFF_PENDING.has(json.state)) {
      // Read/wait responses intentionally carry delivery_state=null. Preserve
      // the create response's durable delivery result so --wait callers and
      // the GitHub Action do not lose it at the terminal read boundary.
      const resolved = json.delivery_state == null && initialDeliveryState != null
        ? { ...json, delivery_state: initialDeliveryState }
        : json;
      if (args.github_output !== undefined) writeGitHubHandoffOutputs(args.github_output, resolved);
      if (args.json) process.stdout.write(`${text}\n`);
      else printHandoff(resolved);
      return exitForHandoffState(resolved.state);
    }
    // Still open/pending at the hold timeout — poll again.
  }
}

async function handoff(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }

  const message = args.message;
  if (!message) fail('a --message is required', EXIT.USAGE);

  const { token, apiBase } = agentContext(args);

  const options = buildOptions(args.option);
  // Any --option (or an explicit --question) makes this a question handoff.
  const isQuestion = Boolean(args.question) || Boolean(options);
  if (isQuestion && (!options || options.length < 2)) {
    fail('a question handoff needs at least 2 --option values', EXIT.USAGE);
  }
  if (isQuestion && options && options.length > 4) {
    fail('a question handoff accepts at most 4 --option values', EXIT.USAGE);
  }
  if (!isQuestion && options) {
    fail('--option requires --question', EXIT.USAGE);
  }

  const body = { kind: isQuestion ? 'question' : 'ack', prompt: message };

  const target = args.target || 'me';
  body.audience = { type: 'direct', user_id: target };

  if (options) body.options = options;

  if (args.expires_in !== undefined) {
    if (!/^\d+$/.test(String(args.expires_in))) fail('--expires-in must be an integer number of seconds', EXIT.USAGE);
    const secs = Number(args.expires_in);
    if (secs < 120 || secs > 86_400) fail('--expires-in must be between 120 and 86400 seconds', EXIT.USAGE);
    body.expires_in = secs;
  }
  if (args.urgency !== undefined) {
    if (args.urgency !== 'active' && args.urgency !== 'passive') fail("--urgency must be 'active' or 'passive'", EXIT.USAGE);
    body.urgency = args.urgency;
  }
  if (args.correlation_id !== undefined) body.correlation_id = args.correlation_id;
  if (args.reply_to !== undefined) body.reply_to = args.reply_to;
  if (args.data !== undefined) body.data = parseDataObject(args.data);

  const headers = { Authorization: `Bearer ${token}` };
  // A stable Idempotency-Key lets network retries collapse to one resource; the
  // server returns the same handoff for a matching key+hash (409 on conflict).
  if (args.idempotency_key !== undefined) {
    if (!args.idempotency_key) fail('--idempotency-key must be non-empty', EXIT.USAGE);
    headers['Idempotency-Key'] = args.idempotency_key;
  }

  const url = `${apiBase}/api/agent/handoffs`;
  const { res, text, json } = await httpJson('POST', url, { body, headers });
  if (!res.ok) {
    const code = json && json.code;
    const detail = (json && (json.message || code)) || `HTTP ${res.status}`;
    // A recipient who isn't reachable yet is a distinct, retriable outcome (4),
    // not a generic error — CI may want to wait and retry rather than fail hard.
    if (res.status === 409 && code === 'recipient_not_ready') {
      if (args.json) process.stdout.write(`${text}\n`);
      else process.stderr.write(`pingroom: recipient not ready\n`);
      return EXIT.CANCELLED;
    }
    fail(`handoff failed: ${detail}`);
  }

  if (!args.wait) {
    if (args.github_output !== undefined) writeGitHubHandoffOutputs(args.github_output, json);
    if (args.json) process.stdout.write(`${text}\n`);
    else printHandoff(json);
    return EXIT.OK;
  }

  return waitForHandoff(json.id, args, { token, apiBase }, json.delivery_state);
}

// --- hook (Claude Code integration) ----------------------------------------
//
// A single command wired into several Claude Code hook events. It reads the
// hook's JSON payload on stdin and switches on `hook_event_name`:
//   Stop / SubagentStop / SessionEnd  -> ping the room ("Claude finished")
//   Notification                      -> ping the room (idle / needs-input)
//   PreToolUse                        -> ask a PingRoom question and gate the
//                                        tool call on the phone's Approve/Deny.
//
// Safety: the hook FAILS OPEN. It never blocks the agent and never
// auto-approves. Any missing config / network error / non-answer defers to the
// normal local prompt (PreToolUse -> permissionDecision "ask") and exits 0. It
// must not call fail() (a non-zero exit — 2 especially — would break the run).

function parseHookArgs(argv) {
  const args = { _: [] };
  const alias = {
    '--room': 'room',
    '--ttl': 'ttl',
    '--quiet': 'quiet',
    '--print-config': 'print_config',
    '--token': 'token',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  };
  const booleans = new Set(['quiet', 'print_config', 'json', 'help']);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const key = alias[token];
    if (key && booleans.has(key)) {
      args[key] = true;
    } else if (key) {
      const value = argv[++i];
      if (value === undefined) fail(`option ${token} needs a value`, EXIT.USAGE);
      args[key] = value;
    } else if (token.startsWith('-') && token !== '-') {
      fail(`Unknown option: ${token}`, EXIT.USAGE);
    } else {
      args._.push(token);
    }
  }
  return args;
}

// Read all of stdin as a string. Resolves '' when nothing is piped (TTY), so a
// stray `pingroom hook` in a terminal is a silent no-op rather than a hang.
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function truncate(value, max) {
  const str = String(value ?? '');
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

// A minimal HTTP helper for the hook path that THROWS instead of calling fail(),
// so every failure funnels into a fail-open decision. Mirrors httpJson's header
// handling but leaves control flow to the caller.
async function hookFetch(method, url, { body, token } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }
  if (!res.ok) {
    throw new Error((json && (json.message || json.code)) || `HTTP ${res.status}`);
  }
  return json;
}

// Pull the readable text out of a Claude transcript message's content, which is
// either a plain string or an array of typed blocks.
function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ');
  }
  return '';
}

// Tail a Claude Code transcript (JSONL) and return the last assistant message as
// a single truncated line. Best-effort: any read/parse failure yields ''.
function summarizeTranscript(path) {
  if (!path || typeof path !== 'string') return '';
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { return ''; }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const msg = entry && entry.message;
    if (!msg || msg.role !== 'assistant') continue;
    const text = extractAssistantText(msg.content).replace(/\s+/g, ' ').trim();
    if (text) return truncate(text, 500);
  }
  return '';
}

// A short, single-line description of the tool call for the question prompt.
// Never emits more than a truncated line, and strips whitespace/newlines so an
// untrusted command can't reshape the message.
function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  let raw = '';
  if (typeof input.command === 'string') raw = input.command;          // Bash
  else if (typeof input.file_path === 'string') raw = input.file_path; // Read/Write/Edit
  else if (typeof input.path === 'string') raw = input.path;
  else if (typeof input.url === 'string') raw = input.url;             // WebFetch
  else if (typeof input.pattern === 'string') raw = input.pattern;     // Grep/Glob
  else { try { raw = JSON.stringify(input); } catch { raw = ''; } }
  return truncate(String(raw).replace(/\s+/g, ' ').trim(), 160);
}

function emitPreToolUseDecision(decision, reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  })}\n`);
}

// Long-poll the wait endpoint until the question leaves `pending`. The server
// expires it at its ttl, so this always terminates; a mid-poll throw propagates
// to the caller's fail-open handler.
async function hookWaitForAnswer(id, { token, apiBase }) {
  for (;;) {
    const url = `${apiBase}/api/agent/questions/${encodeURIComponent(id)}/wait?timeout=25`;
    const json = await hookFetch('GET', url, { token });
    if (json && json.state && json.state !== 'pending') return json;
  }
}

async function hookPreToolUse(event, { token, room, apiBase, args }) {
  if (!token || !room) {
    emitPreToolUseDecision('ask', 'PingRoom not configured (set PINGROOM_TOKEN and PINGROOM_ROOM)');
    return EXIT.OK;
  }

  const toolName = event.tool_name || 'a tool';
  const summary = summarizeToolInput(event.tool_input);
  const prompt = truncate(`Run ${toolName}${summary ? `: ${summary}` : ''}?`, 500);

  let ttl = 900;
  if (args.ttl !== undefined && /^\d+$/.test(String(args.ttl))) ttl = Number(args.ttl);

  let questionId;
  let cancelled = false;
  const cancelQuestion = async () => {
    if (!questionId || cancelled) return;
    cancelled = true;
    try {
      await hookFetch('POST', `${apiBase}/api/agent/questions/${encodeURIComponent(questionId)}/cancel`, { body: {}, token });
    } catch { /* best-effort — a leftover question expires on its own ttl */ }
  };
  // If the agent aborts the tool call, withdraw the question so it doesn't linger
  // on the phone. Exit 0 so the abort itself isn't reported as a hook failure.
  const onSignal = () => { cancelQuestion().finally(() => process.exit(EXIT.OK)); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const data = { tool_name: String(toolName) };
    if (event.cwd) data.cwd = String(event.cwd);
    const created = await hookFetch('POST', `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/questions`, {
      token,
      body: {
        prompt,
        context: 'Claude Code',
        options: [
          { value: 'allow', label: 'Approve', style: 'primary' },
          { value: 'deny', label: 'Deny', style: 'danger' },
        ],
        ttl,
        data,
        ...(event.session_id ? { correlation_id: String(event.session_id) } : {}),
      },
    });
    questionId = created && created.id;
    if (!questionId) {
      emitPreToolUseDecision('ask', 'PingRoom did not return a question — deferring to local prompt');
      return EXIT.OK;
    }

    const resolved = await hookWaitForAnswer(questionId, { token, apiBase });
    if (resolved.state === 'answered') {
      const value = resolved.answer && (resolved.answer.value || resolved.answer.text);
      if (value === 'allow') { emitPreToolUseDecision('allow', 'Approved via PingRoom'); return EXIT.OK; }
      if (value === 'deny') { emitPreToolUseDecision('deny', 'Denied via PingRoom'); return EXIT.OK; }
      emitPreToolUseDecision('ask', `PingRoom answer "${value}" — deferring to local prompt`);
      return EXIT.OK;
    }
    emitPreToolUseDecision('ask', `PingRoom question ${resolved.state} — deferring to local prompt`);
    return EXIT.OK;
  } catch (err) {
    emitPreToolUseDecision('ask', `PingRoom unavailable (${err.message}) — deferring to local prompt`);
    return EXIT.OK;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

async function hookNotify(event, name, { token, room, apiBase, args }) {
  if (!token || !room) {
    if (!args.quiet) process.stderr.write('pingroom: hook skipped (set PINGROOM_TOKEN and PINGROOM_ROOM)\n');
    return EXIT.OK;
  }

  let title;
  let message;
  if (name === 'Stop' || name === 'SubagentStop') {
    title = 'Claude finished';
    message = summarizeTranscript(event.transcript_path) || 'Session finished — waiting for you.';
  } else if (name === 'Notification') {
    message = truncate(event.message || 'Claude is waiting for your input.', 500);
    // A PreToolUse hook already turns permission prompts into a question; skip
    // the duplicate "needs your permission" Notification so you aren't paged twice.
    if (/permission/i.test(message)) return EXIT.OK;
    title = 'Claude needs you';
  } else if (name === 'SessionEnd') {
    if (event.reason === 'clear') return EXIT.OK; // /clear isn't worth a ping
    title = 'Session ended';
    message = `Claude Code session ended (${event.reason || 'unknown'}).`;
  } else {
    return EXIT.OK; // unknown event — stay silent rather than send noise
  }

  const data = { event: name };
  if (event.session_id) data.session_id = String(event.session_id);
  if (event.cwd) data.cwd = String(event.cwd);

  try {
    await hookFetch('POST', `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/notifications`, {
      token,
      body: {
        message,
        title,
        data,
        ...(event.session_id ? { correlation_id: String(event.session_id) } : {}),
      },
    });
    if (!args.quiet) process.stderr.write('pingroom: pinged ✅\n');
  } catch (err) {
    // A broken ping must never break the agent — report to stderr and exit 0.
    if (!args.quiet) process.stderr.write(`pingroom: hook ping failed (${err.message})\n`);
  }
  return EXIT.OK;
}

function printHookConfig() {
  const command = `npx --yes @pingroom/cli@${VERSION} hook`;
  const config = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command }] }],
      Notification: [{ hooks: [{ type: 'command', command }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 960 }] }],
    },
  };
  process.stdout.write(
`# PingRoom × Claude Code — merge this into ~/.claude/settings.json
#
# 1. Set your credentials in the environment (e.g. in your shell profile):
#      export PINGROOM_TOKEN="<your agent token>"
#      export PINGROOM_ROOM="<room invite code>"
#
# 2. Merge the "hooks" block below into ~/.claude/settings.json.
#      Stop / Notification  -> ping your phone.
#      PreToolUse (Bash)     -> ask a question you Approve/Deny from the lock
#                               screen before the command runs. Add or change the
#                               matcher to gate other tools.
#
# If PingRoom is unreachable the hook defers to the normal local prompt — it
# never auto-approves and never blocks the agent.

${JSON.stringify(config, null, 2)}
`);
}

async function hook(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }
  if (args.print_config) { printHookConfig(); return EXIT.OK; }

  let event = {};
  const raw = await readStdin();
  if (raw) { try { event = JSON.parse(raw); } catch { event = {}; } }
  const name = event.hook_event_name || '';

  const token = args.token || process.env.PINGROOM_TOKEN;
  const room = args.room || process.env.PINGROOM_ROOM;
  const apiBase = (args.api || DEFAULT_API).replace(/\/$/, '');

  if (name === 'PreToolUse') {
    return hookPreToolUse(event, { token, room, apiBase, args });
  }
  return hookNotify(event, name, { token, room, apiBase, args });
}

const COMMANDS = {
  ping: (rest) => ping(parseArgs(rest)),
  ask: (rest) => ask(parseQArgs(rest)),
  watch: (rest) => waitFrom(watch, rest),
  await: (rest) => waitFrom(watch, rest),
  cancel: (rest) => cancel(parseQArgs(rest)),
  list: (rest) => list(parseQArgs(rest)),
  handoff: (rest) => handoff(parseHandoffArgs(rest)),
  handoffs: (rest) => listHandoffs(parseQArgs(rest)),
  hook: (rest) => hook(parseHookArgs(rest)),
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
