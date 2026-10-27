import { EXIT } from '../constants.js';
import { fail, numberOption, sleep } from '../util.js';
import { commandHelp } from '../help.js';
import { apiDetail, httpJson, retryAfterMs } from '../http.js';
import { agentContext } from '../config.js';
import { formatIncoming } from '../render.js';

// --- listen ----------------------------------------------------------------
//
// The inbound half. Everything else here talks; this is how an agent hears —
// replies to its own structured pings, a human's ping in a room it belongs to,
// anything landing while it works.
//
// The server holds each request open until something arrives or the timeout
// elapses, so this is a long-poll, not a poll loop: an idle hour costs ~144
// requests, not one per second.

/** Cursor bookkeeping is the whole protocol: `after` in, `cursor` back. */
export async function listen(args) {
  if (args.help) { process.stdout.write(`${commandHelp('listen')}\n`); return EXIT.OK; }

  const { token, apiBase } = agentContext(args);
  const headers = { Authorization: `Bearer ${token}` };

  const timeout = numberOption(args.timeout, '--timeout', { min: 0, max: 30, integer: true }) ?? 25;
  const limit = numberOption(args.limit, '--limit', { min: 1, max: 100, integer: true }) ?? 50;

  // No cursor means "from now": the server answers an empty `after` with the
  // head id and no rows, so starting up never replays history the agent has
  // already seen. `--from` opts into catching up from a known id instead.
  let cursor = args.from;
  if (!cursor) {
    const { res, json } = await httpJson('GET', `${apiBase}/api/agent/notifications/wait`, {
      headers,
      soft: true,
    });
    if (!res?.ok) fail(`listen failed: ${apiDetail(res, json)}`);
    cursor = json && json.cursor;
    if (!cursor) {
      // A brand-new account with no pings at all has no head id. Nothing is
      // wrong; there is simply nothing to be after yet.
      cursor = '';
    }
  }

  let transientRun = 0;

  for (;;) {
    const query = new URLSearchParams({ timeout: String(timeout), limit: String(limit) });
    if (cursor) query.set('after', cursor);

    const { res, json, error } = await httpJson(
      'GET',
      `${apiBase}/api/agent/notifications/wait?${query}`,
      // The hold plus headroom: aborting at exactly the server's deadline would
      // race it and turn every quiet window into a client-side error.
      { headers, soft: true, signal: AbortSignal.timeout((timeout + 10) * 1000) },
    );

    if (error || res.status === 429 || res.status >= 500) {
      transientRun += 1;
      // retryAfterMs already clamps to 1-60 s, so a `Retry-After: 0` cannot
      // turn a rate limit into an immediate retry.
      const retryAfter = res?.status === 429 ? retryAfterMs(res) : null;
      // Geometric backoff so a real outage is not also a thundering herd. The
      // loop is unbounded by design — `listen` is a daemon, not a request.
      const backoff = Math.min(1000 * 2 ** Math.max(0, transientRun - 1), 30_000);
      await sleep(retryAfter ?? backoff);
      continue;
    }

    if (!res.ok) fail(`listen failed: ${apiDetail(res, json)}`);
    transientRun = 0;

    const batch = Array.isArray(json?.notifications) ? json.notifications : [];
    for (const item of batch) {
      process.stdout.write(args.json ? `${JSON.stringify(item)}\n` : `${formatIncoming(item)}\n`);
    }
    // Advance only on a cursor the server actually returned, or a batch could be
    // replayed forever against a stale `after`.
    if (json && typeof json.cursor === 'string' && json.cursor) cursor = json.cursor;

    if (args.once) return EXIT.OK;
  }
}
