import { EXIT } from '../constants.js';
import { fail, isJsonObject, numberOption, stripControlChars } from '../util.js';
import { commandHelp } from '../help.js';
import { apiDetail, httpJson } from '../http.js';
import { agentContext } from '../config.js';

// --- bot -------------------------------------------------------------------
//
// The Grok Bot mailbox. PingRoom keeps the owner's events for a bot connection;
// a woken routine claims them under a lease, acts, acks what it handled, and
// ends with `done`, which hands back anything that arrived mid-run. The routes
// need the connection's own agent credential (scope pingroom:bot:events).

const SUBCOMMANDS = ['claim', 'ack', 'extend', 'done', 'peek'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACK_MAX_IDS = 50;
const CLAIM_MAX_LIMIT = 50;
const REQUEST_TIMEOUT_MS = 30_000;

// A 200 the CLI cannot read must not look like "nothing to do": an empty claim
// ends a routine silently and a done without a flag decides whether it loops.
const SHAPES = {
  claim: (json) => Array.isArray(json?.events),
  ack: (json) => Array.isArray(json?.acked),
  extend: (json) => isJsonObject(json) && 'lease_until' in json,
  done: (json) => json?.done === true || (json?.done === false && Array.isArray(json.events)),
  peek: (json) => Array.isArray(json?.events),
};

function text(value) {
  return stripControlChars(value ?? '?');
}

function ackIds(operands) {
  if (operands.length === 0) fail('bot ack needs at least one event id', EXIT.USAGE);
  const ids = [...new Set(operands.map((id) => {
    if (!UUID.test(id)) fail(`bot ack: "${stripControlChars(id)}" is not an event id (a UUID)`, EXIT.USAGE);
    return id.toLowerCase();
  }))];
  if (ids.length > ACK_MAX_IDS) fail(`bot ack takes at most ${ACK_MAX_IDS} event ids`, EXIT.USAGE);
  return ids;
}

function requestBody(name, args, operands) {
  if (name === 'peek') return undefined;
  if (name === 'ack') return { event_ids: ackIds(operands) };
  const limit = numberOption(args.limit, '--limit', { min: 1, max: CLAIM_MAX_LIMIT, integer: true });
  return limit === undefined ? {} : { limit };
}

function rejected(name, res, json) {
  if (res.status === 404 && json?.code === 'no_bot_connection') {
    fail(`bot ${name} failed: this credential has no PingRoom bot connection. Use the bot key shown when Grok Bot was connected in PingRoom.`);
  }
  // The switch being off answers with Laravel's plain unknown-route 404.
  if (res.status === 404 && typeof json?.code !== 'string') {
    fail(`bot ${name} failed: Grok Bot is not available on this PingRoom server (it is switched off).`);
  }
  fail(`bot ${name} failed: ${apiDetail(res, json)}`);
}

function printLeased(json) {
  const { events } = json;
  if (events.length === 0) return;
  for (const event of events) {
    const stale = event?.stale === true ? ' stale' : '';
    process.stdout.write(`${text(event?.id)} ${text(event?.type)} ${text(event?.trust)} delivery=${text(event?.delivery)}${stale}\n`);
  }
  process.stdout.write(`${events.length} event${events.length === 1 ? '' : 's'} leased until ${text(json.lease_until)}\n`);
}

const PRINT = {
  claim: printLeased,
  ack: (json) => {
    for (const id of json.acked) process.stdout.write(`acked ${text(id)}\n`);
    for (const id of Array.isArray(json.unknown) ? json.unknown : []) process.stdout.write(`unknown ${text(id)}\n`);
  },
  extend: (json) => {
    process.stdout.write(json.lease_until ? `lease until ${text(json.lease_until)}\n` : 'no leased events\n');
  },
  done: (json) => {
    if (json.done) process.stdout.write('done\n');
    else printLeased(json);
  },
  peek: (json) => {
    process.stdout.write(`pending=${text(json.pending)} leased=${text(json.leased)} dead=${text(json.dead)}\n`);
    for (const event of json.events) {
      process.stdout.write(`${text(event?.id)} ${text(event?.type)} ${text(event?.state)} delivery=${text(event?.delivery)}\n`);
    }
  },
};

export async function bot(args) {
  if (args.help) { process.stdout.write(`${commandHelp('bot')}\n`); return EXIT.OK; }
  const name = args._[0];
  if (!SUBCOMMANDS.includes(name)) {
    fail(`usage: pingroom bot <${SUBCOMMANDS.join('|')}>\nRun "pingroom bot --help".`, EXIT.USAGE);
  }
  const operands = args._.slice(1);
  if (name !== 'ack' && operands.length > 0) fail(`bot ${name} takes no arguments`, EXIT.USAGE);
  if (name !== 'claim' && args.limit !== undefined) fail('--limit applies to "bot claim" only', EXIT.USAGE);

  const body = requestBody(name, args, operands);
  const { token, apiBase } = agentContext(args);
  const { res, text: raw, json } = await httpJson(name === 'peek' ? 'GET' : 'POST', `${apiBase}/api/agent/bot/${name}`, {
    headers: { Authorization: `Bearer ${token}` },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) rejected(name, res, json);
  if (!SHAPES[name](json)) fail(`bot ${name} failed: unexpected response from PingRoom`);

  if (args.json) process.stdout.write(`${raw}\n`);
  else PRINT[name](json);
  return name === 'done' && json.done === false ? EXIT.MORE_EVENTS : EXIT.OK;
}
