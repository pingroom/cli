// Room, webhook, quick-action, approval, and attachment management — the
// agent REST surface that previously had no CLI verbs. One module, one
// sub-command dispatch per noun, JSON-first output (--json prints the raw
// response; the default prints a compact human line per record).

import { readFileSync } from 'node:fs';

import { EXIT } from '../constants.js';
import { applyIdempotencyKey, fail, requireMaxLength, resolveWaitHold } from '../util.js';
import { commandHelp } from '../help.js';
import { apiDetail, httpJson } from '../http.js';
import { agentContext } from '../config.js';
import { APPROVAL_OPTIONS, exitForApproval, printApproval } from '../render.js';
import { waitForResolution } from '../question-wait.js';

function sub(args, allowed, noun) {
  const name = args._[0];
  if (!name || !allowed.includes(name)) {
    fail(`usage: pingroom ${noun} <${allowed.join('|')}>\nRun "pingroom ${noun} --help".`, EXIT.USAGE);
  }
  return name;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function requireOk(promise, what) {
  const { res, text, json } = await promise;
  if (!res.ok) fail(`${what} failed: ${apiDetail(res, json)}`);
  return { text, json };
}

function printJsonOr(args, text, lines) {
  if (args.json) process.stdout.write(`${text}\n`);
  else process.stdout.write(`${lines}\n`);
}

// ---------------------------------------------------------------- rooms

export async function rooms(args) {
  if (args.help) { process.stdout.write(`${commandHelp('rooms')}\n`); return EXIT.OK; }
  const action = sub(args, ['list', 'get', 'create', 'join', 'icons'], 'rooms');
  const { token, apiBase } = agentContext(args);

  if (action === 'icons') {
    const { text, json } = await requireOk(
      httpJson('GET', `${apiBase}/api/agent/room-icons`, { headers: auth(token) }),
      'rooms icons',
    );
    if (args.json) { process.stdout.write(`${text}\n`); return EXIT.OK; }
    const categories = Array.isArray(json.categories) ? json.categories : [];
    const lines = categories.map((c) => `${c.label ?? c.id}: ${(c.icons ?? []).join(' ')}`);
    process.stdout.write(`${lines.join('\n') || '(no icons)'}\n`);
    return EXIT.OK;
  }

  if (action === 'list') {
    const { text, json } = await requireOk(
      httpJson('GET', `${apiBase}/api/agent/rooms`, { headers: auth(token) }),
      'rooms list',
    );
    const items = Array.isArray(json) ? json : (json.rooms ?? json.data ?? []);
    printJsonOr(args, text, items.map((r) => `${r.invite_code}  ${r.name}${r.is_public ? '  (public)' : ''}`).join('\n') || '(no rooms)');
    return EXIT.OK;
  }

  if (action === 'get') {
    const code = args._[1];
    if (!code) fail('usage: pingroom rooms get <invite-code>', EXIT.USAGE);
    const { text } = await requireOk(
      httpJson('GET', `${apiBase}/api/agent/rooms/${encodeURIComponent(code)}`, { headers: auth(token) }),
      'rooms get',
    );
    process.stdout.write(`${text}\n`);
    return EXIT.OK;
  }

  if (action === 'join') {
    const code = args._[1];
    if (!code) fail('usage: pingroom rooms join <invite-code>', EXIT.USAGE);
    const { text, json } = await requireOk(
      httpJson('POST', `${apiBase}/api/agent/rooms/join`, { headers: auth(token), body: { invite_code: code } }),
      'rooms join',
    );
    // The server returns the room flat, so `json.room` is never set and the
    // name always fell back to the invite code.
    printJsonOr(args, text, `joined ${json.room?.name ?? json.name ?? code}`);
    return EXIT.OK;
  }

  // create — private by default; --public requires --handle and uses the
  // dedicated consent scope on the server.
  if (!args.name) fail('rooms create needs --name', EXIT.USAGE);
  if (!args.icon || !args.color) fail('rooms create needs --icon and --color. --icon is a v3 catalog id, not an emoji — run "pingroom rooms icons" to browse, e.g. --icon bell --color "#e33122"', EXIT.USAGE);

  const body = { name: args.name, icon: args.icon, color: args.color };

  let url = `${apiBase}/api/agent/rooms`;
  if (args.public) {
    if (!args.handle) fail('a public room needs --handle', EXIT.USAGE);
    body.handle = args.handle;
    url = `${apiBase}/api/agent/rooms/public`;
  }

  // The ordinary rooms:write scope creates a MINIMAL private room: the server
  // marks description (with is_public, handle, category, actions and friends)
  // `prohibited` there and answers 422. Only the public create carries them.
  // Say so here rather than posting a request that cannot succeed.
  if (args.description !== undefined) {
    if (!args.public) {
      fail('--description is only accepted on a public room (add --public --handle <handle>). A private agent room is created minimal; set its description from the app.', EXIT.USAGE);
    }
    body.description = args.description;
  }

  const { text, json } = await requireOk(httpJson('POST', url, { headers: auth(token), body }), 'rooms create');
  printJsonOr(args, text, `created ${json.room?.invite_code ?? json.invite_code ?? ''} ${args.name}`.trim());
  return EXIT.OK;
}

// ------------------------------------------------------------- webhooks

export async function webhooks(args) {
  if (args.help) { process.stdout.write(`${commandHelp('webhooks')}\n`); return EXIT.OK; }
  const action = sub(args, ['list', 'create', 'update', 'delete'], 'webhooks');
  const { token, apiBase, room } = agentContext(args, { needRoom: true });
  const base = `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/webhooks`;

  if (action === 'list') {
    const { text, json } = await requireOk(httpJson('GET', base, { headers: auth(token) }), 'webhooks list');
    const items = Array.isArray(json) ? json : (json.webhooks ?? json.data ?? []);
    printJsonOr(args, text, items.map((w) => `${w.id}  ${w.name}${w.enabled === false ? '  (disabled)' : ''}`).join('\n') || '(no webhooks)');
    return EXIT.OK;
  }

  if (action === 'delete') {
    const id = args._[1];
    if (!id) fail('usage: pingroom webhooks delete <id> --room <code>', EXIT.USAGE);
    await requireOk(httpJson('DELETE', `${base}/${encodeURIComponent(id)}`, { headers: auth(token) }), 'webhooks delete');
    process.stdout.write('deleted\n');
    return EXIT.OK;
  }

  const body = {};
  for (const key of ['name', 'title', 'message', 'icon', 'color', 'sound']) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  if (args.action !== undefined) body.action_number = Number(args.action);
  if (args.cooldown !== undefined) body.cooldown_seconds = Number(args.cooldown);
  if (args.enabled !== undefined) body.enabled = args.enabled !== 'false';

  if (action === 'create') {
    if (!body.name) fail('webhooks create needs --name', EXIT.USAGE);
    const { text, json } = await requireOk(httpJson('POST', base, { headers: auth(token), body }), 'webhooks create');
    // The trigger URL carries the webhook secret — print it once, like the app.
    // The server answers with the webhook FLAT plus `webhook_url`; the nested
    // shapes are only kept as fallbacks. Reading `json.webhook.*` alone printed
    // a bare "created" and swallowed the one credential this command exists to
    // hand over.
    const created = json.webhook ?? json;
    const url = created.webhook_url ?? created.url ?? json.webhook_url ?? json.url ?? '';
    printJsonOr(args, text, `created ${created.id ?? ''}\n${url}`.trim());
    return EXIT.OK;
  }

  const id = args._[1];
  if (!id) fail('usage: pingroom webhooks update <id> --room <code> [fields]', EXIT.USAGE);
  const { text } = await requireOk(
    httpJson('PUT', `${base}/${encodeURIComponent(id)}`, { headers: auth(token), body }),
    'webhooks update',
  );
  process.stdout.write(`${text}\n`);
  return EXIT.OK;
}

// -------------------------------------------------------------- actions

export async function actions(args) {
  if (args.help) { process.stdout.write(`${commandHelp('actions')}\n`); return EXIT.OK; }
  const action = sub(args, ['list', 'set', 'set-all', 'trigger'], 'actions');
  const { token, apiBase, room } = agentContext(args, { needRoom: true });
  const base = `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/actions`;

  if (action === 'list') {
    const { text, json } = await requireOk(httpJson('GET', base, { headers: auth(token) }), 'actions list');
    const items = Array.isArray(json) ? json : (json.actions ?? json.quick_actions ?? json.data ?? []);
    printJsonOr(args, text, items.map((a) => `${a.action_number}  ${a.icon ?? ''} ${a.label ?? '(unset)'}`).join('\n') || '(no actions)');
    return EXIT.OK;
  }

  // Write several slots in ONE request. Each slot the server writes separately
  // costs the room owner a background wake, so configuring four Pings with four
  // `actions set` calls spends four of a finite daily push budget on a single
  // logical operation. Slots left out are untouched — this never clears a Ping.
  if (action === 'set-all') {
    const entries = collectActionEntries(args);
    const { text } = await requireOk(
      httpJson('PUT', base, { headers: auth(token), body: { actions: entries } }),
      'actions set-all',
    );
    process.stdout.write(`${text}\n`);
    return EXIT.OK;
  }

  const slot = args._[1];
  if (!/^[1-4]$/.test(String(slot))) fail(`usage: pingroom actions ${action} <1-4> --room <code>`, EXIT.USAGE);

  if (action === 'trigger') {
    const { text } = await requireOk(
      httpJson('POST', `${base}/${slot}/trigger`, { headers: auth(token), body: {} }),
      'actions trigger',
    );
    process.stdout.write(`${text}\n`);
    return EXIT.OK;
  }

  // A Ping's title is optional — its emoji can be the whole name — so
  // `--label ""` is a deliberate value, not a missing flag. The emoji is the
  // half that must be there.
  if (args.label === undefined || !args.icon) {
    fail('actions set needs --label (may be empty) and --icon', EXIT.USAGE);
  }
  const body = { label: args.label, icon: args.icon };
  if (args.sound !== undefined) body.sound = args.sound;
  if (args.require_ack) body.requires_ack = true;

  const { text } = await requireOk(
    httpJson('PUT', `${base}/${slot}`, { headers: auth(token), body }),
    'actions set',
  );
  process.stdout.write(`${text}\n`);
  return EXIT.OK;
}


/**
 * Build the `actions` array for `actions set-all` from either form:
 *   --set '{"action_number":1,"label":"Deployed","icon":"check"}'   (repeatable)
 *   --actions '[{...},{...}]'                                       (one array)
 *   --actions -                                                     (that array on stdin)
 *
 * Both exist because both callers are real: a shell loop appends `--set` per
 * slot without concatenating JSON, while an agent already holding the whole
 * array passes it once. Validation is deliberately shallow — the server owns
 * the rules, and duplicating them here would let the two drift — but the shape
 * errors that would otherwise surface as an opaque 422 are caught up front.
 */
function collectActionEntries(args) {
  const raw = [];

  for (const item of args.set ?? []) {
    raw.push(parseActionJson(item, '--set'));
  }

  if (args.actions !== undefined) {
    const source = args.actions === '-' ? readStdinSync() : args.actions;
    const parsed = parseActionJson(source, '--actions');
    if (!Array.isArray(parsed)) fail('--actions must be a JSON array of action objects', EXIT.USAGE);
    raw.push(...parsed);
  }

  if (raw.length === 0) {
    fail('actions set-all needs --set <json> (repeatable) or --actions <json array>', EXIT.USAGE);
  }
  if (raw.length > 4) fail('a room has only 4 action slots', EXIT.USAGE);

  const seen = new Set();
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('each action must be a JSON object', EXIT.USAGE);
    }
    const slot = entry.action_number;
    if (!/^[1-4]$/.test(String(slot))) fail(`action_number must be 1-4, got ${JSON.stringify(slot)}`, EXIT.USAGE);
    if (seen.has(String(slot))) fail(`action_number ${slot} appears twice`, EXIT.USAGE);
    seen.add(String(slot));
    // Mirrors `actions set`: an empty label is a deliberate value (the emoji
    // names the Ping), so only `undefined` is missing. The icon is required.
    if (entry.label === undefined || !entry.icon) {
      fail(`action ${slot} needs label (may be empty) and icon`, EXIT.USAGE);
    }
  }

  return raw;
}

