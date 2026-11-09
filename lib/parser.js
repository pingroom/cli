// One argv parser per command surface, all built from the same table-driven
// factory. Splitting them out keeps the flag vocabulary in one file.

import { EXIT } from './constants.js';
import { fail } from './util.js';

/**
 * Build an argv parser from a flag table. Every command parser runs the same
 * loop; only the tables differ:
 *   aliases              flag or alias -> canonical args key
 *   booleans             keys that take no value
 *   repeatable           keys collected into an array (the flag may repeat)
 *   bareDashIsPositional whether a lone `-` collects into `_` (the question-
 *                        style parsers) or fails as an unknown option (ping,
 *                        live)
 *   redactUnknownOptions omit unknown input values that may contain secrets
 *   unsupported          flag -> why this command cannot honour it. A flag a
 *                        user would reasonably reach for gets its reason, not
 *                        the bare "Unknown option"
 * Unknown flags always fail as a usage error; bare words collect into `_`.
 */
export function makeParser({
  aliases, booleans, repeatable = [], bareDashIsPositional = false, redactUnknownOptions = false, unsupported = {},
}) {
  const booleanKeys = new Set(booleans);
  const repeatableKeys = new Set(repeatable);
  function parse(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i];
      // Object.hasOwn, not aliases[token]: a bare lookup walks the prototype
      // chain, so `constructor` / `toString` / `__proto__` in flag position
      // resolve to a truthy inherited value, get treated as an option, and
      // swallow the next argument instead of failing as an unknown flag.
      const key = Object.hasOwn(aliases, token) ? aliases[token] : undefined;
      if (key && booleanKeys.has(key)) {
        args[key] = true;
      } else if (key) {
        const value = argv[++i];
        if (value === undefined) {
          fail(`option ${token} needs a value`, EXIT.USAGE);
        }
        if (repeatableKeys.has(key)) (args[key] ||= []).push(value);
        else args[key] = value;
      } else if (Object.hasOwn(unsupported, token)) {
        fail(`${token} is not supported here: ${unsupported[token]}`, EXIT.USAGE);
      } else if (token.startsWith('-') && !(bareDashIsPositional && token === '-')) {
        fail(redactUnknownOptions ? 'Unknown option. Use --help to see accepted flags.' : `Unknown option: ${token}`, EXIT.USAGE);
      } else {
        args._.push(token);
      }
    }
    return args;
  }
  // The accepted flag vocabulary, published on the parser itself. The release
  // gate reads it to assert that every flag `action.yml` hands the CLI is one
  // the matching parser accepts — the check that would have caught `ask
  // --github-output` being wired into the handoff parser only.
  parse.flags = new Set(Object.keys(aliases));
  return parse;
}

