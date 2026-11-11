// Room metrics: named values a script keeps in a room for a widget to show.
// Setting one sends no Ping and no push.
//
//   pingroom metric list <room>
//   pingroom metric set <room> <key> <value> [--label <t>] [--format <f>] [--unit <u>]
//   pingroom metric set --webhook-url <url> <key> <value> [--label …]
//   pingroom metric delete <room> <key>
//
// An agent token drives all three (the agent's human must own or administer the
// room to write). `set` can also go through a room's incoming webhook, whose URL
// already names the room and carries its own secret, so it needs no account
// credential and no room argument: the CLI posts a top-level `metric` object.

import { EXIT } from '../constants.js';
import { agentContext, normalizeRoomCode } from '../config.js';
import { apiDetail, httpJson, requireSafeUrl } from '../http.js';
import { commandHelp } from '../help.js';
import { buildMetricWrite, requireMetricKey } from '../metric-rules.js';
import { fail, isJsonObject, pathSegment, stripControlChars } from '../util.js';

const ACTIONS = ['list', 'set', 'delete'];

function requireOk({ res, json }, what) {
  if (!res.ok || json?.success === false) fail(`${what} failed: ${apiDetail(res, json)}`);
}

/** One metric as a compact human line. Every field is server text, so it is stripped of terminal controls. */
function metricLine(metric) {
  const value = metric.value === null || metric.value === undefined ? '(no value)' : String(metric.value);
  const unit = metric.unit ? ` ${metric.unit}` : '';
  const updated = metric.value_updated_at ? `  (updated ${metric.value_updated_at})` : '';
  return stripControlChars(`${metric.key}  ${metric.label}  ${value}${unit}${updated}`);
}

function requireMetric(json, key, what) {
  const metric = json?.metric ?? json;
  if (!isJsonObject(metric) || typeof metric.key !== 'string' || metric.key !== key) {
    fail(`${what} returned an invalid receipt; the metric may have been written. Run "pingroom metric list <room>" before retrying.`);
  }
  return metric;
}

async function set(args) {
  const webhook = args.webhook;

  if (webhook !== undefined) {
    // A webhook URL already names its room and carries its own credential, so an
    // account token or API base would have nothing to do (and a room argument
    // would be a second, conflicting answer to "which room").
    if (args.token !== undefined || args.api !== undefined) {
      fail('--webhook-url cannot be combined with --token or --api: a webhook URL already names its room and carries its own secret. Pick one transport', EXIT.USAGE);
    }
    if (args._.length !== 3) fail('usage: pingroom metric set --webhook-url <url> <key> <value> [--label <t>] [--format <f>] [--unit <u>]', EXIT.USAGE);
    const { key, body } = buildMetricWrite({ key: args._[1], value: args._[2], label: args.label, format: args.format, unit: args.unit });
    requireSafeUrl('--webhook-url', webhook);
    const result = await httpJson('POST', webhook, { body: { metric: { key, ...body } } });
    if (args.json) process.stdout.write(`${result.text || '{}'}\n`);
    requireOk(result, 'metric set');
    const metric = requireMetric(result.json, key, 'metric set');
    if (!args.json) {
      process.stdout.write(`${metricLine(metric)} ✅${result.json.unchanged ? ' (unchanged)' : ''}\n`);
    }
    return EXIT.OK;
  }

  if (args._.length !== 4) fail('usage: pingroom metric set <room> <key> <value> [--label <t>] [--format <f>] [--unit <u>]\n       pingroom metric set --webhook-url <url> <key> <value> ...', EXIT.USAGE);
  const room = normalizeRoomCode(args._[1]);
  if (!room) fail('usage: pingroom metric set <room> <key> <value>', EXIT.USAGE);
  const { key, body } = buildMetricWrite({ key: args._[2], value: args._[3], label: args.label, format: args.format, unit: args.unit });
  const { token, apiBase } = agentContext({ ...args, room });
  const result = await httpJson('PUT', `${apiBase}/api/agent/rooms/${pathSegment(room, 'room')}/metrics/${pathSegment(key, 'key')}`, {
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  if (args.json) process.stdout.write(`${result.text || '{}'}\n`);
  requireOk(result, 'metric set');
  const metric = requireMetric(result.json, key, 'metric set');
  if (!args.json) process.stdout.write(`${metricLine(metric)} ✅${result.res.status === 201 ? ' (created)' : ''}\n`);
  return EXIT.OK;
}

export async function metric(args) {
  if (args.help) { process.stdout.write(`${commandHelp('metric')}\n`); return EXIT.OK; }
  const action = args._[0];
  if (!action || !ACTIONS.includes(action)) {
    fail(`usage: pingroom metric <${ACTIONS.join('|')}>\nRun "pingroom metric --help".`, EXIT.USAGE);
  }

  if (action === 'set') return set(args);

  const room = normalizeRoomCode(args._[1]);
  if (!room) fail(`usage: pingroom metric ${action} <room>${action === 'delete' ? ' <key>' : ''}`, EXIT.USAGE);
  const expected = action === 'delete' ? 3 : 2;
  if (args._.length !== expected) fail(`usage: pingroom metric ${action} <room>${action === 'delete' ? ' <key>' : ''}`, EXIT.USAGE);
  const key = action === 'delete' ? requireMetricKey(args._[2]) : undefined;

  const { token, apiBase } = agentContext({ ...args, room });
  const base = `${apiBase}/api/agent/rooms/${pathSegment(room, 'room')}/metrics`;
  const headers = { Authorization: `Bearer ${token}` };

  if (action === 'list') {
    const result = await httpJson('GET', base, { headers });
    if (args.json) process.stdout.write(`${result.text || '{}'}\n`);
    requireOk(result, 'metric list');
    if (!args.json) {
      const metrics = Array.isArray(result.json?.metrics) ? result.json.metrics : [];
      process.stdout.write(`${metrics.map(metricLine).join('\n') || '(no metrics)'}\n`);
    }
    return EXIT.OK;
  }

  const result = await httpJson('DELETE', `${base}/${pathSegment(key, 'key')}`, { headers });
  if (args.json) process.stdout.write(`${result.text || '{}'}\n`);
  requireOk(result, 'metric delete');
  if (!args.json) process.stdout.write('deleted\n');
  return EXIT.OK;
}
