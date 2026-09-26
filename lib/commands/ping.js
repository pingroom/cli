import {
  EXIT,
  PING_TITLE_MAX_LENGTH,
  PUBLIC_PING_MESSAGE_MAX_LENGTH,
} from '../constants.js';
import { buildLocation, fail, parseDataObject, requireLinkUrl, requireMaxLength } from '../util.js';
import { commandHelp } from '../help.js';
import { apiDetail, httpJson, requireSafeUrl, uploadAttachments } from '../http.js';
import { requireStoredCredentialOrigin, resolveApiBase, resolveRoom, resolveToken } from '../config.js';
import { pingWebUrl } from '../ping-link.js';

export async function ping(args) {
  if (args.help) { process.stdout.write(`${commandHelp('ping')}\n`); return EXIT.OK; }

  const message = args.message;
  if (!message) fail('a --message is required', EXIT.USAGE);
  // Room visibility is not encoded in a room code or webhook URL. Validate the
  // public ceiling here; the API applies 120 for private rooms and 160 for public.
  requireMaxLength(message, PUBLIC_PING_MESSAGE_MAX_LENGTH, '--message');
  requireMaxLength(args.title, PING_TITLE_MAX_LENGTH, '--title');

  if (args.action !== undefined && !/^(?:[1-9]|1[0-6])$/.test(String(args.action))) {
    fail('--action must be an integer 1–16', EXIT.USAGE);
  }

  if (args.ack_mode !== undefined) {
    if (!['any', 'all'].includes(args.ack_mode)) fail('--ack-mode must be any or all', EXIT.USAGE);
    if (!args.require_ack) fail('--ack-mode requires --require-ack', EXIT.USAGE);
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

  // Link ping: --url/--button-label fold into the structured data object
  // (server contract: data.url = absolute http(s) <= 2048, data.button_label <= 26).
  if (args.button_label !== undefined && args.url === undefined) {
    fail('--button-label requires --url', EXIT.USAGE);
  }
  if (args.url !== undefined) {
    requireLinkUrl(args.url);
    if (args.button_label !== undefined && args.button_label.length > 26) {
      fail('--button-label must be at most 26 characters', EXIT.USAGE);
    }
    data = { ...(data || {}), url: args.url };
    if (args.button_label !== undefined) data.button_label = args.button_label;
  }

  // Location ping: explicit flags own the reserved data.location object. They
  // replace a raw --data location while leaving every sibling key untouched.
  const location = buildLocation(args);
  if (location !== undefined) {
    data = { ...(data || {}), location };
  }

  const webhook = args.webhook || process.env.PINGROOM_WEBHOOK_URL;
  const token = resolveToken(args);
  const apiBase = resolveApiBase(args);
  const room = resolveRoom(args);

  let result;

  // Attachments exist only on the agent-token path: an incoming webhook has no
  // uploader identity to bind private files to, so the API takes no ids there.
  const attachPaths = args.attach ?? [];
  if (attachPaths.length && (webhook || !token)) {
    fail('--attach requires an agent token (--token / PINGROOM_TOKEN), not a webhook ping', EXIT.USAGE);
  }

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
    if (args.ack_mode !== undefined) body.ack_mode = args.ack_mode;
    if (args.urgent) body.is_urgent = true;
    if (ackTimeout !== undefined) body.ack_timeout_seconds = ackTimeout;
    result = await httpJson('POST', webhook, { body });
  } else if (token) {
    requireStoredCredentialOrigin(args, apiBase);
    if (!room) fail('--room is required when using --token (or set one with "pingroom config set default_room <code>")', EXIT.USAGE);
    if (ackTimeout !== undefined && (ackTimeout < 60 || ackTimeout > 86_400)) {
      fail('--ack-timeout must be between 60 and 86400 seconds for an agent room ping', EXIT.USAGE);
    }
    requireSafeUrl('--api', apiBase);
    const url = `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/notifications`;
    const body = { message };
    if (args.title) body.title = args.title;
    if (args.action !== undefined) body.action_number = Number(args.action);
    if (data) body.data = data;
    if (args.require_ack) body.requires_ack = true;
    if (args.ack_mode !== undefined) body.ack_mode = args.ack_mode;
    if (args.urgent) body.is_urgent = true;
    if (ackTimeout !== undefined) body.ack_timeout_seconds = ackTimeout;
    if (attachPaths.length) {
      body.attachment_ids = await uploadAttachments(attachPaths, apiBase, token);
    }
    result = await httpJson('POST', url, { body, headers: { Authorization: `Bearer ${token}` } });
  } else {
    fail('provide a webhook (--webhook / PINGROOM_WEBHOOK_URL) or an agent token (--token / PINGROOM_TOKEN, or run "pingroom" to connect)', EXIT.USAGE);
  }

  const { res, text, json } = result;

  if (args.json) {
    process.stdout.write(`${text || '{}'}\n`);
  }

  const ok = res.ok && !(json && json.success === false);

  if (!ok) {
    let detail = apiDetail(res, json);
    // The API answers an unknown room code with a generic 404, which read as
    // if the ping or its file were missing rather than the room.
    if (!webhook && res && res.status === 404) {
      detail += `\n  No room with code ${room} is available to this robot. Run "pingroom rooms list" to see the codes it can use.`;
      if (attachPaths.length) detail += ' The uploaded file was not sent and expires on its own.';
    }
    fail(`delivery failed: ${detail}`);
  }

  if (!args.json) {
    process.stdout.write('ping sent ✅\n');
    const webUrl = pingWebUrl(json, webhook || apiBase);
    if (webUrl) process.stdout.write(`View on web: ${webUrl}\n`);
  }
  return EXIT.OK;
}
