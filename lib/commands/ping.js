import {
  EXIT,
  PING_TITLE_MAX_LENGTH,
  PUBLIC_PING_MESSAGE_MAX_LENGTH,
} from '../constants.js';
import { applyIdempotencyKey, buildChecklist, buildLocation, buildTags, fail, parseActionSlot, parseDataObject, pathSegment, requireDataWithinServerCap, requireLinkUrl, requireMaxLength, requireReplaceKey } from '../util.js';
import { commandHelp } from '../help.js';
import { apiDetail, httpJson, noRoomWithCodeHint, requireSafeUrl, uploadAttachments } from '../http.js';
import { noTransportError, requireStoredCredentialOrigin, resolveApiBase, resolveRoom, resolveToken, resolveWebhook } from '../config.js';
import { pingWebUrl } from '../ping-link.js';
import { buildPingActions, hasPingActions, refusePingActionsInData, requirePingActions } from '../ping-actions.js';

// What `--replace` cannot change, by args key: refused with the flag's name.
const REPLACE_UNSUPPORTED = [
  ['action', '--action'],
  ['require_ack', '--require-ack'],
  ['ack_mode', '--ack-mode'],
  ['ack_timeout', '--ack-timeout'],
  ['urgent', '--urgent'],
  ['attach', '--attach'],
  ['tag', '--tag'],
  ['item', '--item'],
  // A replacement never adds, changes or removes buttons.
  ['action_url', '--action-url'],
  ['action_webhook', '--action-webhook'],
  ['action_body', '--action-body'],
  ['idempotency_key', '--idempotency-key'],
];

// Everything `--withdraw` cannot be combined with, by args key: taking a ping
// back sends nothing, so any of these would be silently dropped. Refused with
// the flag's name instead.
const WITHDRAW_EXCLUSIVE = [
  ['message', '--message'],
  ['title', '--title'],
  ['action', '--action'],
  ['data', '--data'],
  ['url', '--url'],
  ['button_label', '--button-label'],
  ['location', '--location'],
  ['location_label', '--location-label'],
  ['location_address', '--location-address'],
  ['item', '--item'],
  ['action_url', '--action-url'],
  ['action_webhook', '--action-webhook'],
  ['action_body', '--action-body'],
  ['require_ack', '--require-ack'],
  ['ack_mode', '--ack-mode'],
  ['ack_timeout', '--ack-timeout'],
  ['urgent', '--urgent'],
  ['attach', '--attach'],
  ['tag', '--tag'],
  ['replace', '--replace'],
  ['replace_key', '--replace-key'],
  ['idempotency_key', '--idempotency-key'],
];

/**
 * `ping --withdraw <id>`: take back a ping this agent token already sent. The
 * notification leaves the recipients' phones; the ping stays in the room's
 * history. POST .../notifications/{id}/withdraw, agent token only.
 */
async function withdrawPing(args) {
  for (const [key, flag] of WITHDRAW_EXCLUSIVE) {
    if (args[key] !== undefined) {
      fail(`${flag} cannot be used with --withdraw: taking a ping back sends nothing`, EXIT.USAGE);
    }
  }

  const webhook = resolveWebhook(args);
  const token = resolveToken(args);
  const apiBase = resolveApiBase(args);
  const room = resolveRoom(args);

  // An incoming webhook has no id of a ping to name and no identity to take one
  // back as, so this is an agent-token route like --replace.
  if (webhook !== undefined || !token) {
    fail('--withdraw requires an agent token (--token / PINGROOM_TOKEN), not a webhook ping', EXIT.USAGE);
  }
  requireStoredCredentialOrigin(args, apiBase);
  if (!room) fail('--room is required when using --token (or set one with "pingroom config set default_room <code>")', EXIT.USAGE);
  requireSafeUrl('--api', apiBase);

  const url = `${apiBase}/api/agent/rooms/${pathSegment(room, 'room')}/notifications/${pathSegment(args.withdraw, 'ping id')}/withdraw`;
  const { res, text, json } = await httpJson('POST', url, { body: {}, headers: { Authorization: `Bearer ${token}` } });

  if (args.json) {
    process.stdout.write(`${text || '{}'}\n`);
  }

  if (!res.ok) {
    let detail = apiDetail(res, json);
    if (res.status === 404) {
      // Two different 404s: the ping is not in that room (it carries a code), or
      // the route did not match at all (a wrong room code, or a server that has
      // not switched withdrawing on, which answers like an unknown route).
      detail += json?.code === 'notification_not_found'
        ? `\n  No ping with that id in room ${room}. A ping id is the "id" a send returned (--json), or one "pingroom listen" printed.`
        : `\n  ${noRoomWithCodeHint(room)} If the code is right, this server may not have withdrawing a ping switched on yet.`;
    }
    fail(`withdraw failed: ${detail}`);
  }

  if (!args.json) process.stdout.write('ping withdrawn ✅\n');
  return EXIT.OK;
}

