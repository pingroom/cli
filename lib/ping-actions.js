// Buttons on a Ping: the reserved `data.actions` key, checked before sending
// the way `App\Support\PingActionRules` checks it on the server. The SDK keeps
// the same rules in sdk/src/internal/pingActions.ts; the CLI cannot import the
// SDK, so both are pinned to docs/contracts/ping-actions.json instead
// (test/ping-actions-contract.test.mjs).

import { EXIT } from './constants.js';
import { fail, serverJsonByteLength } from './util.js';

export const PING_ACTIONS_MAX = 3;
export const PING_ACTION_ID_PATTERN = /^[a-z0-9_-]{1,24}$/;
export const PING_ACTION_LABEL_MAX_LENGTH = 26;
export const PING_ACTION_URL_MAX_LENGTH = 2048;
export const PING_ACTION_BODY_MAX_BYTES = 1024;
export const PING_ACTION_BODY_MAX_KEYS = 10;
export const PING_ACTION_RUN_WINDOW_HOURS = 24;
export const PING_ACTION_TYPES = ['open_url', 'webhook'];
export const PING_ACTION_STYLES = ['default', 'primary', 'danger'];

const ACTION_KEYS = new Set(['id', 'label', 'type', 'url', 'style', 'body']);

const NON_PUBLIC_TLDS = new Set([
  'localhost', 'localdomain', 'local', 'internal', 'lan', 'intranet', 'corp',
  'home', 'arpa', 'onion', 'test', 'invalid', 'example',
]);

/**
 * PingRoom's own notification buttons in their comparison form: every shipped
 * translation of Pong back, Mute room, Confirm and the claim buttons, plus the
 * bare words. Sorted, equal to `reserved_labels` in the contract fixture.
 */
export const RESERVED_PING_ACTION_LABELS = [
  'abbrechen', 'abgeben', 'ack', 'acknowledge', 'annuler', 'annulla',
  'balasdenganpong', 'batal', 'benhallederim', 'bestätigen', 'bırak', 'cancel',
  'cancelar', 'cipensoio', 'completato', 'concluir', 'concluído', 'conferma',
  'confirm', 'confirmar', 'confirmer', 'couperlesondusalon', 'dejarlo', 'devolverpong',
  'done', 'erledigt', 'euassumo', 'eucuidodisso', 'fatto', 'fertig',
  'ichübernehme', 'illtakeit', 'i̇ptal', 'jemenoccupe', 'laisser', 'lascia',
  'lepaskan', 'letgo', 'liberar', 'listo', 'meencargoyo', 'meneoccupoio',
  'mute', 'muteroom', 'odayısessizeal', 'onayla', 'pingroom', 'pong',
  'pongback', 'ponggönder', 'pongzurück', 'pongभेजें', 'pongを返す', 'raumstummschalten',
  'renvoyerunpong', 'respondercompong', 'rispondiconpong', 'sahkan', 'sayaambil', 'sayauruskan',
  'selesai', 'senyapkanbilik', 'silenciarsala', 'silenziastanza', 'soltar', 'tamamla',
  'tamamlandı', 'terminé', 'unmute', 'беру', 'готово', 'ответитьpong',
  'отказаться', 'отключитьзвуккомнаты', 'отмена', 'отменить', 'подтвердить', 'явозьмусь',
  'أتخلىعنه', 'إلغاء', 'انجامشد', 'بیصداکردناتاق', 'تأكيد', 'تأیید',
  'تخلَّعنه', 'تم', 'ردبـpong', 'رهاکردن', 'سأتولىالأمر', 'كتمالغرفة',
  'لغو', 'منانجامشمیدهم', 'پاسخباpong', 'छोड़दें', 'छोड़ें', 'पुष्टिकरें',
  'पूराहुआ', 'मैंइसेलेलूँ', 'मैंसंभालूँगा', 'रद्दकरें', 'रूमम्यूटकरें', 'キャンセル',
  'ルームをミュート', '取消', '回复pong', '完了', '完成', '将房间静音',
  '已完成', '引き受ける', '我來處理', '我来', '我来处理', '手放す',
  '放弃', '放棄', '确认', '確認',
];
const RESERVED = new Set(RESERVED_PING_ACTION_LABELS);

