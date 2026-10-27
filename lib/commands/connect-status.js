// The connected-status receipt, and bare `pingroom`: the status line and help
// when connected, the connect prompt when not.

import { EXIT } from '../constants.js';
import { isInteractive } from '../util.js';
import { HELP } from '../help.js';
import { credentialsPath, readStoredCredential, resolveRoom } from '../config.js';
import { optionalTerminalText, pairingLinks } from './connect-pairing-data.js';
import { connect } from './connect-pairing.js';

/**
 * Durable status for an already-connected robot. Keep the home room separate
 * from reach: an all-room grant still has one delivery/home room.
 */
function connectedLine(cred) {
  const handle = optionalTerminalText(cred.handle);
  const who = handle ? `@${handle.replace(/^@/, '')}` : 'this robot';
  const room = optionalTerminalText(cred.room?.name)
    || optionalTerminalText(cred.room?.invite_code);
  const access = cred.room_access ?? cred.roomAccess;

  if (access === 'all') {
    return `✓ Robot ${who} is connected${room ? ` · home #${room}` : ' · no home room'} · access all rooms`;
  }

  if (!room) return `✓ Robot ${who} is connected · no home room`;

  const extra = Math.max(0, (Array.isArray(cred.rooms) ? cred.rooms.length : 0) - 1);
  return `✓ Robot ${who} is connected · home #${room}${extra > 0 ? ` · access +${extra} more` : ''}`;
}

/** Human-readable connection receipt, including the server's reusable read URL. */
export function connectedOutput(cred) {
  const latestPings = pairingLinks(
    cred?.links,
    cred?.apiBase ?? cred?.api_url,
  )?.latest_pings;
  return `${connectedLine(cred)}${latestPings ? `\n  Latest pings API: ${latestPings}` : ''}`;
}

// --- status / bare invocation ----------------------------------------------

/**
 * `pingroom` with no arguments. Connected -> one status line then the usual
 * help. Not connected -> pair (interactive) or, in a pipe/CI, say so on stderr
 * and still print the help rather than prompting into the void.
 */
export async function bare(args) {
  const envToken = process.env.PINGROOM_TOKEN;
  const stored = readStoredCredential();

  if (envToken) {
    process.stdout.write('Using the agent token from PINGROOM_TOKEN.\n');
    if (stored) process.stdout.write(`(the stored credential in ${credentialsPath()} is ignored while it is set)\n`);
    const room = resolveRoom(args);
    if (room) process.stdout.write(`Default room: ${room}\n`);
    process.stdout.write(`\n${HELP}\n`);
    return EXIT.OK;
  }

  if (stored) {
    process.stdout.write(`${connectedOutput(stored)}\n`);
    const room = resolveRoom(args);
    if (room) process.stdout.write(`Default room: ${room}\n`);
    process.stdout.write(`\n${HELP}\n`);
    return EXIT.OK;
  }

  if (!isInteractive()) {
    process.stderr.write('pingroom: not connected. Set PINGROOM_TOKEN, run "pingroom pair" to pair without a terminal, or run "pingroom" from an interactive terminal.\n');
    process.stdout.write(`${HELP}\n`);
    return EXIT.OK;
  }

  return connect(args);
}