export async function ping(args) {
  if (args.help) { process.stdout.write(`${commandHelp('ping')}\n`); return EXIT.OK; }

  if (args.withdraw !== undefined) return withdrawPing(args);

  const message = args.message;
  if (!message) fail('a --message is required', EXIT.USAGE);
  // Room visibility is not encoded in a room code or webhook URL. Validate the
  // public ceiling here; the API applies 120 for private rooms and 160 for public.
  requireMaxLength(message, PUBLIC_PING_MESSAGE_MAX_LENGTH, '--message');
  requireMaxLength(args.title, PING_TITLE_MAX_LENGTH, '--title');

  if (args.action !== undefined) parseActionSlot(args.action);

  // --replace edits a ping this credential already sent: only its message,
  // title and data change. --replace-key finds the ping to edit by the key it
  // was sent with, so naming both says two different things.
  if (args.replace !== undefined) {
    if (args.replace_key !== undefined) {
      fail('--replace and --replace-key cannot be combined: --replace edits the ping with that id, --replace-key finds the ping to edit by its key', EXIT.USAGE);
    }
    // Everything a replacement cannot change. Refused, not dropped, so a script
    // never believes a ping became urgent or tagged when it did not.
    for (const [key, flag] of REPLACE_UNSUPPORTED) {
      if (args[key] !== undefined) {
        fail(`${flag} cannot be used with --replace: a replacement changes only the message, --title and the data`, EXIT.USAGE);
      }
    }
  }
  if (args.replace_key !== undefined) requireReplaceKey(args.replace_key);

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
    // Code points, as the server's `max:26` counts them (not UTF-16 units).
    requireMaxLength(args.button_label, 26, '--button-label');
    data = { ...(data || {}), url: args.url };
    if (args.button_label !== undefined) data.button_label = args.button_label;
  }

  // Location ping: explicit flags own the reserved data.location object. They
  // replace a raw --data location while leaving every sibling key untouched.
  const location = buildLocation(args);
  if (location !== undefined) {
    data = { ...(data || {}), location };
  }

  // Checklist ping: repeated --item flags own the reserved data.checklist
  // object the same way, replacing a raw --data checklist.
  const checklist = buildChecklist(args);
  if (checklist !== undefined) {
    data = { ...(data || {}), checklist };
  }

  // Buttons: --action-url / --action-webhook own the reserved data.actions
  // list. Unlike --location and --item they do not silently replace a raw
  // --data value: two lists of buttons is refused instead.
  const pingActions = buildPingActions(args);
  if (pingActions !== undefined) {
    if (hasPingActions(data)) {
      fail('--action-url / --action-webhook cannot be combined with data.actions in --data: give the buttons one way', EXIT.USAGE);
    }
    data = { ...(data || {}), actions: pingActions };
  }
  if (args.replace !== undefined) {
    refusePingActionsInData(data, 'ping --replace');
  } else {
    requirePingActions(data);
  }
  if (hasPingActions(data) && args.require_ack) {
    fail('a ping with buttons cannot use --require-ack: the confirmation owns the notification\'s buttons', EXIT.USAGE);
  }
  requireDataWithinServerCap(data);

  // Labels to file the ping under; the API trims and lowercases them too.
  const tags = buildTags(args);

  const webhook = resolveWebhook(args);
  const token = resolveToken(args);
  const apiBase = resolveApiBase(args);
  const room = resolveRoom(args);

  let result;

  // Attachments exist only on the agent-token path: an incoming webhook has no
  // uploader identity to bind private files to, so the API takes no ids there.
  const attachPaths = args.attach ?? [];
  if (attachPaths.length && (webhook !== undefined || !token)) {
    fail('--attach requires an agent token (--token / PINGROOM_TOKEN), not a webhook ping', EXIT.USAGE);
  }
  // Replacing is an agent-token route: an incoming webhook has no id of a ping
  // to name, and a webhook script uses --replace-key instead.
  if (args.replace !== undefined && (webhook !== undefined || !token)) {
    fail('--replace requires an agent token (--token / PINGROOM_TOKEN), not a webhook ping; to keep updating one ping from a webhook use --replace-key', EXIT.USAGE);
  }
  if (webhook !== undefined) {
    if (ackTimeout !== undefined && (ackTimeout < 1 || ackTimeout > 86_400)) {
      fail('--ack-timeout must be between 1 and 86400 seconds for a webhook ping', EXIT.USAGE);
    }
    requireSafeUrl('--webhook', webhook);
    const body = { message };
    if (args.title) body.title = args.title;
    if (args.action !== undefined) body.action = Number(args.action);
    if (data) body.data = data;
    if (tags) body.tags = tags;
    if (args.replace_key !== undefined) body.replace_key = args.replace_key;
    if (args.require_ack) body.requires_ack = true;
    if (args.ack_mode !== undefined) body.ack_mode = args.ack_mode;
    if (args.urgent) body.is_urgent = true;
    if (ackTimeout !== undefined) body.ack_timeout_seconds = ackTimeout;
    const headers = applyIdempotencyKey(args, {});
    result = await httpJson('POST', webhook, { body, headers });
  } else if (token) {
    requireStoredCredentialOrigin(args, apiBase);
    if (!room) fail('--room is required when using --token (or set one with "pingroom config set default_room <code>")', EXIT.USAGE);
    if (ackTimeout !== undefined && (ackTimeout < 60 || ackTimeout > 86_400)) {
      fail('--ack-timeout must be between 60 and 86400 seconds for an agent room ping', EXIT.USAGE);
    }
    requireSafeUrl('--api', apiBase);
    const roomUrl = `${apiBase}/api/agent/rooms/${pathSegment(room, 'room')}/notifications`;
    if (args.replace !== undefined) {
      // PUT .../notifications/{id}: the message always travels; the title and
      // data only when given, so an omitted one is kept. An explicit empty
      // --title clears the title; a data flag replaces the data as a whole.
      const body = { message };
      if (args.title !== undefined) body.title = args.title;
      if (data) body.data = data;
      result = await httpJson('PUT', `${roomUrl}/${pathSegment(args.replace, 'ping id')}`, {
        body,
        headers: { Authorization: `Bearer ${token}` },
      });
    } else {
      const body = { message };
      if (args.title) body.title = args.title;
      if (args.action !== undefined) body.action_number = Number(args.action);
      if (data) body.data = data;
      if (tags) body.tags = tags;
      if (args.replace_key !== undefined) body.replace_key = args.replace_key;
      if (args.require_ack) body.requires_ack = true;
      if (args.ack_mode !== undefined) body.ack_mode = args.ack_mode;
      if (args.urgent) body.is_urgent = true;
      if (ackTimeout !== undefined) body.ack_timeout_seconds = ackTimeout;
      const headers = applyIdempotencyKey(args, { Authorization: `Bearer ${token}` });
      if (attachPaths.length) {
        body.attachment_ids = await uploadAttachments(attachPaths, apiBase, token);
      }
      result = await httpJson('POST', roomUrl, { body, headers });
    }
  } else {
    fail(noTransportError(args), EXIT.USAGE);
  }

  const { res, text, json } = result;

  if (args.json) {
    process.stdout.write(`${text || '{}'}\n`);
  }

  // A 2xx receipt without an id is still a delivery: the id only feeds the
  // optional "View on web" link (test/ping-link.test.mjs pins this).
  const ok = res.ok && !(json && json.success === false);

  if (!ok) {
    let detail = apiDetail(res, json);
    // The API answers an unknown room code with a generic 404, which read as
    // if the ping or its file were missing rather than the room.
    if (args.replace !== undefined && res && res.status === 404) {
      // Two different 404s: the Ping is not in that room (it carries a code), or
      // the route did not match at all (a wrong room code, or a server that
      // has not switched replacing on, which answers like an unknown route).
      detail += json?.code === 'notification_not_found'
        ? `\n  No ping with that id in room ${room}. A ping id is the "id" a send returned (--json), or one "pingroom listen" printed.`
        : `\n  ${noRoomWithCodeHint(room)} If the code is right, this server may not have replacing a ping switched on yet.`;
    } else if (webhook === undefined && res && res.status === 404) {
      detail += `\n  ${noRoomWithCodeHint(room)}`;
      if (attachPaths.length) detail += ' The uploaded file was not sent and expires on its own.';
    }
    if (res.status === 409 && json?.error === 'idempotency_in_progress') {
      detail += '\n  The first request with this key is still being processed. Retry with the same --idempotency-key.';
    }
    fail(`delivery failed: ${detail}`);
  }

  if (!args.json) {
    // A send with --replace-key that found its earlier ping answers
    // `replaced: true`: the existing ping changed, none was added.
    process.stdout.write(args.replace !== undefined || json?.replaced === true ? 'ping replaced ✅\n' : 'ping sent ✅\n');
    const webUrl = pingWebUrl(json, webhook ?? apiBase);
    if (webUrl) process.stdout.write(`View on web: ${webUrl}\n`);
    // A ping with a webhook button: every tap reaches your URL signed with
    // this secret, and it is only ever returned here. (--json prints it in
    // the raw response.)
    const signingSecret = json?.action_signing_secret;
    if (typeof signingSecret === 'string' && /^[0-9a-f]{64}$/.test(signingSecret)) {
      if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${signingSecret}\n`);
      process.stdout.write(`Button signing secret: ${signingSecret}\n`);
      process.stdout.write('  Verify each delivery to your webhook button URL with it (X-PingRoom-Signature-V2). Keep it: no read of the ping returns it.\n');
    }
  }
  return EXIT.OK;
}
