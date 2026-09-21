// Room, webhook, quick-action, approval, and attachment management — the
// agent REST surface that previously had no CLI verbs. One module, one
// sub-command dispatch per noun, JSON-first output (--json prints the raw
// response; the default prints a compact human line per record).

import { readFileSync } from 'node:fs';

import { EXIT } from '../constants.js';
import { applyIdempotencyKey, buildLocation, fail, parseLocation, requireLinkUrl, requireMaxLength, resolveWaitHold } from '../util.js';
import { commandHelp } from '../help.js';
import { apiDetail, httpJson, uploadAttachments } from '../http.js';

const INPUT_TYPES = ['none', 'location', 'link', 'file', 'photo', 'pdf'];
const QUICK_ACTION_PAGE_SIZE = 4;
const MAX_QUICK_ACTION_PAGES = 4;
const LOCATION_NAME_MAX_LENGTH = 160;

/**
 * Mirrors the server's icon rule (`present`, `required_with:label`): the emoji
 * is the half that must be there, unless BOTH label and icon are empty — that
 * reserves the slot as disabled rather than configuring it.
 */
function requireActionIconRule(entry, what) {
  if (entry.label === undefined || entry.icon === undefined) {
    fail(`${what} needs label (may be empty) and icon (may be empty only together with an empty label)`, EXIT.USAGE);
  }
  if (String(entry.icon).trim() === '' && String(entry.label).trim() !== '') {
    fail(`${what}: --icon is required when a label is set; send both empty to disable the slot`, EXIT.USAGE);
  }
}

