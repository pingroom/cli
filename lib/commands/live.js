import { EXIT } from '../constants.js';
import { fail, numberOption, parseDataObject, requireMaxLength } from '../util.js';
import { commandHelp } from '../help.js';
import { apiDetail, httpJson, requireSafeUrl } from '../http.js';
import { requireStoredCredentialOrigin, resolveApiBase, resolveRoom, resolveToken } from '../config.js';
import {
  buildLiveOptions, buildMetrics, buildSide, canonicalTemplate, LIVE_TEMPLATE_NAMES, LIVE_TEMPLATES,
  normalizeAccent,
} from '../render.js';

/**
 * Drive a live progress card on the room members' lock screen.
 *
 * One correlation id = one stream: `start` opens it (one alert), `update` moves
 * it silently, `end` closes it with one completion alert. Works with either an
 * agent token (--token, needs pingroom:live:write) or a room's incoming webhook
 * (--webhook), which speak the same `live_status` contract.
 */
export async function live(args) {
  if (args.help) { process.stdout.write(`${commandHelp('live')}\n`); return EXIT.OK; }
  const sub = args._[0];
  const known = ['start', 'update', 'end', 'get'];
  if (!sub || !known.includes(sub)) {
    fail(`live needs a subcommand: ${known.join(' | ')}`, EXIT.USAGE);
  }

  const correlationId = args.correlation_id;
  if (!correlationId) fail('--correlation-id is required', EXIT.USAGE);

  const webhook = args.webhook || process.env.PINGROOM_WEBHOOK_URL;
  const token = resolveToken(args);
  const apiBase = resolveApiBase(args);
  const room = resolveRoom(args);

  if (sub === 'get') {
    if (!token) fail('live get requires an agent token (--token or PINGROOM_TOKEN)', EXIT.USAGE);
    requireStoredCredentialOrigin(args, apiBase);
    if (!room) fail('--room is required', EXIT.USAGE);
    requireSafeUrl('--api', apiBase);
    const url = `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/live/${encodeURIComponent(correlationId)}`;
    const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
    if (args.json) process.stdout.write(`${text || '{}'}\n`);
    if (!res.ok) {
      fail(`read failed: ${apiDetail(res, json)}`);
    }
    if (!args.json) process.stdout.write(`${(json && json.state) || 'unknown'}\n`);
    return EXIT.OK;
  }

  const liveStatus = {
    state: sub === 'end' ? (args.failed ? 'failed' : 'done') : 'running',
  };

  // This live-status payload field has its own 256-character contract; ordinary
  // Ping bodies are 120 in private rooms and 160 in public rooms.
  requireMaxLength(args.message, 256, '--message');
  requireMaxLength(args.title, 40, '--title');
  requireMaxLength(args.prompt, 256, '--prompt');
  requireMaxLength(args.center, 40, '--center');
  if (args.message !== undefined) liveStatus.message = args.message;
  if (args.prompt !== undefined) liveStatus.prompt = args.prompt;

  const progress = numberOption(args.progress, '--progress', { min: 0, max: 1 });
  if (progress !== undefined) liveStatus.progress = progress;

  const step = numberOption(args.step, '--step', { min: 0, max: 8, integer: true });
  if (step !== undefined) liveStatus.current_step = step;

  const deadlineAt = numberOption(args.deadline_at, '--deadline-at', { min: 0, integer: true });
  if (deadlineAt !== undefined) liveStatus.deadline_at = deadlineAt;

  const durationSeconds = numberOption(args.duration_seconds, '--duration-seconds', { min: 1, max: 4102444800, integer: true });
  if (durationSeconds !== undefined) liveStatus.duration_seconds = durationSeconds;

  const etaAt = numberOption(args.eta_at, '--eta-at', { min: 0, integer: true });
  if (etaAt !== undefined) liveStatus.eta_at = etaAt;

  const metrics = buildMetrics(args.metric);
  if (metrics) liveStatus.metrics = metrics;

  const options = buildLiveOptions(args.option);
  if (options) {
    if (options.length > 4) fail('--option accepts at most 4 choices', EXIT.USAGE);
    liveStatus.options = options;
  }

  const left = buildSide(args.left, '--left');
  if (left) liveStatus.left = left;
  const right = buildSide(args.right, '--right');
  if (right) liveStatus.right = right;
  if (args.center !== undefined) liveStatus.center = args.center;

  const accent = normalizeAccent(args.accent_override);
  if (accent) liveStatus.accent_override = accent;

  // Template, category and step labels are fixed when the stream is created;
  // sending them on an update is a no-op server-side, so only `start` takes them.
  if (sub === 'start') {
    // Validated locally for the same reason --category is: a typo'd name is a
    // usage error, and letting it reach the server turns it into a 422 round
    // trip that reads like an outage.
    if (args.template) {
      const template = canonicalTemplate(args.template);
      if (!LIVE_TEMPLATES.includes(template)) {
        fail(`--template must be one of: ${LIVE_TEMPLATE_NAMES.join(', ')}`, EXIT.USAGE);
      }
      liveStatus.template = template;
    }
    // `alert` has no template equivalent and is the only way to start a stream
    // time-sensitive (breaking through Focus) without also demanding an ack.
    if (args.category) {
      if (!['status', 'steps', 'alert'].includes(args.category)) {
        fail('--category must be status, steps or alert', EXIT.USAGE);
      }
      liveStatus.category = args.category;
    }
    if (args.steps) {
      const labels = args.steps.split(',').map((s) => s.trim()).filter(Boolean);
      if (labels.length < 2 || labels.length > 8) {
        fail('--steps needs between 2 and 8 comma-separated labels', EXIT.USAGE);
      }
      liveStatus.steps = labels;
    }
  } else if (args.template || args.steps || args.category) {
    fail('--template, --category and --steps are fixed at stream creation; pass them to "live start"', EXIT.USAGE);
  }

  const body = { correlation_id: correlationId, live_status: liveStatus };
  if (args.title) body.title = args.title;
  if (args.action !== undefined) body.action = Number(args.action);
  // Same object-shape guard ping/ask/handoff use. A bare JSON.parse also accepts
  // an array, which the server then rejects — a wasted round trip for what is a
  // local usage error.
  // `!== undefined`, not truthiness: `-d ''` is a malformed value, and a
  // truthiness test drops it on the floor and ships the ping without the data
  // the caller believed they attached. ping/ask/handoff all reject it loudly.
  if (args.data !== undefined) body.data = parseDataObject(args.data);
  if (args.require_ack) body.requires_ack = true;
  const ackTimeout = numberOption(args.ack_timeout, '--ack-timeout', { min: 1, max: 86_400, integer: true });
  if (ackTimeout !== undefined) body.ack_timeout_seconds = ackTimeout;

  let result;
  if (webhook) {
    requireSafeUrl('--webhook', webhook);
    result = await httpJson('POST', webhook, { body });
  } else if (token) {
    requireStoredCredentialOrigin(args, apiBase);
    if (!room) fail('--room is required when using --token (or set one with "pingroom config set default_room <code>")', EXIT.USAGE);
    requireSafeUrl('--api', apiBase);
    const url = `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/live`;
    result = await httpJson('POST', url, { body, headers: { Authorization: `Bearer ${token}` } });
  } else {
    fail('provide a webhook (--webhook / PINGROOM_WEBHOOK_URL) or an agent token (--token / PINGROOM_TOKEN, or run "pingroom" to connect)', EXIT.USAGE);
  }

  const { res, text, json } = result;
  if (args.json) process.stdout.write(`${text || '{}'}\n`);

  if (!res.ok || (json && json.success === false)) {
    const detail = apiDetail(res, json);
    fail(`live ${sub} failed: ${detail}`);
  }

  if (!args.json) {
    const state = (json && (json.state || (json.live_status && json.live_status.state))) || sub;
    process.stdout.write(`live ${sub} → ${state} ✅\n`);
  }
  return EXIT.OK;
}