export const parseArgs = makeParser({
  aliases: {
    '-m': 'message', '--message': 'message',
    '-t': 'title', '--title': 'title',
    '-a': 'action', '--action': 'action',
    '-d': 'data', '--data': 'data',
    '-w': 'webhook', '--webhook': 'webhook',
    '--url': 'url',
    '--button-label': 'button_label',
    '--location': 'location',
    '--location-label': 'location_label',
    '--location-address': 'location_address',
    '--item': 'item',
    '--require-ack': 'require_ack',
    '--urgent': 'urgent',
    '--ack-timeout': 'ack_timeout',
    '--ack-mode': 'ack_mode',
    '--attach': 'attach',
    '--idempotency-key': 'idempotency_key',
    '--token': 'token',
    '--room': 'room',
    '--expected-room-sha256': 'expected_room_sha256',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['require_ack', 'urgent', 'json', 'help'],
  repeatable: ['attach', 'item'],
});

const parseRunOptions = makeParser({
  aliases: {
    '--name': 'name', '--preview': 'preview', '--notify-timeout': 'notify_timeout',
    '-w': 'webhook', '--webhook': 'webhook', '--token': 'token',
    '--room': 'room', '--api': 'api', '-h': 'help', '--help': 'help',
  },
  booleans: ['preview', 'help'],
  redactUnknownOptions: true,
});

// Only the prefix belongs to PingRoom. Everything after the literal separator
// belongs to the child, including flags such as --help and further separators.
export function parseRunArgs(argv) {
  const separator = argv.indexOf('--');
  const args = parseRunOptions(separator < 0 ? argv : argv.slice(0, separator));
  if (args._.length) fail('run options must come before -- <command> [args...]', EXIT.USAGE);
  if (!args.help && (separator < 0 || !argv[separator + 1])) {
    fail('run requires -- <command> [args...]', EXIT.USAGE);
  }
  args._ = separator < 0 ? [] : argv.slice(separator + 1);
  return args;
}
parseRunArgs.flags = parseRunOptions.flags;

// Parser for the question commands: supports repeatable --option and a trailing
// positional (a question id). Unknown flags fail like the ping parser.
export const parseQArgs = makeParser({
  aliases: {
    '-p': 'prompt', '--prompt': 'prompt',
    '-o': 'option', '--option': 'option',
    '-c': 'context', '--context': 'context',
    '--scope': 'scope',
    '--poll': 'poll',
    '--target': 'target',
    '--ttl': 'ttl',
    '--idempotency-key': 'idempotency_key',
    '-d': 'data', '--data': 'data',
    '--correlation-id': 'correlation_id',
    '--reply-to': 'reply_to',
    '--text-input': 'text_input',
    '--text-max': 'text_max',
    '--timeout': 'timeout',
    '--state': 'state',
    '--limit': 'limit',
    '--from': 'from',
    '--once': 'once',
    '--github-output': 'github_output',
    '--token': 'token',
    '--room': 'room',
    '--expected-room-sha256': 'expected_room_sha256',
    '--api': 'api',
    '--wait': 'wait',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['wait', 'json', 'help', 'once', 'poll'],
  repeatable: ['option'],
  bareDashIsPositional: true,
});

// listen/list/watch/cancel used to share parseQArgs, which silently accepted
// and ignored every ask-only flag. `--room` was the costly one: `listen --room
// OPS` streamed every room the grant covers and exited 0. None of these four
// endpoints takes a room (the API has no room filter on the listen feed or the
// question list, and a question id already names its question), so --room is
// refused with the reason. --expected-room-sha256 stays: agentContext checks it
// against the room resolved from env/config/credential.
const NO_ROOM_FILTER = {
  listen: 'listen hears every room this connection covers; the API has no room filter',
  list: 'list shows this agent\'s questions across all rooms; the API has no room filter',
  watch: 'a question id already names its question',
  cancel: 'a question id already names its question',
};

export const parseListenArgs = makeParser({
  aliases: {
    '--timeout': 'timeout',
    '--limit': 'limit',
    '--from': 'from',
    '--once': 'once',
    '--token': 'token',
    '--expected-room-sha256': 'expected_room_sha256',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['once', 'json', 'help'],
  bareDashIsPositional: true,
  unsupported: { '--room': NO_ROOM_FILTER.listen },
});

export const parseListArgs = makeParser({
  aliases: {
    '--state': 'state',
    '--token': 'token',
    '--expected-room-sha256': 'expected_room_sha256',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['json', 'help'],
  bareDashIsPositional: true,
  unsupported: { '--room': NO_ROOM_FILTER.list },
});

export const parseWatchArgs = makeParser({
  aliases: {
    '--timeout': 'timeout',
    '--github-output': 'github_output',
    '--token': 'token',
    '--expected-room-sha256': 'expected_room_sha256',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['json', 'help'],
  bareDashIsPositional: true,
  unsupported: { '--room': NO_ROOM_FILTER.watch },
});

export const parseCancelArgs = makeParser({
  aliases: {
    '--token': 'token',
    '--expected-room-sha256': 'expected_room_sha256',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['json', 'help'],
  bareDashIsPositional: true,
  unsupported: { '--room': NO_ROOM_FILTER.cancel },
});

// Bare `pingroom` is the interactive connection/status surface. Keep the
// robot-naming flag here instead of leaking it into ask/watch/listen, where a
// table-driven parser would otherwise accept and silently ignore it.
export const parseConnectArgs = makeParser({
  aliases: {
    '--api': 'api', '--room': 'room', '--agent-label': 'agent_label',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['help'],
  bareDashIsPositional: true,
});

// Parser for `handoff`: --message plus repeatable --option, boolean --question,
// and the handoff-specific flags. Unknown flags fail like the other parsers.
export const parseHandoffArgs = makeParser({
  aliases: {
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
  },
  booleans: ['question', 'wait', 'json', 'help'],
  repeatable: ['option'],
  bareDashIsPositional: true,
});

// Parser for `live`: a leading subcommand (start|update|end|get|claim) plus the
// live-status flags. Unknown flags fail like the other parsers.
const parseLiveOptions = makeParser({
  aliases: {
    '-c': 'correlation_id', '--correlation-id': 'correlation_id',
    '-n': 'notification_id', '--notification-id': 'notification_id',
    '-t': 'title', '--title': 'title',
    '-m': 'message', '--message': 'message',
    '--template': 'template',
    '--category': 'category',
    '--progress': 'progress',
    '--step': 'step',
    '--steps': 'steps',
    '--metric': 'metric',
    '--deadline-at': 'deadline_at',
    '--duration-seconds': 'duration_seconds',
    '--eta-at': 'eta_at',
    '--prompt': 'prompt',
    '--option': 'option',
    '--left': 'left',
    '--right': 'right',
    '--center': 'center',
    '--accent-override': 'accent_override',
    '--failed': 'failed',
    '-a': 'action', '--action': 'action',
    '-d': 'data', '--data': 'data',
    '--require-ack': 'require_ack',
    // No --urgent here on purpose. A STREAM starts time-sensitive via
    // `--category alert` (fixed at creation); the live-status endpoint does not
    // accept `is_urgent`, so the flag would parse and then be silently dropped.
    '--ack-timeout': 'ack_timeout',
    '-w': 'webhook', '--webhook': 'webhook',
    '--token': 'token',
    '--room': 'room',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['require_ack', 'json', 'help', 'failed'],
  repeatable: ['metric', 'option'],
});

const LIVE_CLAIM_KEYS = new Set(['_', 'notification_id', 'token', 'room', 'api', 'json', 'help', 'webhook']);
export function parseLiveArgs(argv) {
  const args = parseLiveOptions(argv);
  if (args.help) return args;
  if (args._[0] === 'claim') {
    for (const key of Object.keys(args)) {
      // Keep --webhook for the command's specific member-identity explanation.
      if (!LIVE_CLAIM_KEYS.has(key)) fail(`--${key.replaceAll('_', '-')} is not supported by live claim`, EXIT.USAGE);
    }
  } else if (['start', 'update', 'end', 'get'].includes(args._[0]) && args.notification_id !== undefined) {
    fail('--notification-id is only supported by live claim', EXIT.USAGE);
  }
  return args;
}
parseLiveArgs.flags = parseLiveOptions.flags;

// The bot mailbox belongs to the bot connection, not a room, so --room is
// refused rather than accepted and ignored.
export const parseBotArgs = makeParser({
  aliases: {
    '--limit': 'limit',
    '--token': 'token',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['json', 'help'],
  unsupported: { '--room': 'the bot mailbox belongs to the bot connection, not a room' },
});

export const parseHookArgs = makeParser({
  aliases: {
    '--room': 'room',
    '--ttl': 'ttl',
    '--quiet': 'quiet',
    '--print-config': 'print_config',
    '--token': 'token',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['quiet', 'print_config', 'json', 'help'],
  bareDashIsPositional: true,
});

// config/logout/handoffs used to share parseQArgs, which silently accepted and
// ignored flags those commands never read (`logout --wait --prompt x`). Minimal
// tables instead, so an irrelevant flag is a usage error like everywhere else.
export const parseConfigArgs = makeParser({
  aliases: { '--json': 'json', '-h': 'help', '--help': 'help' },
  booleans: ['json', 'help'],
  bareDashIsPositional: true,
});

// reconnect re-runs the pairing flow against the stored credential. It takes no
// --token deliberately: the credential it replaces is the one on disk, and an
// env token is refused outright by the command.
export const parseReconnectArgs = makeParser({
  aliases: {
    '--api': 'api', '--agent-label': 'agent_label', '-h': 'help', '--help': 'help',
  },
  booleans: ['help'],
  bareDashIsPositional: true,
});

// pair is reconnect's headless twin and takes no --token for the same reason:
// the credential it writes is the one on disk. --json makes stdout an NDJSON
// stream a daemon can read the approval link out of.
export const parsePairArgs = makeParser({
  aliases: {
    '--api': 'api', '--agent-label': 'agent_label', '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['json', 'help'],
  bareDashIsPositional: true,
});

export const parseLogoutArgs = makeParser({
  aliases: { '-h': 'help', '--help': 'help' },
  booleans: ['help'],
  bareDashIsPositional: true,
});

export const parseRedeemArgs = makeParser({
  aliases: {
    '--code': 'code', '--token': 'token', '--api': 'api', '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['json', 'help'],
  // A malformed code can start with a dash; never repeat it in an error.
  redactUnknownOptions: true,
});

// `skills` takes no credential and touches no API: only where to install and
// whether to replace what is already there. A dedicated vocabulary keeps
// --force from leaking into the parsers whose commands send real pings.
export const parseSkillsArgs = makeParser({
  aliases: {
    '--dir': 'dir',
    '--force': 'force',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['force', 'help'],
});

// The management nouns (rooms / webhooks / actions / approval / attachment) each
// get their own parser, and a sub-command accepts only the flags MANAGE_FLAGS
// lists for it. They used to share one table that accepted everything, so
// `rooms create --password` (a flag only `rooms join` reads) parsed fine and was
// dropped with exit 0. MANAGE_FLAGS names flags by their args key, the right-hand
// side of the alias tables.
const MANAGE_SHARED_ALIASES = {
  '--token': 'token',
  '--api': 'api',
  '--json': 'json',
  '--expected-room-sha256': 'expected_room_sha256',
  '-h': 'help', '--help': 'help',
};
const MANAGE_SHARED_KEYS = new Set(['_', 'help', 'json', 'token', 'api', 'room', 'expected_room_sha256']);

const WEBHOOK_FIELDS = ['name', 'title', 'message', 'icon', 'color', 'sound', 'action', 'cooldown', 'enabled'];

/** noun -> sub-command -> the flag keys that sub-command reads. */
export const MANAGE_FLAGS = {
  rooms: {
    list: [],
    icons: [],
    get: [],
    join: ['password'],
    create: ['name', 'icon', 'color', 'public', 'handle', 'description', 'location', 'location_name'],
  },
  webhooks: {
    list: [],
    delete: [],
    create: WEBHOOK_FIELDS,
    update: WEBHOOK_FIELDS,
  },
  actions: {
    list: [],
    set: ['label', 'icon', 'sound', 'require_ack', 'input_type'],
    'set-all': ['set', 'actions'],
    trigger: [
      'require_ack', 'urgent', 'ack_mode', 'idempotency_key', 'url', 'location', 'location_label',
      'location_address', 'attach', 'quick_action_id',
    ],
    layout: ['page_order'],
  },
  attachment: {
    get: ['out'],
    delete: [],
  },
};

// Appended to the "only supported by" error where the refused flag has a
// differently spelled equivalent elsewhere.
const MANAGE_FLAG_HINTS = {
  input_type: 'use the input_type key in set-all entries',
};

function flagName(key) {
  return `--${key.replaceAll('_', '-')}`;
}

/**
 * Refuse a flag the chosen sub-command never reads. A flag that no sub-command of
 * the noun takes never reaches here (the noun's parser rejects it as unknown), and
 * an unknown sub-command is left for the command to report.
 */
function requireSubcommandFlags(noun, args) {
  const bySubcommand = MANAGE_FLAGS[noun];
  const sub = args._[0];
  if (args.help || !Object.hasOwn(bySubcommand, sub)) return;
  const allowed = new Set(bySubcommand[sub]);
  for (const key of Object.keys(args)) {
    if (MANAGE_SHARED_KEYS.has(key) || allowed.has(key)) continue;
    const owners = Object.keys(bySubcommand).filter((name) => bySubcommand[name].includes(key));
    const hint = MANAGE_FLAG_HINTS[key];
    fail(
      `${flagName(key)} is only supported by ${owners.map((name) => `${noun} ${name}`).join(' or ')}${hint ? ` (${hint})` : ''}`,
      EXIT.USAGE,
    );
  }
}

function manageParser(noun, options) {
  const aliases = { ...options.aliases, ...MANAGE_SHARED_ALIASES };
  const parse = makeParser({ ...options, aliases });
  const parseManage = (argv) => {
    const args = parse(argv);
    requireSubcommandFlags(noun, args);
    return args;
  };
  parseManage.flags = parse.flags;
  // The canonical keys this noun's flags set, so a test can check the alias
  // table and MANAGE_FLAGS describe the same vocabulary.
  parseManage.keys = new Set(Object.values(aliases));
  return parseManage;
}

export const parseRoomsArgs = manageParser('rooms', {
  aliases: {
    '-n': 'name', '--name': 'name',
    '--icon': 'icon',
    '--color': 'color',
    '--public': 'public',
    '--handle': 'handle',
    '--description': 'description',
    '--password': 'password',
    '--location': 'location',
    '--location-name': 'location_name',
  },
  booleans: ['public', 'json', 'help'],
  unsupported: { '--room': 'a room is named by its invite code argument (rooms get <code>, rooms join <code>)' },
});

export const parseWebhooksArgs = manageParser('webhooks', {
  aliases: {
    '-n': 'name', '--name': 'name',
    '-t': 'title', '--title': 'title',
    '-m': 'message', '--message': 'message',
    '--icon': 'icon',
    '--color': 'color',
    '--sound': 'sound',
    '-a': 'action', '--action': 'action',
    '--cooldown': 'cooldown',
    '--enabled': 'enabled',
    '--room': 'room',
  },
  booleans: ['json', 'help'],
});

export const parseActionsArgs = manageParser('actions', {
  aliases: {
    '--label': 'label',
    '--icon': 'icon',
    '--sound': 'sound',
    '--require-ack': 'require_ack',
    // `actions set`: the detail every press must carry (none|location|link|file|photo|pdf).
    '--input-type': 'input_type',
    // `actions set-all`: one JSON object per slot, repeated. Repeatable rather
    // than a single JSON array so a shell caller can build the batch from a
    // loop without string-concatenating JSON.
    '--set': 'set',
    '--actions': 'actions',
    // `actions trigger`: the modifiers and the detail a press carries, same
    // spellings as `ping`.
    '--urgent': 'urgent',
    '--ack-mode': 'ack_mode',
    '--idempotency-key': 'idempotency_key',
    '--url': 'url',
    '--location': 'location',
    '--location-label': 'location_label',
    '--location-address': 'location_address',
    '--attach': 'attach',
    '--quick-action-id': 'quick_action_id',
    // `actions layout`: new page positions as original page numbers or "new".
    '--page-order': 'page_order',
    '--room': 'room',
  },
  booleans: ['require_ack', 'urgent', 'json', 'help'],
  repeatable: ['set', 'attach'],
});

export const parseApprovalArgs = makeParser({
  aliases: {
    '-p': 'prompt', '--prompt': 'prompt',
    '-c': 'context', '--context': 'context',
    '--ttl': 'ttl',
    '--idempotency-key': 'idempotency_key',
    '--wait': 'wait',
    '--timeout': 'timeout',
    ...MANAGE_SHARED_ALIASES,
    '--room': 'room',
  },
  booleans: ['wait', 'json', 'help'],
});

export const parseAttachmentArgs = manageParser('attachment', {
  aliases: {
    '--out': 'out',
  },
  booleans: ['json', 'help'],
  unsupported: { '--room': 'an attachment id already names its attachment' },
});

export const parseHandoffsArgs = makeParser({
  aliases: {
    '--state': 'state',
    '--token': 'token',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['json', 'help'],
  bareDashIsPositional: true,
});

export const parseUpdateArgs = makeParser({
  aliases: { "--check": "check", "--json": "json", "-h": "help", "--help": "help" },
  booleans: ["check", "json", "help"],
});
