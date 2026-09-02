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
 * Unknown flags always fail as a usage error; bare words collect into `_`.
 */
export function makeParser({ aliases, booleans, repeatable = [], bareDashIsPositional = false }) {
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
      } else if (token.startsWith('-') && !(bareDashIsPositional && token === '-')) {
        fail(`Unknown option: ${token}`, EXIT.USAGE);
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
    '--require-ack': 'require_ack',
    '--urgent': 'urgent',
    '--ack-timeout': 'ack_timeout',
    '--attach': 'attach',
    '--token': 'token',
    '--room': 'room',
    '--expected-room-sha256': 'expected_room_sha256',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['require_ack', 'urgent', 'json', 'help'],
  repeatable: ['attach'],
});

// Parser for the question commands: supports repeatable --option and a trailing
// positional (a question id). Unknown flags fail like the ping parser.
export const parseQArgs = makeParser({
  aliases: {
    '-p': 'prompt', '--prompt': 'prompt',
    '-o': 'option', '--option': 'option',
    '-c': 'context', '--context': 'context',
    '--scope': 'scope',
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
  booleans: ['wait', 'json', 'help', 'once'],
  repeatable: ['option'],
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

// Parser for `live`: a leading subcommand (start|update|end|get) plus the
// live-status flags. Unknown flags fail like the other parsers.
export const parseLiveArgs = makeParser({
  aliases: {
    '-c': 'correlation_id', '--correlation-id': 'correlation_id',
    '-t': 'title', '--title': 'title',
    '-m': 'message', '--message': 'message',
    '--template': 'template',
    '--category': 'category',
    '--progress': 'progress',
    '--step': 'step',
    '--steps': 'steps',
    '--metric': 'metric',
    '--deadline-at': 'deadline_at',
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
  aliases: { '--api': 'api', '-h': 'help', '--help': 'help' },
  booleans: ['help'],
  bareDashIsPositional: true,
});

// pair is reconnect's headless twin and takes no --token for the same reason:
// the credential it writes is the one on disk. --json makes stdout an NDJSON
// stream a daemon can read the approval link out of.
export const parsePairArgs = makeParser({
  aliases: { '--api': 'api', '--json': 'json', '-h': 'help', '--help': 'help' },
  booleans: ['json', 'help'],
  bareDashIsPositional: true,
});

export const parseLogoutArgs = makeParser({
  aliases: { '-h': 'help', '--help': 'help' },
  booleans: ['help'],
  bareDashIsPositional: true,
});

// Parser for the management nouns (rooms / webhooks / actions / approval /
// attachment). One shared vocabulary: each sub-command reads the flags it
// needs and the rest are usage errors at the command layer, same as everywhere.
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

export const parseManageArgs = makeParser({
  aliases: {
    '-n': 'name', '--name': 'name',
    '--description': 'description',
    '--icon': 'icon',
    '--color': 'color',
    '--sound': 'sound',
    '--label': 'label',
    '-t': 'title', '--title': 'title',
    '-m': 'message', '--message': 'message',
    '-p': 'prompt', '--prompt': 'prompt',
    '-c': 'context', '--context': 'context',
    '--ttl': 'ttl',
    '--public': 'public',
    '--handle': 'handle',
    '-a': 'action', '--action': 'action',
    '--cooldown': 'cooldown',
    '--enabled': 'enabled',
    '--require-ack': 'require_ack',
    '--out': 'out',
    '--wait': 'wait',
    '--timeout': 'timeout',
    '--idempotency-key': 'idempotency_key',
    '--token': 'token',
    '--room': 'room',
    '--expected-room-sha256': 'expected_room_sha256',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  },
  booleans: ['public', 'require_ack', 'wait', 'json', 'help'],
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
