// Turning flag strings into wire objects, and wire objects back into the exact
// lines this CLI prints. Pure functions with no I/O beyond stdout/stderr, which
// is what makes them unit-testable without a subprocess (see test/render.test.mjs).

import { EXIT } from './constants.js';
import { fail, stripControlChars } from './util.js';

// The templates the server accepts on `live start`. Mirrored here so a typo is
// a local usage error instead of a 422 from the API. Keep in lockstep with the
// --template line in HELP and with LIVE_ACTIVITY_TEMPLATES.md.
export const LIVE_TEMPLATES = ['status', 'steps', 'progress', 'metrics', 'countdown', 'question', 'matchup'];

/**
 * Names the API does not take, folded onto the wire id it does.
 *
 * The `question` template is labelled **Decision** everywhere a person sees it,
 * so it is never confused with PingRoom's first-class Question protocol — that
 * one is answered through `pingroom ask`, carries a real Question id, and this
 * template does not. The wire id stayed `question`, so someone who reads
 * "Decision" in the app and types it would otherwise get a usage error for
 * using the only name they have been shown.
 */
export const LIVE_TEMPLATE_ALIASES = { decision: 'question' };

/** The wire id for a template name a human typed, or the name unchanged. */
export function canonicalTemplate(name) {
  return LIVE_TEMPLATE_ALIASES[name] ?? name;
}

/** What we offer in help and errors: the alias leads, since it is what the app shows. */
export const LIVE_TEMPLATE_NAMES = ['status', 'steps', 'progress', 'metrics', 'countdown', 'decision', 'matchup'];

// "label:value" -> {label, value}. Only the first colon splits.
export function buildMetrics(list) {
  if (!list || list.length === 0) return undefined;
  return list.map((spec) => {
    const idx = spec.indexOf(':');
    if (idx <= 0) fail(`--metric must be "label:value" (got "${spec}")`, EXIT.USAGE);
    return { label: spec.slice(0, idx), value: spec.slice(idx + 1) };
  });
}

// "value:label" -> {value, label}; a bare token is both. Matches the `ask`
// command's option syntax minus `style`, which live_status options don't carry.
export function buildLiveOptions(list) {
  if (!list || list.length === 0) return undefined;
  return list.map((spec) => {
    const idx = spec.indexOf(':');
    if (idx < 0) return { value: spec, label: spec };
    if (idx === 0) fail(`--option needs a value before the colon (got "${spec}")`, EXIT.USAGE);
    return { value: spec.slice(0, idx), label: spec.slice(idx + 1) };
  });
}

// "label:value" -> {label, value}, for --left / --right on the matchup template.
export function buildSide(spec, flag) {
  if (spec === undefined) return undefined;
  const idx = spec.indexOf(':');
  if (idx <= 0) fail(`${flag} must be "label:value" (got "${spec}")`, EXIT.USAGE);
  return { label: spec.slice(0, idx), value: spec.slice(idx + 1) };
}

