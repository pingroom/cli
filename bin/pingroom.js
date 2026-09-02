#!/usr/bin/env node
// @pingroom/cli — pings and human-in-the-loop questions for CI, scripts, agents.
// Node's built-in fetch (Node >= 20) plus one optional dependency,
// `qrcode-terminal`, used only to draw the pairing QR. Its absence degrades to
// printing the pair URL, so every non-interactive path stays dependency-free.
//
// Run bare (`pingroom`) it resolves its own auth: connected -> a status line and
// this help; not connected -> the pairing picker. There is deliberately no
// `login` subcommand.
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
//   listen   Long-poll for pings arriving in the agent's rooms.
//   live     Drive a live progress card (iOS Live Activity / Android live
//            update) on the room members' lock screen: start / update / end.
//   mcp      Print the canonical remote MCP endpoint and client setup snippets.
//   skills   List the published agent skills, or install them for Claude Code.
//   activate Send one optional test Question with the saved QR-paired credential.
//   config   Read/write ~/.pingroom/config.json (default_room, api_url).
//   logout   Forget the credential in ~/.pingroom/credentials.json.
//
// Exit codes: 0 success/answered/acked · 1 error · 2 bad usage · 3 expired ·
// 4 cancelled/recipient-not-ready.
//
// This file is the entry point only: the dispatch table, main(), and the
// top-level catch. Everything it calls lives under lib/ — see lib/help.js for
// the --help text, lib/parser.js for the flag vocabulary, and lib/commands/*
// for one module per command.

import { EXIT } from '../lib/constants.js';
import { fail, stripControlChars } from '../lib/util.js';
import { VERSION } from '../lib/version.js';
import { HELP } from '../lib/help.js';
import { maybeNotifyUpdate } from '../lib/update-check.js';
import {
  parseArgs, parseConfigArgs, parseHandoffArgs, parseHandoffsArgs, parseHookArgs,
  parseLiveArgs, parseLogoutArgs, parseManageArgs, parsePairArgs, parseQArgs,
  parseReconnectArgs, parseSkillsArgs,
} from '../lib/parser.js';
import { actions, approval, attachment, rooms, webhooks } from '../lib/commands/manage.js';
import { ping } from '../lib/commands/ping.js';
import { ask, cancel, list, watch } from '../lib/commands/ask.js';
import { handoff, listHandoffs } from '../lib/commands/handoff.js';
import { listen } from '../lib/commands/listen.js';
import { live } from '../lib/commands/live.js';
import { hook } from '../lib/commands/hook.js';
import { mcp } from '../lib/commands/mcp.js';
import { skills } from '../lib/commands/skills.js';
import { activateStoredInbox, bare, pair, reconnect } from '../lib/commands/connect.js';
import { config, logout } from '../lib/commands/config.js';

const COMMANDS = {
  ping: (rest) => ping(parseArgs(rest)),
  ask: (rest) => ask(parseQArgs(rest)),
  watch: (rest) => waitFrom(watch, rest),
  await: (rest) => waitFrom(watch, rest),
  cancel: (rest) => cancel(parseQArgs(rest)),
  list: (rest) => list(parseQArgs(rest)),
  handoff: (rest) => handoff(parseHandoffArgs(rest)),
  handoffs: (rest) => listHandoffs(parseHandoffsArgs(rest)),
  listen: (rest) => listen(parseQArgs(rest)),
  hook: (rest) => hook(parseHookArgs(rest)),
  mcp,
  skills: (rest) => skills(parseSkillsArgs(rest)),
  activate: (rest) => activateStoredInbox(parseQArgs(rest)),
  live: (rest) => live(parseLiveArgs(rest)),
  rooms: (rest) => rooms(parseManageArgs(rest)),
  webhooks: (rest) => webhooks(parseManageArgs(rest)),
  actions: (rest) => actions(parseManageArgs(rest)),
  approval: (rest) => approval(parseManageArgs(rest)),
  attachment: (rest) => attachment(parseManageArgs(rest)),
  config: (rest) => config(parseConfigArgs(rest)),
  reconnect: (rest) => reconnect(parseReconnectArgs(rest)),
  pair: (rest) => pair(parsePairArgs(rest)),
  logout: (rest) => logout(parseLogoutArgs(rest)),
};

function waitFrom(handler, rest) {
  return handler(parseQArgs(rest));
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    process.exit(EXIT.OK);
  }

  if (command === '-v' || command === '--version') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(EXIT.OK);
  }

  // Bare `pingroom` resolves the auth state instead of only printing help:
  // connected -> status + help; not connected -> pair (interactive only).
  // A leading flag with no subcommand (`pingroom --api …`) counts as bare — it
  // configures the connect attempt rather than naming a command.
  if (!command || command.startsWith('-')) {
    const bareCode = await bare(parseQArgs(argv));
    await maybeNotifyUpdate(VERSION);
    process.exit(bareCode);
  }

  const handler = COMMANDS[command];
  if (!handler) {
    fail(`unknown command: ${command}\nRun "pingroom --help".`, EXIT.USAGE);
  }

  const code = await handler(argv.slice(1));
  // After the command's own output, never before, and never in place of it:
  // the notice is advisory and must not lead. It cannot alter `code`.
  await maybeNotifyUpdate(VERSION);
  process.exit(code);
}

// Anything that escapes a handler is a bug in this tool, not a usage error, but
// the operator still gets one clean line instead of a Node stack trace — and the
// same exit 1 every other failure uses, so scripts branching on the code are
// unaffected. PINGROOM_DEBUG keeps the stack for whoever is fixing it.
main().catch((error) => {
  if (process.env.PINGROOM_DEBUG) {
    process.stderr.write(`${error?.stack ?? error}\n`);
  }
  fail(`unexpected error: ${stripControlChars(error?.message ?? String(error))}`);
});