function parseActionJson(value, flag) {
  try {
    return JSON.parse(value);
  } catch {
    fail(`${flag} must be valid JSON`, EXIT.USAGE);
  }
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    fail('could not read actions from stdin', EXIT.USAGE);
  }
}

// ------------------------------------------------------------- approval

/**
 * The deploy gate. An approval is the canonical two-option Question, so this
 * creates one rather than using the older `/approvals` endpoint: only Questions
 * reach the phone with real Approve/Deny buttons on the lock screen, and only
 * Questions get idempotency, the expiry sweep and the resolution webhook.
 */
export async function approval(args) {
  if (args.help) { process.stdout.write(`${commandHelp('approval')}\n`); return EXIT.OK; }

  if (!args.prompt) fail('an approval needs --prompt', EXIT.USAGE);
  requireMaxLength(args.prompt, 500, '--prompt');
  requireMaxLength(args.context, 40, '--context');

  const { token, apiBase, room } = agentContext(args, { needRoom: true });

  const body = { prompt: args.prompt, options: APPROVAL_OPTIONS };
  if (args.context) body.context = args.context;
  if (args.ttl !== undefined) {
    if (!/^\d+$/.test(String(args.ttl))) fail('--ttl must be an integer number of seconds', EXIT.USAGE);
    body.ttl = Number(args.ttl);
  }

  const headers = applyIdempotencyKey(args, auth(token));

  // Pre-flight: reject a bad --timeout before the approval is on someone's phone.
  if (args.wait) resolveWaitHold(args, { def: 25, cap: 30 });

  const { text, json } = await requireOk(
    httpJson('POST', `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/questions`, { headers, body }),
    'approval',
  );

  if (!args.wait) {
    if (args.json) process.stdout.write(`${text}\n`);
    else process.stdout.write(`${json.id}\n`);
    return EXIT.OK;
  }

  return waitForResolution(json.id, args, { token, apiBase }, {
    exitFor: exitForApproval,
    print: printApproval,
  });
}