function requireInputType(value, flag) {
  if (value === undefined) return undefined;
  if (!INPUT_TYPES.includes(value)) fail(`${flag} must be one of ${INPUT_TYPES.join(', ')}`, EXIT.USAGE);
  return value;
}
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
    const body = { invite_code: code };
    if (args.password !== undefined) body.password = args.password;
    const { text, json } = await requireOk(
      httpJson('POST', `${apiBase}/api/agent/rooms/join`, { headers: auth(token), body }),
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

  // A public room can carry a place for nearby discovery. The server takes the
  // trio all-or-nothing and marks it `prohibited` on the private create.
  if (args.location !== undefined || args.location_name !== undefined) {
    if (!args.public) {
      fail('--location / --location-name are only accepted on a public room (add --public --handle <handle>)', EXIT.USAGE);
    }
    if (args.location === undefined || args.location_name === undefined) {
      fail('--location <lat,lng> and --location-name <text> must be given together', EXIT.USAGE);
    }
    requireMaxLength(args.location_name, LOCATION_NAME_MAX_LENGTH, '--location-name');
    const { latitude, longitude } = parseLocation(args.location);
    body.location_name = args.location_name;
    body.location_latitude = latitude;
    body.location_longitude = longitude;
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
  const action = sub(args, ['list', 'set', 'set-all', 'trigger', 'layout'], 'actions');
  if (args.ack_mode !== undefined) {
    if (action !== 'trigger') fail('--ack-mode is only supported by actions trigger', EXIT.USAGE);
    if (!['any', 'all'].includes(args.ack_mode)) fail('--ack-mode must be any or all', EXIT.USAGE);
  }
  for (const [key, flag] of [
    ['url', '--url'], ['location', '--location'], ['location_label', '--location-label'],
    ['location_address', '--location-address'], ['attach', '--attach'], ['quick_action_id', '--quick-action-id'],
  ]) {
    if (args[key] !== undefined && action !== 'trigger') fail(`${flag} is only supported by actions trigger`, EXIT.USAGE);
  }
  if (args.input_type !== undefined && action !== 'set') fail('--input-type is only supported by actions set (use the input_type key in set-all entries)', EXIT.USAGE);
  if (args.page_order !== undefined && action !== 'layout') fail('--page-order is only supported by actions layout', EXIT.USAGE);
  const { token, apiBase, room } = agentContext(args, { needRoom: true });
  const base = `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/actions`;

  if (action === 'list') {
    const { text, json } = await requireOk(httpJson('GET', base, { headers: auth(token) }), 'actions list');
    const items = Array.isArray(json) ? json : (json.actions ?? json.quick_actions ?? json.data ?? []);
    printJsonOr(args, text, items.map((a) => {
      const configured = String(a.label ?? '').trim() !== '' || String(a.icon ?? '').trim() !== '';
      const needs = a.input_type && a.input_type !== 'none' ? `  [needs ${a.input_type}]` : '';
      return `${a.action_number}  ${a.icon ?? ''} ${configured ? (a.label ?? '') : '(disabled)'}${needs}`;
    }).join('\n') || '(no actions)');
    return EXIT.OK;
  }

  // Replace the page layout atomically: read the current set so base_action_ids
  // is real, keep every retained Ping's configuration, renumber, PUT.
  if (action === 'layout') {
    const pageOrder = parsePageOrder(args.page_order);
    const { json } = await requireOk(httpJson('GET', base, { headers: auth(token) }), 'actions list');
    const stored = (Array.isArray(json) ? json : (json.actions ?? json.quick_actions ?? json.data ?? []))
      .slice()
      .sort((a, b) => Number(a.action_number) - Number(b.action_number));
    const pageCount = Math.max(1, Math.ceil(Number(stored.at(-1)?.action_number ?? 0) / QUICK_ACTION_PAGE_SIZE));
    for (const page of pageOrder) {
      if (page !== null && page > pageCount) fail(`--page-order names page ${page}, but the room has ${pageCount} page(s)`, EXIT.USAGE);
    }
    const byNumber = new Map(stored.map((a) => [Number(a.action_number), a]));
    const actions = [];
    pageOrder.forEach((originalPage, index) => {
      for (let offset = 1; offset <= QUICK_ACTION_PAGE_SIZE; offset++) {
        const source = originalPage === null ? undefined : byNumber.get((originalPage - 1) * QUICK_ACTION_PAGE_SIZE + offset);
        const entry = { action_number: index * QUICK_ACTION_PAGE_SIZE + offset, label: source?.label ?? '', icon: source?.icon ?? '' };
        for (const key of ['sound', 'haptic_style', 'requires_ack', 'input_type']) {
          if (source && source[key] !== undefined && source[key] !== null) entry[key] = source[key];
        }
        actions.push(entry);
      }
    });
    const body = {
      base_action_ids: stored.map((a) => a.id).filter((id) => typeof id === 'string'),
      page_order: pageOrder,
      actions,
    };
    const { text } = await requireOk(httpJson('PUT', `${base}/layout`, { headers: auth(token), body }), 'actions layout');
    printJsonOr(args, text, `layout saved: ${pageOrder.length} page(s), ${actions.length} slots`);
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
  if (!/^(?:[1-9]|1[0-6])$/.test(String(slot))) fail(`usage: pingroom actions ${action} <1-16> --room <code>`, EXIT.USAGE);

  if (action === 'trigger') {
    const body = {};
    if (args.ack_mode !== undefined) body.ack_mode = args.ack_mode;
    if (args.require_ack) body.requires_ack = true;
    if (args.urgent) body.is_urgent = true;
    // The detail a press carries when the slot has an input type. Only
    // `location` and `url` live under data on a trigger (no button label);
    // files upload first and ride as ids, exactly as `ping --attach` does.
    const location = buildLocation(args);
    if (location !== undefined) body.data = { ...(body.data ?? {}), location };
    if (args.url !== undefined) body.data = { ...(body.data ?? {}), url: requireLinkUrl(args.url) };
    if (args.quick_action_id !== undefined) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(args.quick_action_id))) {
        fail('--quick-action-id must be the action\'s uuid from "pingroom actions list --json"', EXIT.USAGE);
      }
      body.quick_action_id = args.quick_action_id;
    }
    const attachPaths = args.attach ?? [];
    if (attachPaths.length) body.attachment_ids = await uploadAttachments(attachPaths, apiBase, token);
    const headers = applyIdempotencyKey(args, auth(token));
    const { text } = await requireOk(
      httpJson('POST', `${base}/${slot}/trigger`, { headers, body }),
      'actions trigger',
    );
    process.stdout.write(`${text}\n`);
    return EXIT.OK;
  }

  // A Ping's title is optional — its emoji can be the whole name — so
  // `--label ""` is a deliberate value, not a missing flag. The emoji is the
  // half that must be there.
  if (args.label === undefined || args.icon === undefined) {
    fail('actions set needs --label (may be empty) and --icon (may be empty only together with an empty label, which disables the slot)', EXIT.USAGE);
  }
  requireActionIconRule({ label: args.label, icon: args.icon }, 'actions set');
  const body = { label: args.label, icon: args.icon };
  if (args.sound !== undefined) body.sound = args.sound;
  if (args.require_ack) body.requires_ack = true;
  const inputType = requireInputType(args.input_type, '--input-type');
  if (inputType !== undefined) body.input_type = inputType;

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
  if (raw.length > 16) fail('a batch may contain at most 16 action slots', EXIT.USAGE);

  const seen = new Set();
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('each action must be a JSON object', EXIT.USAGE);
    }
    const slot = entry.action_number;
    if (!/^(?:[1-9]|1[0-6])$/.test(String(slot))) fail(`action_number must be 1-16, got ${JSON.stringify(slot)}`, EXIT.USAGE);
    if (seen.has(String(slot))) fail(`action_number ${slot} appears twice`, EXIT.USAGE);
    seen.add(String(slot));
    // Mirrors `actions set`: an empty label is a deliberate value (the emoji
    // names the Ping), so only `undefined` is missing. The icon is required
    // unless both are empty, which reserves a disabled slot.
    requireActionIconRule(entry, `action ${slot}`);
    requireInputType(entry.input_type, `action ${slot} input_type`);
  }

  return raw;
}

/**
 * `--page-order 1,3` / `2,1,new`: the ORIGINAL page numbers to keep, in their
 * new order, or `new` for a blank page. Pages left out are deleted. The
 * server's page_order contract uses null for a blank page.
 */
function parsePageOrder(raw) {
  if (raw === undefined || String(raw).trim() === '') {
    fail('actions layout needs --page-order <csv>, e.g. --page-order 1,3 (keep pages 1 and 3, delete the rest) or 2,1,new', EXIT.USAGE);
  }
  const entries = String(raw).split(',').map((part) => part.trim());
  if (entries.length < 1 || entries.length > MAX_QUICK_ACTION_PAGES) {
    fail(`--page-order lists 1-${MAX_QUICK_ACTION_PAGES} pages`, EXIT.USAGE);
  }
  const seen = new Set();
  return entries.map((entry) => {
    if (entry === 'new') return null;
    if (!/^[1-4]$/.test(entry)) fail(`--page-order entries must be a page number 1-${MAX_QUICK_ACTION_PAGES} or "new", got ${JSON.stringify(entry)}`, EXIT.USAGE);
    if (seen.has(entry)) fail(`--page-order lists page ${entry} twice`, EXIT.USAGE);
    seen.add(entry);
    return Number(entry);
  });
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
    redirect: 'error',
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