export const PING_ACTIONS_PROHIBITED_MESSAGE = 'Buttons (data.actions) can only be sent with an ordinary Ping from an agent or an incoming webhook.';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** PHP decodes an object keyed "0", "1", ... in order as a list. */
function isPhpList(value) {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key, index) => key === String(index));
}

/** Whether `data` carries the reserved key at all (`null` counts as absent, as on the server). */
export function hasPingActions(data) {
  return isPlainObject(data) && data.actions !== undefined && data.actions !== null;
}

/** Compatibility-folded, lowercased, letters, digits and combining marks only. */
export function pingActionComparisonForm(label) {
  return label.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

/**
 * A scheme, `www.`, a dotted IPv4 address, or `name.tld`, after compatibility
 * folding. `\p{Nd}` where the server writes `\d`: PHP's `/u` patterns match
 * every decimal digit, JavaScript's `\d` only ASCII ones.
 */
export function pingActionLabelLooksLikeAddress(label) {
  const folded = label
    .replace(/\p{Cf}/gu, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[。．｡]/g, '.');
  if (folded.includes('://') || folded.includes('www.')) return true;
  if (/(?<![\p{L}\p{N}])\p{Nd}{1,3}(?:\.\p{Nd}{1,3}){3}(?![\p{L}\p{N}])/u.test(folded)) return true;
  return /(?<![\p{L}\p{N}_-])[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*\.(?:\p{L}{2,}|xn--[a-z0-9-]+)(?![\p{L}\p{N}])/u.test(folded);
}

/** Clean one label the way the server does; `error` is null when it is accepted. */
export function cleanPingActionLabel(label) {
  if (typeof label !== 'string' || /\p{Cs}/u.test(label)) {
    return { label: '', error: 'A button needs a label.' };
  }
  let cleaned = label.normalize('NFC');
  if (/[\p{Cc}\p{Zl}\p{Zp}\p{Co}]/u.test(cleaned) || /(?![‌‍\u{E0020}-\u{E007F}])\p{Cf}/u.test(cleaned)) {
    return { label: '', error: 'A button label may not contain line breaks, control characters or invisible formatting characters.' };
  }
  cleaned = cleaned.replace(/\p{Zs}+/gu, ' ').replace(/^ +| +$/g, '');
  if (cleaned === '') return { label: '', error: 'A button needs a label.' };
  if (Array.from(cleaned).length > PING_ACTION_LABEL_MAX_LENGTH) {
    return { label: '', error: `A button label is at most ${PING_ACTION_LABEL_MAX_LENGTH} characters.` };
  }
  if (pingActionLabelLooksLikeAddress(cleaned)) {
    return { label: '', error: 'A button label may not contain a web address, domain name or IP address. The app shows where the button goes.' };
  }
  if (RESERVED.has(pingActionComparisonForm(cleaned))) {
    return { label: '', error: 'That label is one of PingRoom\'s own buttons. Choose another.' };
  }
  return { label: cleaned, error: null };
}

export function isPublicPingActionHostname(host) {
  if (host === '' || host.length > 253 || host.endsWith('.')) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  const tld = labels[labels.length - 1];
  return /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld) && !NON_PUBLIC_TLDS.has(tld);
}

/** The URL rules for both button types, and the host the server derives. */
export function pingActionUrlVerdict(url, type) {
  const refuse = (error) => ({ url: '', host: '', error });
  if (typeof url !== 'string' || url === '') return refuse('A button needs a url.');
  if (Buffer.byteLength(url, 'utf8') > PING_ACTION_URL_MAX_LENGTH) {
    return refuse(`A button url is at most ${PING_ACTION_URL_MAX_LENGTH} characters.`);
  }
  if (!url.startsWith('https://')) return refuse('A button url must start with https://.');
  if (!/^[\x21-\x7E]+$/.test(url) || url.includes('\\')) {
    return refuse('A button url may contain only printable ASCII characters: percent-encode the rest, and give an internationalized domain in its punycode (xn--) form.');
  }
  const rest = url.slice('https://'.length);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const match = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(authority);
  if (!match) {
    return refuse('A button url needs a plain hostname: no user name or password, no IP address in brackets.');
  }
  const host = match[1].toLowerCase();
  const port = match[2];
  if (port !== undefined) {
    if (type === 'webhook') return refuse('A webhook button url cannot name a port: deliveries go to the standard HTTPS port.');
    if (Number(port) < 1 || Number(port) > 65535) return refuse('A button url has an invalid port.');
  }
  if (!isPublicPingActionHostname(host)) {
    return refuse('A button url needs a public hostname such as example.com: no IP address, localhost or internal name.');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return refuse('A button url must be a valid https URL.');
  }
  if (parsed.hostname !== host || parsed.username !== '' || parsed.password !== '') {
    return refuse('A button url must be a valid https URL.');
  }
  return { url, host, error: null };
}

/** A webhook button's body: a JSON object of at most 10 keys and 1024 bytes as PHP's json_encode measures it. */
export function pingActionBodyProblem(body) {
  if (!isPlainObject(body) || isPhpList(body)) return 'A webhook button body must be a JSON object.';
  if (Object.keys(body).length > PING_ACTION_BODY_MAX_KEYS) {
    return `A webhook button body takes at most ${PING_ACTION_BODY_MAX_KEYS} keys.`;
  }
  if (serverJsonByteLength(body) > PING_ACTION_BODY_MAX_BYTES) {
    return `A webhook button body must not exceed ${PING_ACTION_BODY_MAX_BYTES} bytes.`;
  }
  return null;
}

/**
 * Validate and clean a `data.actions` value as the server's
 * `PingActionRules::normalize()` does. `errors` maps a field
 * (`data.actions.1.label`) to its refusal and is empty only when all are valid.
 */
export function normalizePingActions(actions) {
  if (!Array.isArray(actions)) {
    return { actions: [], errors: { 'data.actions': 'Buttons (data.actions) must be a list.' } };
  }
  if (actions.length === 0 || actions.length > PING_ACTIONS_MAX) {
    return { actions: [], errors: { 'data.actions': `A Ping takes 1 to ${PING_ACTIONS_MAX} buttons.` } };
  }
  const errors = {};
  const normalized = [];
  const seen = new Set();
  actions.forEach((action, index) => {
    const field = `data.actions.${index}`;
    const before = Object.keys(errors).length;
    if (!isPlainObject(action) || (Object.keys(action).length > 0 && isPhpList(action))) {
      errors[field] = 'Each button must be an object.';
      return;
    }
    const unknown = Object.keys(action).filter((key) => !ACTION_KEYS.has(key));
    if (unknown.length > 0) {
      errors[field] = `Unknown button field: ${unknown.join(', ')}.`;
      return;
    }
    const id = action.id ?? `a${index + 1}`;
    if (typeof id !== 'string' || !PING_ACTION_ID_PATTERN.test(id)) {
      errors[`${field}.id`] = 'A button id is 1 to 24 characters: lowercase letters, digits, "-" and "_".';
    } else if (seen.has(id)) {
      errors[`${field}.id`] = 'Each button on a Ping needs its own id.';
    } else {
      seen.add(id);
    }
    let type = action.type;
    if (typeof type !== 'string' || !PING_ACTION_TYPES.includes(type)) {
      errors[`${field}.type`] = 'A button type is open_url or webhook.';
      type = null;
    }
    const style = action.style ?? 'default';
    if (typeof style !== 'string' || !PING_ACTION_STYLES.includes(style)) {
      errors[`${field}.style`] = 'A button style is default, primary or danger.';
    }
    const label = cleanPingActionLabel(action.label);
    if (label.error !== null) errors[`${field}.label`] = label.error;
    const url = pingActionUrlVerdict(action.url, type ?? 'open_url');
    if (url.error !== null) errors[`${field}.url`] = url.error;
    const body = action.body ?? null;
    if (body !== null) {
      const problem = type === 'webhook' ? pingActionBodyProblem(body) : 'Only a webhook button takes a body.';
      if (problem !== null) errors[`${field}.body`] = problem;
    }
    if (Object.keys(errors).length !== before) return;
    normalized.push({
      id, position: index, type, label: label.label, style, url: url.url, host: url.host,
      body: isPlainObject(body) && Object.keys(body).length > 0 ? body : null,
    });
  });
  return Object.keys(errors).length === 0 ? { actions: normalized, errors: {} } : { actions: [], errors };
}

/**
 * Split an `--action-url` / `--action-webhook` value, `Label=https://…`, at
 * the first `=` that is followed by a URL scheme, so a label may itself hold
 * `=` and the URL's query may too. Null when there is no such `=`.
 */
export function splitPingActionFlag(value) {
  const at = typeof value === 'string' ? value.search(/=[A-Za-z][A-Za-z0-9+.-]*:/) : -1;
  if (at < 0) return null;
  return { label: value.slice(0, at), url: value.slice(at + 1) };
}

/**
 * The buttons `ping` builds from its flags: every `--action-url` (an
 * `open_url` button) in the order given, then every `--action-webhook` (a
 * `webhook` button) in the order given. `--action-body` is repeatable too and
 * pairs with `--action-webhook` by position, so it must be given either never
 * or exactly once per `--action-webhook`. Ids default to a1, a2, a3 by
 * position and the style to `default`; for your own ids, a style or another
 * order, send `data.actions` in `--data` instead. Undefined without any of the
 * flags. Fails (exit 2) naming the flag when the server would refuse a button.
 */
export function buildPingActions(args) {
  const urls = args.action_url ?? [];
  const hooks = args.action_webhook ?? [];
  const bodies = args.action_body ?? [];
  if (bodies.length > 0 && hooks.length === 0) {
    fail('--action-body requires --action-webhook', EXIT.USAGE);
  }
  if (bodies.length > 0 && bodies.length !== hooks.length) {
    fail(`--action-body pairs with --action-webhook by position: give it once per --action-webhook (got ${bodies.length} for ${hooks.length})`, EXIT.USAGE);
  }
  if (urls.length === 0 && hooks.length === 0) return undefined;

  const flags = [];
  const actions = [];
  for (const [index, value] of urls.entries()) {
    const parts = splitPingActionFlag(value);
    if (!parts) fail(`--action-url must be "Label=https://…" (got ${JSON.stringify(value)})`, EXIT.USAGE);
    flags.push(`--action-url #${index + 1}`);
    actions.push({ label: parts.label, type: 'open_url', url: parts.url });
  }
  for (const [index, value] of hooks.entries()) {
    const parts = splitPingActionFlag(value);
    if (!parts) fail(`--action-webhook must be "Label=https://…" (got ${JSON.stringify(value)})`, EXIT.USAGE);
    const action = { label: parts.label, type: 'webhook', url: parts.url };
    if (bodies[index] !== undefined) {
      let body;
      try {
        body = JSON.parse(bodies[index]);
      } catch {
        fail(`--action-body #${index + 1} must be valid JSON`, EXIT.USAGE);
      }
      action.body = body;
    }
    flags.push(`--action-webhook #${index + 1}`);
    actions.push(action);
  }
  if (actions.length > PING_ACTIONS_MAX) {
    fail(`a ping takes 1 to ${PING_ACTIONS_MAX} buttons (got ${actions.length} from --action-url and --action-webhook)`, EXIT.USAGE);
  }

  const { errors } = normalizePingActions(actions);
  const problems = Object.entries(errors).map(([field, message]) => {
    const [, index, part] = /^data\.actions\.(\d+)(?:\.(\w+))?$/.exec(field) ?? [];
    const flag = index === undefined ? 'buttons' : flags[Number(index)];
    return `${flag}${part ? ` ${part === 'body' ? '(--action-body)' : part}` : ''}: ${message}`;
  });
  if (problems.length > 0) fail(problems.join('\n'), EXIT.USAGE);
  return actions;
}

/** Fail (exit 2) naming every field when `data.actions` in `--data` would be refused. */
export function requirePingActions(data, what = '--data') {
  if (!hasPingActions(data)) return;
  const problems = Object.entries(normalizePingActions(data.actions).errors);
  if (problems.length > 0) {
    fail(problems.map(([field, message]) => `${what} ${field}: ${message}`).join('\n'), EXIT.USAGE);
  }
}

/**
 * Fail (exit 2) when a command that never carries buttons (ask, handoff, live,
 * ping --replace) is handed `data.actions`: the server answers 422 there.
 */
export function refusePingActionsInData(data, where) {
  if (isPlainObject(data) && data.actions !== undefined && data.actions !== null) {
    fail(`${where} cannot carry buttons (data.actions). ${PING_ACTIONS_PROHIBITED_MESSAGE}`, EXIT.USAGE);
  }
}