// ----------------------------------------------------------- attachment

export async function attachment(args) {
  if (args.help) { process.stdout.write(`${commandHelp('attachment')}\n`); return EXIT.OK; }
  const action = sub(args, ['get', 'delete'], 'attachment');
  const id = args._[1];
  if (!id) fail(`usage: pingroom attachment ${action} <id>`, EXIT.USAGE);
  const { token, apiBase } = agentContext(args);

  if (action === 'delete') {
    await requireOk(
      httpJson('DELETE', `${apiBase}/api/agent/attachments/${encodeURIComponent(id)}`, { headers: auth(token) }),
      'attachment delete',
    );
    process.stdout.write('deleted\n');
    return EXIT.OK;
  }

  // Binary download: raw fetch, not httpJson. Bytes go to --out or stdout.
  const res = await fetch(`${apiBase}/api/agent/attachments/${encodeURIComponent(id)}/content`, {
    headers: auth(token),
  });
  if (!res.ok) {
    let json = null;
    try { json = await res.json(); } catch { /* binary error bodies stay generic */ }
    fail(`attachment get failed: ${apiDetail(res, json)}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (args.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args.out, bytes);
    process.stdout.write(`${args.out}  ${bytes.length} bytes\n`);
  } else {
    process.stdout.write(bytes);
  }
  return EXIT.OK;
}
