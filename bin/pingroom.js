#!/usr/bin/env node
// @pingroom/cli — pings and human-in-the-loop questions for CI, scripts, agents.
// Node's built-in fetch (Node >= 20), proper-lockfile for credential recovery,
// and qrcode-terminal for the optional pairing QR rendering.
//
// Run bare (`pingroom`) it resolves its own auth: connected -> a status line and
// this help; not connected -> the pairing picker. There is deliberately no
// `login` subcommand.
//
// Exit codes: 0 success/answered/acked · 1 error · 2 bad usage · 3 expired ·
// 4 cancelled/recipient-not-ready · 5 `bot done` returned more events.
//
// This file is the entry point only: the dispatch table, main(), and the
// top-level catch. Everything it calls lives under lib/ — see lib/help.js for
// the command list and every --help text, lib/parser.js for the flag vocabulary, and lib/commands/*
// for one module per command.

import { EXIT } from '../lib/constants.js';
import { CliExit, fail, stripControlChars } from '../lib/util.js';
import { VERSION } from '../lib/version.js';
import { HELP, HELP_SHORT, HELP_TOPICS } from '../lib/help.js';
import { maybeNotifyUpdate } from '../lib/update-check.js';
import { retryPendingRevocations } from '../lib/credential-recovery.js';
import {
  parseActionsArgs, parseApprovalArgs, parseArgs, parseAttachmentArgs, parseBotArgs, parseCancelArgs,
  parseConfigArgs, parseConnectArgs, parseHandoffArgs, parseHandoffsArgs, parseHookArgs, parseListArgs,
  parseListenArgs, parseLiveArgs, parseLogoutArgs, parsePairArgs, parseQArgs, parseReconnectArgs,
  parseMetricArgs, parseRedeemArgs, parseRoomsArgs, parseRunArgs, parseSkillsArgs, parseUpdateArgs, parseWatchArgs,
  parseWebhooksArgs,
} from '../lib/parser.js';
import { actions, approval, attachment, rooms, webhooks } from '../lib/commands/manage.js';
import { metric } from '../lib/commands/metric.js';
import { bot } from '../lib/commands/bot.js';
import { ping } from '../lib/commands/ping.js';
import { run } from '../lib/commands/run.js';
import { ask, cancel, list, watch } from '../lib/commands/ask.js';
import { handoff, listHandoffs } from '../lib/commands/handoff.js';
import { listen } from '../lib/commands/listen.js';
import { live } from '../lib/commands/live.js';
import { hook } from '../lib/commands/hook.js';
import { mcp } from '../lib/commands/mcp.js';
import { skills } from '../lib/commands/skills.js';
import { update } from '../lib/commands/update.js';
import { redeem } from '../lib/commands/redeem.js';
import { activateStoredInbox, bare, pair, reconnect } from '../lib/commands/connect.js';
import { config, logout } from '../lib/commands/config.js';

const COMMANDS = {
  ping: (rest) => ping(parseArgs(rest)),
  run: (rest) => run(parseRunArgs(rest)),
  ask: (rest) => ask(parseQArgs(rest)),
  watch: (rest) => watch(parseWatchArgs(rest)),
  await: (rest) => watch(parseWatchArgs(rest)),
  cancel: (rest) => cancel(parseCancelArgs(rest)),
  list: (rest) => list(parseListArgs(rest)),
  handoff: (rest) => handoff(parseHandoffArgs(rest)),
  handoffs: (rest) => listHandoffs(parseHandoffsArgs(rest)),
  listen: (rest) => listen(parseListenArgs(rest)),
  bot: (rest) => bot(parseBotArgs(rest)),
  hook: (rest) => hook(parseHookArgs(rest)),
  mcp,
  skills: (rest) => skills(parseSkillsArgs(rest)),
  update: (rest) => update(parseUpdateArgs(rest)),
  upgrade: (rest) => update(parseUpdateArgs(rest)),
  redeem: (rest) => redeem(parseRedeemArgs(rest)),
  activate: (rest) => activateStoredInbox(parseQArgs(rest)),
  live: (rest) => live(parseLiveArgs(rest)),
  rooms: (rest) => rooms(parseRoomsArgs(rest)),
  webhooks: (rest) => webhooks(parseWebhooksArgs(rest)),
  metric: (rest) => metric(parseMetricArgs(rest)),
  actions: (rest) => actions(parseActionsArgs(rest)),
  approval: (rest) => approval(parseApprovalArgs(rest)),
  attachment: (rest) => attachment(parseAttachmentArgs(rest)),
  config: (rest) => config(parseConfigArgs(rest)),
  reconnect: (rest) => reconnect(parseReconnectArgs(rest)),
  pair: (rest) => pair(parsePairArgs(rest)),
  logout: (rest) => logout(parseLogoutArgs(rest)),
};

