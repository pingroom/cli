import { once } from 'node:events';

import { EXIT } from '../constants.js';
import { fail, numberOption, sleep, waitOutPollFloor } from '../util.js';
import { commandHelp } from '../help.js';
import { apiDetail, describeTransportError, httpJson, retryAfterMs } from '../http.js';
import { agentContext } from '../config.js';
import { formatIncoming } from '../render.js';

// --- listen ----------------------------------------------------------------
//
// The inbound half. Everything else here talks; this is how an agent hears
// what the other members of its rooms send while it works, their replies to
// its structured pings included.
//
// The server leaves out everything sent as the connected account: the human's
// own pings and replies, this agent's sends, other agents on the same account,
// and webhook and scheduled pings in rooms the account owns (those go out as
// the owner). The connected human is heard through ask/watch instead.
//
// The server holds each request open until something arrives or the timeout
// elapses, so this is a long-poll, not a poll loop: an idle hour costs ~144
// requests, not one per second.

// Transient failures in a row before listen says so on stderr (once per outage).
const TRANSIENT_WARN_AFTER = 3;

// The feed route is throttled at 30 requests a minute per human, shared by every
// listener on the account. A round that ends early (a `--timeout` of 0 or 1,
// which the server answers at once, or a server ignoring the hold) is padded out
// to this, which is exactly that budget: 60 s / 30.
const LISTEN_ROUND_FLOOR_MS = 2000;

/** Cursor bookkeeping is the whole protocol: `after` in, `cursor` back. */
export async function listen(args) {
  if (args.help) { process.stdout.write(`${commandHelp('listen')}\n`); return EXIT.OK; }
  // `listen OPS123` is the same mistake as `listen --room OPS123`: the feed is
  // every room the connection covers, and nothing here takes a room.
  if (args._.length > 0) {
    fail('listen takes no arguments: it hears every room this connection covers (the API has no room filter)', EXIT.USAGE);
  }

  const { token, apiBase } = agentContext(args);
  const headers = { Authorization: `Bearer ${token}` };

  const timeout = numberOption(args.timeout, '--timeout', { min: 0, max: 30, integer: true }) ?? 25;
  const limit = numberOption(args.limit, '--limit', { min: 1, max: 100, integer: true }) ?? 50;

  let transientRun = 0;

  // One request to the feed, for the cursor handshake and the loop alike. A
  // transport error, a 429 or a 5xx is the API (or the network) having a bad
  // moment, so it is retried with backoff however many times it takes: `listen`
  // is a daemon, not a request, and the handshake used to give up on the very
  // blip the loop one request later rode out. The first sign of trouble is
  // silent; a run of failures is named on stderr, with the real cause. Anything
  // else that answers is returned for the caller to judge.
  async function fetchFeed(query, holdSeconds) {
    for (;;) {
      const { res, json, error, response } = await httpJson(
        'GET',
        `${apiBase}/api/agent/notifications/wait${query ? `?${query}` : ''}`,
        // The hold plus headroom: aborting at exactly the server's deadline would
        // race it and turn every quiet window into a client-side error.
        { headers, soft: true, signal: AbortSignal.timeout((holdSeconds + 10) * 1000) },
      );
      // `response` is the answer behind a body that was not JSON (soft mode
      // leaves `res` null for it); a proxy's 4xx page is as retryable as it ever was.
      const answered = res ?? response;
      if (!error && res.status !== 429 && res.status < 500) {
        transientRun = 0;
        return { res, json };
      }
      transientRun += 1;
      if (transientRun === TRANSIENT_WARN_AFTER) {
        const reason = answered ? `HTTP ${answered.status}` : describeTransportError(error);
        process.stderr.write(`pingroom: listen: PingRoom unavailable (${reason}); retrying\n`);
      }
      // retryAfterMs already clamps to 1-60 s, so a `Retry-After: 0` cannot
      // turn a rate limit into an immediate retry.
      const retryAfter = retryAfterMs(answered);
      // Geometric backoff so a real outage is not also a thundering herd.
      const backoff = Math.min(1000 * 2 ** Math.max(0, transientRun - 1), 30_000);
      await sleep(retryAfter ?? backoff);
    }
  }

  // No cursor means "from now": the server answers an empty `after` with the
  // head id and no rows, so starting up never replays history the agent has
  // already seen. `--from` opts into catching up from a known id instead.
  let cursor = args.from;
  if (!cursor) {
    const { res, json } = await fetchFeed('', 0);
    if (!res.ok) fail(`listen failed: ${apiDetail(res, json)}`);
    // A brand-new account with no pings at all has no head id. Nothing is
    // wrong; there is simply nothing to be after yet.
    cursor = typeof json?.cursor === 'string' ? json.cursor : '';
  }

  for (;;) {
    const started = Date.now();
    const query = new URLSearchParams({ timeout: String(timeout), limit: String(limit) });
    if (cursor) query.set('after', cursor);

    const { res, json } = await fetchFeed(query.toString(), timeout);
    if (!res.ok) fail(`listen failed: ${apiDetail(res, json)}`);

    const batch = Array.isArray(json?.notifications) ? json.notifications : [];
    for (const item of batch) {
      // Honour backpressure: a slow consumer on the other end of a pipe must
      // not let batches pile up in memory, only to be cut off if a later
      // fatal response ends the command.
      if (!process.stdout.write(args.json ? `${JSON.stringify(item)}\n` : `${formatIncoming(item)}\n`)) {
        await once(process.stdout, 'drain');
      }
    }
    // Advance only on a cursor the server actually returned, or a batch could be
    // replayed forever against a stale `after`.
    if (json && typeof json.cursor === 'string' && json.cursor) cursor = json.cursor;

    if (args.once) return EXIT.OK;
    // Nothing arrived, and possibly nothing was held for: never re-ask faster
    // than the route's budget allows.
    if (batch.length === 0) await waitOutPollFloor(started, LISTEN_ROUND_FLOOR_MS);
  }
}