// The server accepts #rrggbb with or without the leading #; normalize to one
// form so a shell that ate the # (unquoted) still produces a valid payload.
export function normalizeAccent(raw) {
  if (raw === undefined) return undefined;
  const hex = raw.trim().replace(/^#/, '');
  if (!/^[0-9A-Fa-f]{6}$/.test(hex)) {
    fail(`--accent-override must be a 6-digit hex color (got "${raw}")`, EXIT.USAGE);
  }
  return `#${hex.toLowerCase()}`;
}

// value:label -> {value, label}. Labels may contain colons (only the first
// splits). A bare token is both value and label. Omit all for Approve/Deny.
export function buildOptions(list) {
  if (!list || list.length === 0) return undefined;
  return list.map((spec) => {
    const idx = spec.indexOf(':');
    const value = idx === -1 ? spec : spec.slice(0, idx);
    let label = idx === -1 ? spec : spec.slice(idx + 1);
    if (!value) fail(`--option must be "value", "value:label" or "value:label:style" (got "${spec}")`, EXIT.USAGE);
    // A trailing :primary|:danger|:default segment styles the button; any other
    // trailing segment stays part of the label (labels may contain colons).
    let style;
    const lastColon = label.lastIndexOf(':');
    if (lastColon !== -1) {
      const candidate = label.slice(lastColon + 1);
      if (candidate === 'primary' || candidate === 'danger' || candidate === 'default') {
        style = candidate;
        label = label.slice(0, lastColon);
      }
    }
    return style ? { value, label, style } : { value, label };
  });
}

export function exitForState(state) {
  switch (state) {
    case 'answered': return EXIT.OK;
    case 'expired': return EXIT.EXPIRED;
    case 'cancelled': return EXIT.CANCELLED;
    default: return EXIT.ERROR;
  }
}

// Print the outcome. On `answered`, the chosen value (or typed text) goes to
// stdout so `$(pingroom ask --wait ...)` captures it; other outcomes report to
// stderr and leave stdout empty.
export function printResolution(q) {
  if (q.state === 'answered') {
    const out = q.answer && (q.answer.text || q.answer.value) || '';
    process.stdout.write(`${stripControlChars(out)}\n`);
  } else {
    process.stderr.write(`pingroom: question ${stripControlChars(q.state)}\n`);
  }
}

/**
 * The two options behind `pingroom approval`. An approval IS a two-option
 * Question — same wire shape, same lock-screen buttons, same first-answer-wins
 * — so the command builds one rather than reaching for the older Approvals API,
 * which delivers no answer actions to the phone at all.
 */
export const APPROVAL_OPTIONS = Object.freeze([
  Object.freeze({ value: 'approve', label: 'Approve', style: 'primary' }),
  Object.freeze({ value: 'deny', label: 'Deny', style: 'danger' }),
]);

/**
 * A deploy gate reads the chosen VALUE, not just the state.
 *
 * `exitForState` maps every answer to 0, which is right for `ask` (a human
 * answering "hold" is not an infra failure) and catastrophic for a gate:
 * `if pingroom approval --wait; then deploy; fi` must refuse on a denial.
 * So `approve` is 0 and anything else answered is 4, and only the non-answered
 * states fall through to the shared mapping.
 */
export function exitForApproval(q) {
  if (q.state === 'answered') {
    const value = (q.answer && (q.answer.value ?? q.answer.text)) || '';
    return value === 'approve' ? EXIT.OK : EXIT.CANCELLED;
  }
  return exitForState(q.state);
}

// Same split as printResolution: the decision goes to stdout so `$(...)` can
// capture it, every other outcome reports to stderr and leaves stdout empty.
export function printApproval(q) {
  if (q.state === 'answered') {
    const value = (q.answer && (q.answer.value ?? q.answer.text)) || '';
    process.stdout.write(`${stripControlChars(value)}\n`);
  } else {
    process.stderr.write(`pingroom: approval ${stripControlChars(q.state)}\n`);
  }
}

/** One readable line per incoming ping. */
export function formatIncoming(item) {
  const room = item?.room?.name || item?.room?.code || '?';
  const body = stripControlChars(item?.message ?? '');
  const marks = [];
  if (item?.correlation_id) marks.push(`corr=${stripControlChars(item.correlation_id)}`);
  if (item?.reply_to) marks.push(`reply_to=${stripControlChars(item.reply_to)}`);
  if (item?.question) marks.push('question');
  if (Array.isArray(item?.attachments) && item.attachments.length) {
    marks.push(`${item.attachments.length} attachment${item.attachments.length === 1 ? '' : 's'}`);
  }
  const suffix = marks.length ? `  (${marks.join(' · ')})` : '';
  return `[${stripControlChars(room)}] ${body}${suffix}`;
}

// Terminal wire states across both kinds. ack: open→acked|expired.
// question: pending→answered|expired|cancelled. `open`/`pending` are the only
// non-terminal states, so a wait loop against these always terminates.
export const HANDOFF_PENDING = new Set(['open', 'pending']);

// Map a terminal handoff state to an exit code. A `question` answered with ANY
// value is a success (0) — a negative human decision ('hold'/'deny') is NOT an
// infra failure. `acked` is likewise 0. `expired` is a distinct 3 so CI can
// branch; `cancelled` shares 4 with recipient_not_ready.
export function exitForHandoffState(state) {
  switch (state) {
    case 'acked': return EXIT.OK;
    case 'answered': return EXIT.OK;
    case 'expired': return EXIT.EXPIRED;
    case 'cancelled': return EXIT.CANCELLED;
    default: return EXIT.ERROR;
  }
}

// Print a machine-readable summary of a handoff: id, state, delivery-state, and
// the answer value / acked-by when present, one `key=value` per line to stdout.
export function printHandoff(h) {
  const lines = [`id=${stripControlChars(h.id ?? '')}`, `state=${stripControlChars(h.state ?? '')}`];
  if (h.delivery_state != null) lines.push(`delivery-state=${stripControlChars(h.delivery_state)}`);
  if (h.correlation_id) lines.push(`correlation-id=${stripControlChars(h.correlation_id)}`);
  if (h.state === 'answered') {
    const value = h.answer && (h.answer.value ?? h.answer.text) || '';
    lines.push(`answer=${stripControlChars(value)}`);
  }
  if (h.state === 'acked') {
    // The Handoff API returns a privacy-aware actor object. Only expose its id
    // in the machine-readable CLI/GitHub Action output; a redacted actor yields
    // an empty value instead of the unhelpful "[object Object]" string.
    const ackerId = h.acked_by && typeof h.acked_by === 'object'
      ? h.acked_by.id
      : h.acked_by;
    lines.push(`acked-by=${stripControlChars(ackerId ?? '')}`);
    if (h.acked_at) lines.push(`acked-at=${stripControlChars(h.acked_at)}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