// Local setup/help commands and latency-sensitive hooks stay offline. Ordinary
// API commands resume previously authorized cleanup using its saved origin.
const RECOVERY_COMMANDS = new Set([
  'ping', 'ask', 'watch', 'await', 'cancel', 'list', 'handoff', 'handoffs',
  'listen', 'redeem', 'activate', 'live', 'rooms', 'webhooks', 'actions', 'metric',
  'approval', 'attachment', 'bot', 'pair', 'reconnect',
]);

// A reader that stops early (`pingroom --help | head`, quitting a pager) closes
// the pipe. That is the reader's choice, not a failure of this tool: leave
// quietly instead of dying on an unhandled EPIPE with a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(EXIT.OK);
    throw error;
  });
}

async function exitAfterOutput(code) {
  // stdout/stderr may be asynchronous pipes. Drain queued output before the
  // explicit exit, which also closes stdin left open by a pairing prompt.
  await Promise.all([process.stdout, process.stderr].map((stream) => (
    new Promise((resolve) => stream.write('', resolve))
  )));
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === '-h' || command === '--help') {
    process.stdout.write(`${HELP_SHORT}\n`);
    return exitAfterOutput(EXIT.OK);
  }

  // `help` alone is --help; `help all` is the whole reference; `help <topic>`
  // and `help <command>` print that one section.
  if (command === 'help') {
    const subject = argv[1];
    if (argv.length > 2) fail('Usage: pingroom help [all | <command> | <topic>]', EXIT.USAGE);
    if (subject === undefined) process.stdout.write(`${HELP_SHORT}\n`);
    else if (subject === 'all') process.stdout.write(`${HELP}\n`);
    else if (Object.hasOwn(HELP_TOPICS, subject)) process.stdout.write(`${HELP_TOPICS[subject]}\n`);
    else if (Object.hasOwn(COMMANDS, subject)) return exitAfterOutput(await COMMANDS[subject](['--help']));
    else fail(`no help for "${stripControlChars(subject)}". Topics: all, ${Object.keys(HELP_TOPICS).join(', ')}, or a command from "pingroom --help".`, EXIT.USAGE);
    return exitAfterOutput(EXIT.OK);
  }

  if (command === '-v' || command === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return exitAfterOutput(EXIT.OK);
  }

  // Bare `pingroom` resolves the auth state instead of only printing help:
  // connected -> status + help; not connected -> pair (interactive only).
  // A leading flag with no subcommand (`pingroom --api …`) counts as bare — it
  // configures the connect attempt rather than naming a command.
  if (!command || command.startsWith('-')) {
    const args = parseConnectArgs(argv);
    if (!args.help) await retryPendingRevocations();
    const bareCode = await bare(args);
    await maybeNotifyUpdate(VERSION);
    return exitAfterOutput(bareCode);
  }

  // Object.hasOwn, not COMMANDS[command]: a bare lookup walks the prototype
  // chain, so `pingroom constructor` found a handler and died in it.
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!handler) {
    fail(`unknown command: ${command}\nRun "pingroom --help".`, EXIT.USAGE);
  }

  if (RECOVERY_COMMANDS.has(command) && !argv.includes('--help') && !argv.includes('-h')) {
    await retryPendingRevocations();
  }

  const code = await handler(argv.slice(1));
  // After the command's own output, never before, and never in place of it:
  // the notice is advisory and must not lead. It cannot alter `code`.
  if (command !== 'update' && command !== 'upgrade' && command !== 'run') await maybeNotifyUpdate(VERSION);
  return exitAfterOutput(code);
}

// fail() ends a command by throwing CliExit; its message is already on stderr,
// so all that is left is to exit with its code once the output has drained.
// Anything else that escapes a handler is a bug in this tool, not a usage
// error, but the operator still gets one clean line instead of a Node stack
// trace — and the same exit 1 every other failure uses, so scripts branching on
// the code are unaffected. PINGROOM_DEBUG keeps the stack for whoever is fixing
// it.
main().catch(async (error) => {
  if (error instanceof CliExit) {
    // A failing command is when an outdated CLI matters most. The notice goes
    // to stderr after the error and cannot change the exit code.
    if (!['update', 'upgrade', 'run'].includes(process.argv[2])) await maybeNotifyUpdate(VERSION);
    return exitAfterOutput(error.code);
  }
  if (process.env.PINGROOM_DEBUG) {
    process.stderr.write(`${error?.stack ?? error}\n`);
  }
  process.stderr.write(`pingroom: unexpected error: ${stripControlChars(error?.message ?? String(error))}\n`);
  return exitAfterOutput(EXIT.ERROR);
});
