// Connecting: QR pairing, the email fallback, Agent Inbox activation, and the
// bare `pingroom` status/prompt. Everything a human touches once and then never
// thinks about again.

import { EXIT } from '../constants.js';
import {
  fail, isInteractive, isJsonObject, isNonEmptyString, isNullableString, sleep, stripControlChars,
} from '../util.js';
import { HELP, commandHelp } from '../help.js';
import { apiDetail, httpJson, requireSafeUrl, retryAfterMs } from '../http.js';
import {
  credentialsPath, readStoredCredential, requireStoredCredentialOrigin, resolveApiBase,
  resolveRoom, saveCredential,
} from '../config.js';
import { CLI_SCOPES } from '../scopes.js';

// --- connecting (pairing + email fallback) ---------------------------------
//
// Wire contract: AGENT_PAIRING_SPEC.md. The shape is deliberately one gesture —
// scanning the QR is where the human picks BOTH the account and the delivery
// room, so an agent can never end up connected with nobody's say-so about where
// it pings. There is no `login` subcommand: `pingroom` resolves the state.

// What the human reads on the approval screen. A product name, not a package
// id: the phone shows it verbatim ("PingRoom CLI wants to connect").
const AGENT_LABEL = 'PingRoom CLI';
// One NDJSON record per line on stdout, for `pair --json`. `listen --json`
// already established the shape: a daemon reads stdout line by line, so nothing
// else may be written there while it is on.
function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
// A connect command should prove the phone round-trip, but it must not hold a
// terminal for the onboarding Question's full 24-hour server TTL. The Question
// remains answerable after this local deadline and the credential is already
// durable before the wait begins.
const ACTIVATION_MAX_WAIT_MS = 2 * 60 * 1000;
// The wait route is limited to 30 requests/minute. Keep immediate pending or
// answered-without-completion observations safely below that ceiling while a
// mixed-version or commit-propagation race is still being reconciled.
const ACTIVATION_MIN_POLL_INTERVAL_MS = 2100;

function activationMaxWaitMs() {
  // Keep production fixed at two minutes. The guarded override lets the real
  // subprocess tests exercise deadline behavior without holding the suite for
  // two minutes; it is ignored outside NODE_ENV=test.
  if (process.env.NODE_ENV === 'test') {
    const testValue = Number(process.env.PINGROOM_INTERNAL_ACTIVATION_TIMEOUT_MS);
    if (Number.isInteger(testValue) && testValue > 0 && testValue <= ACTIVATION_MAX_WAIT_MS) {
      return testValue;
    }
  }
  return ACTIVATION_MAX_WAIT_MS;
}

// Widest QR we render (compact half-block form of a ~110-char pair URL is 39
// columns). Anything narrower would wrap and become unscannable, so we print
// the URL alone instead of a broken QR.
const QR_MIN_COLUMNS = 41;

/**
 * Draw the pair URL as a scannable QR. Returns false when it could not — a too
 * narrow terminal, or the optional dependency being absent (someone vendored
 * just bin/) — and the caller falls back to the printed URL, which always works.
 */
async function renderQr(url) {
  // A real terminal reports its width on the stream; COLUMNS covers the rest.
  // Unknown width is treated as wide enough — the URL is printed either way.
  const columns = Number(process.stdout.columns || process.env.COLUMNS || 0);
  if (columns > 0 && columns < QR_MIN_COLUMNS) return false;

  let qr;
  try {
    const mod = await import('qrcode-terminal');
    qr = mod.default || mod;
  } catch { return false; }
  if (!qr || typeof qr.generate !== 'function') return false;

  try {
    let art = '';
    // Call it as a method: qrcode-terminal reads its error-correction level off
    // `this`, so a detached `generate` reference silently builds a version-1
    // code and throws on anything longer than a few characters.
    // `small` is the half-block form: two module rows per text row, so the code
    // stays square-ish and fits an 80-column terminal.
    qr.generate(url, { small: true }, (rendered) => { art = rendered; });
    if (!art) return false;
    process.stdout.write(`\n${art}\n`);
    return true;
  } catch { return false; }
}

/**
 * New servers split the browser approval page from the native universal link.
 * The printed URL remains `pair_url`; only the QR prefers `pair_qr_url` so a
 * shipped PingRoom app can intercept it without forcing older servers to
 * implement the additive field.
 */
export function pairingQrUrl(pairing) {
  const pairUrl = stripControlChars(pairing?.pair_url ?? '');
  const candidate = typeof pairing?.pair_qr_url === 'string'
    ? stripControlChars(pairing.pair_qr_url)
    : '';

  return candidate.trim() === '' ? pairUrl : candidate;
}

/**
 * A line-at-a-time reader over stdin.
 *
 * Deliberately not node:readline: its Interface keeps consuming while we are
 * awaiting an HTTP round trip between two questions and drops the lines nobody
 * is listening for, which silently loses piped answers. This queues every line
 * instead, so the answers can arrive in one blob or one keystroke at a time.
 *
 * ask() resolves `null` — never a string — once the input is closed, so it can
 * never be confused with a real empty line. That distinction is load-bearing:
 * callers treat an empty line as "take the default", and a caller that reads EOF
 * as an empty line will take that default again on the next question, and the
 * next, forever, because nothing will ever arrive to change its mind. Callers
 * that genuinely want the empty-line behaviour opt in with `?? ''`.
 */
function createPrompter() {
  const queued = [];
  const waiting = [];
  let buffer = '';
  let closed = false;

  const deliver = (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else queued.push(line);
  };
  const onData = (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      deliver(buffer.slice(0, idx).replace(/\r$/, ''));
      buffer = buffer.slice(idx + 1);
    }
  };
  const onEnd = () => {
    if (closed) return;
    closed = true;
    if (buffer) { deliver(buffer); buffer = ''; }
    while (waiting.length) waiting.shift()(null);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  process.stdin.once('end', onEnd);
  process.stdin.resume();

  return {
    ask(question) {
      process.stdout.write(question);
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => { waiting.push(resolve); });
    },
    close() {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
    },
  };
}

/** POST /api/agent/auth — anonymous registration, yields the pre-claim credential. */
async function registerAnonymous(apiBase) {
  const { res, json } = await httpJson('POST', `${apiBase}/api/agent/auth`, {
    body: { type: 'anonymous', agent_label: AGENT_LABEL, scopes: CLI_SCOPES },
  });
  if (!res.ok || !json || typeof json.credential !== 'string') {
    const detail = apiDetail(res, json);
    fail(`could not start a connection: ${detail}`);
  }
  return json.credential;
}

/**
 * "✓ Connected as @agt_ab12 → #Project X" — the room half is omitted if unknown,
 * and widened to "→ all rooms" / "→ #Project X +2 more" when the human granted
 * this agent more than the one delivery room.
 */
function connectedLine(cred) {
  const who = cred.handle ? `@${cred.handle}` : 'this machine';
  const room = cred.room && (cred.room.name || cred.room.invite_code);
  const access = cred.room_access ?? cred.roomAccess;

  if (access === 'all') return `✓ Connected as ${who} → all rooms`;

  if (!room) return `✓ Connected as ${who}`;

  const extra = Math.max(0, (Array.isArray(cred.rooms) ? cred.rooms.length : 0) - 1);
  return `✓ Connected as ${who} → #${room}${extra > 0 ? ` +${extra} more` : ''}`;
}

function activationFailureDetail(result) {
  if (result.error) return result.error.message;
  const status = result.res ? `HTTP ${result.res.status}` : 'request failed';
  return (result.json && (result.json.message || result.json.error || result.json.code)) || status;
}

function validateActivationEnsure(json) {
  const room = json?.room;
  const question = json?.question;
  const validState = question?.state === 'pending'
    || question?.state === 'answered'
    || question?.state === 'expired'
    || question?.state === 'cancelled';
  if (
    !isJsonObject(json)
    || json.onboarded !== true
    || typeof json.replayed !== 'boolean'
    || !isJsonObject(room)
    || !isNonEmptyString(room.id)
    || typeof room.name !== 'string'
    || !isNonEmptyString(room.invite_code)
    || typeof room.is_agent_inbox !== 'boolean'
    || !isJsonObject(question)
    || !isNonEmptyString(question.id)
    || question.kind !== 'question'
    || !isNonEmptyString(question.prompt)
    || !Array.isArray(question.options)
    || question.options.some((option) => (
      !isJsonObject(option)
      || !isNonEmptyString(option.value)
      || !isNonEmptyString(option.label)
    ))
    || !validState
    || !isNullableString(question.expires_at)
    || !isNullableString(question.created_at)
  ) {
    return { error: 'PingRoom returned an incomplete Agent Inbox ensure response' };
  }
  return { question };
}

function validateActivationWait(json, questionId) {
  const state = json?.state;
  const validState = state === 'pending' || state === 'answered' || state === 'expired' || state === 'cancelled';
  if (
    !isJsonObject(json)
    || !isNonEmptyString(json.id)
    || json.id !== questionId
    || json.kind !== 'question'
    || !validState
    || (json.activation_completed !== undefined && typeof json.activation_completed !== 'boolean')
    || (state !== 'answered' && json.activation_completed === true)
  ) {
    return { error: 'PingRoom returned a mismatched Agent Inbox wait response' };
  }

  if (state === 'answered') {
    const answer = json.answer;
    const responder = answer?.responder;
    if (
      !isJsonObject(answer)
      || !isNullableString(answer.value)
      || !isNullableString(answer.label)
      || !isNullableString(answer.text)
      || (!isNonEmptyString(answer.value) && !isNonEmptyString(answer.text))
      || !isNullableString(answer.answered_at)
      || (responder !== null && !isJsonObject(responder))
      || (isJsonObject(responder)
        && (!isNullableString(responder.id) || !isNullableString(responder.display_name)))
    ) {
      return { error: 'PingRoom returned an answered activation without a valid answer' };
    }
  } else if (json.answer !== undefined && json.answer !== null) {
    return { error: 'PingRoom returned an answer for an unresolved activation' };
  }

  return { value: json };
}

function activationRetryDelay(result, transientRun, deadline) {
  const fromHeader = result.res?.status === 429 ? retryAfterMs(result.res) : null;
  const fallback = Math.min(1000 * 2 ** Math.max(0, transientRun - 1), 10_000);
  return Math.max(0, Math.min(fromHeader ?? fallback, deadline - Date.now()));
}

function activationIncomplete(detail, instruction = 'Run "pingroom activate" to retry with this saved connection.') {
  const safeDetail = detail ? `: ${stripControlChars(detail)}` : '';
  process.stdout.write(`  Agent Inbox activation is not complete${safeDetail}\n`);
  process.stdout.write('  Your connection is saved and usable.\n');
  process.stdout.write(`  ${instruction}\n`);
}

/**
 * Prove the freshly paired credential can complete a human round-trip. This is
 * intentionally best-effort: saveCredential() has already committed the active
 * bearer atomically, so no activation outage can roll back or corrupt it.
 */
async function activateInboxAfterPairing(cred) {
  const headers = { Authorization: `Bearer ${cred.token}` };
  const overallDeadline = Date.now() + activationMaxWaitMs();
  process.stdout.write('  Sending a test question to PingRoom…\n');

  let ensured;
  let ensureTransientRun = 0;
  while (Date.now() < overallDeadline) {
    ensured = await httpJson('POST', `${cred.apiBase}/api/agent/inbox/ensure`, {
      body: {},
      headers,
      soft: true,
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, overallDeadline - Date.now()))),
    });
    const transient = ensured.error || ensured.res?.status === 429 || ensured.res?.status >= 500;
    if (!transient) break;
    ensureTransientRun += 1;
    await sleep(activationRetryDelay(ensured, ensureTransientRun, overallDeadline));
  }

  if (!ensured.res?.ok) {
    const detail = Date.now() >= overallDeadline
      ? 'the two-minute activation deadline elapsed while PingRoom was unavailable'
      : activationFailureDetail(ensured);
    activationIncomplete(detail);
    return false;
  }

  const ensureEnvelope = validateActivationEnsure(ensured.json);
  if (ensureEnvelope.error) {
    activationIncomplete(ensureEnvelope.error);
    return false;
  }
  const { question } = ensureEnvelope;

  process.stdout.write('  Answer “PingRoom connected. Can you answer this?” on your phone.\n');
  // The server stamp, not the terminal state by itself, is the activation
  // authority. A terminal answer without the stamp cannot become a valid
  // receipt-before-answer sequence later, so fail clearly instead of polling a
  // state the server intentionally will not rewrite.
  const deadline = overallDeadline;
  let transientRun = 0;

  while (Date.now() < deadline) {
    const pollStartedAt = Date.now();
    const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const hold = Math.min(20, remainingSeconds);
    const waited = await httpJson(
      'GET',
      `${cred.apiBase}/api/agent/handoffs/${encodeURIComponent(question.id)}/wait?timeout=${hold}`,
      {
        headers,
        soft: true,
        signal: AbortSignal.timeout(Math.max(1, Math.min(
          hold * 1000 + 10_000,
          deadline - Date.now(),
        ))),
      },
    );

    const transient = waited.error || waited.res?.status === 429 || waited.res?.status >= 500;
    if (transient) {
      transientRun += 1;
      const retryDelay = activationRetryDelay(waited, transientRun, deadline);
      const cadenceDelay = ACTIVATION_MIN_POLL_INTERVAL_MS - (Date.now() - pollStartedAt);
      await sleep(Math.max(0, Math.min(Math.max(retryDelay, cadenceDelay), deadline - Date.now())));
      continue;
    }
    transientRun = 0;

    if (!waited.res?.ok) {
      activationIncomplete(activationFailureDetail(waited));
      return false;
    }

    const waitEnvelope = validateActivationWait(waited.json, question.id);
    if (waitEnvelope.error) {
      activationIncomplete(waitEnvelope.error);
      return false;
    }
    const resolved = waitEnvelope.value;
    const state = resolved.state;
    if (state === 'answered') {
      if (resolved.activation_completed !== true) {
        activationIncomplete(
          'the test question was answered without verified phone receipt before the answer',
          'Update the PingRoom app if needed, then run "pingroom activate" to send a fresh test with this saved connection.',
        );
        return false;
      }
      const answer = resolved.answer.text || resolved.answer.label || resolved.answer.value;
      process.stdout.write(`✓ Test question answered (${stripControlChars(answer)}). Agent Inbox is ready.\n`);
      return true;
    }
    if (state === 'expired' || state === 'cancelled') {
      activationIncomplete(
        `the test question ${state}`,
        'Run "pingroom activate" to send a fresh test with this saved connection.',
      );
      return false;
    }
    // `pending` at the bounded hold timeout — continue at a throttle-safe
    // cadence until the local/server deadline.
    const cadenceDelay = ACTIVATION_MIN_POLL_INTERVAL_MS - (Date.now() - pollStartedAt);
    await sleep(Math.max(0, Math.min(cadenceDelay, deadline - Date.now())));
  }

  activationIncomplete(
    'still waiting for the test answer at the activation deadline',
  );
  return false;
}

/** Retry activation only for the durable credential created by QR pairing. */
export async function activateStoredInbox(args) {
  if (args.help) { process.stdout.write(`${commandHelp('activate')}\n`); return EXIT.OK; }
  if (args._.length > 0) fail('usage: pingroom activate', EXIT.USAGE);
  if (args.token !== undefined) {
    fail('pingroom activate uses the saved QR-paired credential; remove --token', EXIT.USAGE);
  }
  const unsupported = Object.keys(args).filter((key) => !['_', 'help', 'api', 'token'].includes(key));
  if (unsupported.length > 0) {
    fail('usage: pingroom activate [--api <url>]', EXIT.USAGE);
  }

  const credential = readStoredCredential();
  if (!credential) {
    fail('no saved QR-paired credential; run "pingroom" in an interactive terminal first', EXIT.USAGE);
  }
  if (!credential.room || !isNonEmptyString(credential.room.invite_code)) {
    // Granting every room is a valid answer that pins no destination, so the
    // fix there is picking one — not pairing again, which would only offer the
    // same choice back.
    fail(
      credential.room_access === 'all'
        ? 'this agent was granted all rooms but no delivery room; pick one in the PingRoom app under Connected Agents, then run "pingroom activate" again'
        : 'the saved credential has no QR-selected delivery room; reconnect with QR pairing before running "pingroom activate"',
      EXIT.USAGE,
    );
  }
  if (!Array.isArray(credential.scopes) || !credential.scopes.includes('pingroom:handoffs:create')) {
    fail('the saved credential lacks pingroom:handoffs:create; reconnect with QR pairing before running "pingroom activate"', EXIT.USAGE);
  }

  const apiBase = resolveApiBase(args);
  requireSafeUrl('--api', apiBase);
  if (!isNonEmptyString(credential.api_url)) {
    fail('the saved QR-paired credential has no trusted API origin; pair again before running "pingroom activate"', EXIT.USAGE);
  }
  let credentialOrigin;
  let targetOrigin;
  try {
    credentialOrigin = new URL(credential.api_url).origin;
    targetOrigin = new URL(apiBase).origin;
  } catch {
    fail('the saved QR-paired credential has an invalid API origin; pair again', EXIT.USAGE);
  }
  if (credentialOrigin !== targetOrigin) {
    fail(`stored credential is bound to ${credentialOrigin}; refusing to send it to ${targetOrigin}`, EXIT.USAGE);
  }
  process.stdout.write(`${connectedLine(credential)}\n`);

  const completed = await activateInboxAfterPairing({
    ...credential,
    apiBase,
  });
  return completed ? EXIT.OK : EXIT.ERROR;
}

/**
 * The QR path. Mints a pre-claim credential, asks the server for a pairing
 * token, renders it, then polls until the human approves. Returns a credential
 * object, or null when the pairing lapsed and the user declined a fresh one.
 */
async function connectByPairing(apiBase, ask, { qr = true, json: jsonOut = false } = {}) {
  for (;;) {
    const preClaim = await registerAnonymous(apiBase);
    const headers = { Authorization: `Bearer ${preClaim}` };

    const start = await httpJson('POST', `${apiBase}/api/agent/auth/pair/start`, {
      body: { scopes: CLI_SCOPES },
      headers,
    });
    if (!start.res.ok || !start.json || typeof start.json.pair_url !== 'string') {
      const detail = (start.json && (start.json.message || start.json.error || start.json.code))
        || `HTTP ${start.res.status}`;
      fail(`could not start pairing: ${detail}`);
    }

    // The URL is server-controlled and goes straight to the terminal, so strip
    // C0/C1 controls: an --api / config api_url pointing at a hostile host could
    // otherwise emit ANSI escapes that repaint or hide the line the user is
    // about to trust with their account.
    const pairUrl = stripControlChars(start.json.pair_url);
    const qrUrl = pairingQrUrl(start.json);
    // 900s is the server's pre-claim lifetime; never poll past it, and clamp the
    // server's suggested interval so a bad value can't busy-loop or stall.
    // The 1000ms floor is not cosmetic: AGENT_PAIRING_SPEC.md throttles
    // pair/status at `60,1`, so a faster floor spends the pairing window
    // collecting 429s instead of the approval.
    const lifetimeMs = Math.max(1, Number(start.json.expires_in) || 900) * 1000;
    const intervalMs = Math.min(Math.max(Number(start.json.poll_interval_ms) || 1500, 1000), 10_000);
    const startedAt = Date.now();
    const deadline = startedAt + lifetimeMs;

    // `qr: false` (headless) forces the QR off rather than leaning on COLUMNS:
    // an unset width reads as "wide enough" in renderQr, so a daemon with no
    // terminal would otherwise get block art written into its log pipe.
    const drew = qr ? await renderQr(qrUrl) : false;
    if (jsonOut) {
      writeEvent({
        event: 'pair_url',
        pair_url: pairUrl,
        expires_in: Math.round(lifetimeMs / 1000),
        poll_interval_ms: intervalMs,
      });
    } else {
      process.stdout.write(`${drew ? '  Or open' : '  Open'}: ${pairUrl}\n`);
      process.stdout.write('  Waiting for approval… ');
    }

    // A transient failure must not end a wait the human is mid-way through.
    // Network errors, 5xx and 429 are the load balancer / rate limiter talking,
    // not the pairing being over; hard-failing on the first one throws away the
    // whole 15 minutes over a single blip. 401/403/404 still exit immediately —
    // those say the pre-claim is gone, and retrying can only spin.
    // The `Date.now() < deadline` bound is what keeps a *persistent* outage from
    // retrying forever: it ends at the same moment a clean poll would have.
    let transientRun = 0;
    let lastTransient = null;
    let warnedTransient = false;

    while (Date.now() < deadline) {
      const { res, json, error } = await httpJson(
        'GET', `${apiBase}/api/agent/auth/pair/status`, { headers, soft: true },
      );

      if (error || res.status >= 500 || res.status === 429) {
        transientRun += 1;
        lastTransient = error
          ? error.message
          : `HTTP ${res.status}`;
        // Say something rather than sitting mute: a user watching a QR with no
        // output cannot tell a slow approval from a broken endpoint.
        if (transientRun === 3 && !warnedTransient) {
          warnedTransient = true;
          // stdout stays pure NDJSON in json mode, so progress chatter goes to
          // stderr, where a daemon's log still shows it.
          if (jsonOut) process.stderr.write(`pingroom: still trying — ${lastTransient}\n`);
          else process.stdout.write(`\n  (still trying — ${lastTransient}) `);
        }
        // Ride out a short blip at the normal cadence, then back off
        // geometrically so a real outage is not also a thundering herd. Never
        // sleep past the deadline this loop is bounded by.
        const backoff = Math.min(intervalMs * 2 ** Math.max(0, transientRun - 3), 30_000);
        await sleep(Math.max(0, Math.min(backoff, deadline - Date.now())));
        continue;
      }

      transientRun = 0;

      // A 401/403/404 is terminal either way — retrying can only spin — but it
      // means two different things depending on WHEN it lands, and the user
      // needs to be told the right one.
      //
      // Late: the pre-claim credential this loop authenticates with has the
      // same 900s TTL as the pairing token (agent_auth.ttl), so once the window
      // is mostly gone an unapproved pairing 401s instead of returning
      // {"status":"expired"}. That is the ordinary "nobody tapped it" ending,
      // and reporting it as an auth error sent people to fix a credential that
      // was working fine (observed live 2026-09-02).
      //
      // Early: the credential was minted seconds ago, so a rejection means the
      // request is genuinely wrong — a bad --api, a server that is not
      // PingRoom. Calling that "expired" would hide a real fault behind a
      // retry the user can never win.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        if (Date.now() - startedAt >= lifetimeMs / 2) break;
        if (!jsonOut) process.stdout.write('\n');
        fail(`pairing failed: ${apiDetail(res, json)}`);
      }

      if (!res.ok) {
        if (!jsonOut) process.stdout.write('\n');
        const detail = apiDetail(res, json);
        fail(`pairing failed: ${detail}`);
      }
      const status = json && json.status;
      if (status === 'active') {
        // A server that says "active" with no credential has not paired us.
        // Without this, `token: undefined` is written to credentials.json and
        // every later command reads a credential file that exists but cannot
        // authenticate — a far more confusing failure than stopping here.
        if (typeof json.credential !== 'string' || json.credential === '') {
          if (!jsonOut) process.stdout.write('\n');
          fail('pairing succeeded but the server returned no credential');
        }
        const cred = {
          token: json.credential,
          handle: json.handle,
          room: json.room,
          rooms: Array.isArray(json.rooms) ? json.rooms : [],
          roomAccess: typeof json.room_access === 'string' ? json.room_access : null,
          account: json.account,
          scopes: json.scopes,
          apiBase,
        };
        saveCredential(cred);
        if (jsonOut) {
          // No token: this line lands in daemon logs. Everything here is
          // already visible to the human who just approved the pairing.
          writeEvent({
            event: 'connected',
            handle: cred.handle ?? null,
            room: cred.room ?? null,
            room_access: cred.roomAccess,
            rooms: cred.rooms,
            scopes: cred.scopes ?? [],
            api_url: apiBase,
          });
        } else {
          process.stdout.write(`${connectedLine(cred)}\n`);
        }
        // Connecting deliberately sends nothing to the human's phone. The
        // approval they just tapped IS the round-trip; a test Question on top of
        // it was one more thing to answer before the tool could be used, and it
        // made a healthy connection look broken whenever the answer was slow.
        // `pingroom activate` still sends one for anyone who wants the proof.
        return cred;
      }
      if (status === 'expired') break;
      // `pending` (or anything unrecognized) — keep waiting.
      await sleep(intervalMs);
    }

    if (jsonOut) {
      writeEvent({
        event: 'expired',
        reason: transientRun > 0 ? 'server_unavailable' : 'expired',
        last_error: lastTransient,
      });
    } else if (transientRun > 0) {
      process.stdout.write(`\n  Gave up waiting — the server kept failing (last: ${lastTransient}).\n`);
    } else {
      process.stdout.write(`\n  That code expired.\n`);
    }

    // `null` means the input is closed, and that is the whole point of this
    // guard. Reading EOF as "" would fall through the y/yes test below (empty
    // means "take the default: yes"), restart the for(;;), mint another
    // anonymous registration, and do it again — a Ctrl-D or a piped stdin turns
    // a single pairing attempt into thousands of registrations against the API.
    // `ask === null` is the headless contract: one round, no prompt, no retry.
    // Distinct from ask() returning null at EOF just below — both stop here,
    // and neither may loop the for(;;) into minting more registrations.
    if (!ask) return null;

    const again = await ask('  Show a fresh QR code? [Y/n]: ');
    if (again === null) { process.stdout.write('\n'); return null; }
    const answer = again.trim().toLowerCase();
    if (answer && answer !== 'y' && answer !== 'yes') return null;
  }
}

/**
 * The email fallback, over the unchanged claim/* endpoints: the server mails a
 * link, the web page shows a 6-digit code, the user reads it back here.
 */
async function connectByEmail(apiBase, ask) {
  const preClaim = await registerAnonymous(apiBase);
  const headers = { Authorization: `Bearer ${preClaim}` };

  // `?? ''` preserves the old EOF behaviour deliberately: ask() now returns null
  // at EOF, and without the coalesce this would throw a TypeError on `.trim()`
  // instead of reaching the "this is required" error the user should see.
  const email = (await ask('  Your PingRoom email: ') ?? '').trim();
  if (!email) fail('an email address is required', EXIT.USAGE);

  const start = await httpJson('POST', `${apiBase}/api/agent/auth/claim/start`, {
    body: { email },
    headers,
  });
  if (!start.res.ok) {
    const detail = (start.json && (start.json.message || start.json.error || start.json.code))
      || `HTTP ${start.res.status}`;
    fail(`could not send the email: ${detail}`);
  }

  process.stdout.write('  Sent. Open the link in that email — the page shows a 6-digit code.\n');

  // A mistyped code is the common case, so allow a few tries before giving up.
  // The server locks the registration out after its own attempt cap anyway.
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Same reason as the email prompt: EOF stays an empty answer, which the
    // server rejects, rather than a TypeError on null.
    const otp = (await ask('  Code: ') ?? '').trim();
    const done = await httpJson('POST', `${apiBase}/api/agent/auth/claim/complete`, {
      body: { email, otp },
      headers,
    });
    if (done.res.ok && done.json && typeof done.json.credential === 'string') {
      const cred = {
        token: done.json.credential,
        handle: done.json.handle,
        // claim/complete carries no room — the email flow does not choose one.
        room: done.json.room,
        account: done.json.account,
        scopes: done.json.scopes,
        apiBase,
      };
      saveCredential(cred);
      process.stdout.write(`${connectedLine(cred)}\n`);
      if (!cred.room) {
        process.stdout.write('  For room commands: pingroom config set default_room <invite code>\n');
        process.stdout.write('  For private Inbox/Handoff delivery, reconnect with QR pairing.\n');
      }
      return cred;
    }
    const detail = (done.json && (done.json.message || done.json.error || done.json.code))
      || `HTTP ${done.res.status}`;
    if (attempt === 3) fail(`could not connect: ${detail}`);
    process.stderr.write(`pingroom: ${detail}\n`);
  }
  return null;
}

/**
 * Resolve the unconnected state interactively. Refuses outright when there is no
 * TTY — a hung prompt in CI is worse than a clean failure, and the fix there is
 * PINGROOM_TOKEN, not a QR nobody can scan.
 */
export async function connect(args) {
  if (!isInteractive()) {
    fail(
      'not connected, and this is not an interactive terminal. Set PINGROOM_TOKEN (CI, pipes), run "pingroom pair" to pair without a terminal, or run "pingroom" from a terminal.',
      EXIT.USAGE,
    );
  }

  const apiBase = resolveApiBase(args);
  requireSafeUrl('--api', apiBase);

  const prompter = createPrompter();
  const ask = (question) => prompter.ask(question);
  try {
    process.stdout.write('  Not connected. How do you want to connect?\n');
    process.stdout.write('    1) Scan a QR code with the PingRoom app\n');
    process.stdout.write('    2) Email me a code\n');
    // EOF here means "no answer", which is what the default already covers, so
    // coalesce rather than crash on null — the pairing branch below is the one
    // that must distinguish EOF, and it does.
    const choice = (await ask('  Choose [1]: ') ?? '').trim();
    if (choice && choice !== '1' && choice !== '2') {
      process.stderr.write('pingroom: choose 1 or 2\n');
      return EXIT.USAGE;
    }

    const cred = choice === '2'
      ? await connectByEmail(apiBase, ask)
      : await connectByPairing(apiBase, ask);

    return cred ? EXIT.OK : EXIT.EXPIRED;
  } finally {
    prompter.close();
  }
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
    process.stdout.write(`${connectedLine(stored)}\n`);
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

// --- reconnect --------------------------------------------------------------

/**
 * Re-pair an existing connection so it carries the scopes this CLI version
 * needs. Ordered so that any failure is a no-op:
 *
 *   1. the old credential stays in place and keeps working throughout;
 *   2. the human approves a NEW pairing — a separate registration, since the
 *      server puts no uniqueness on user_id, so both are live at once;
 *   3. the new credential is written atomically (temp file + rename);
 *   4. only THEN is the old one revoked.
 *
 * Cancelling, Ctrl-C, or any error before step 3 leaves the machine exactly as
 * it was. Revocation is last and best-effort on purpose: a crash between the
 * rename and the revoke leaves a stale-but-harmless registration the human can
 * remove from Connected Agents, whereas the reverse order would leave a working
 * credentials file holding a dead token.
 *
 * This is NOT `logout && pingroom`. `logout` only unlinks the local file; the
 * server-side credential stays active forever, so that sequence leaks a live
 * credential every time.
 */
export async function reconnect(args) {
  if (args.help) { process.stdout.write(`${commandHelp('reconnect')}\n`); return EXIT.OK; }

  // An env token is not ours to replace: it was pasted here from somewhere else
  // (a CI secret, a password manager), the same registration is probably in use
  // on other machines, and revoking it would break all of them from a terminal
  // whose owner may not even know. Refuse rather than guess.
  if (process.env.PINGROOM_TOKEN) {
    fail(
      'PINGROOM_TOKEN is set, and reconnect would revoke whatever credential it names.\n'
      + '  Unset it and run "pingroom reconnect" against the stored credential, or re-pair\n'
      + '  from scratch with "pingroom" and update the token where it is configured.',
      EXIT.USAGE,
    );
  }

  const stored = readStoredCredential();
  if (!stored) {
    fail(`not connected — there is no credential in ${credentialsPath()} to replace. Run "pingroom" to pair.`, EXIT.USAGE);
  }

  if (!isInteractive()) {
    fail('reconnect needs an interactive terminal to show the QR code. Run "pingroom pair" instead — it prints the approval link and waits.', EXIT.USAGE);
  }

  const apiBase = resolveApiBase(args);
  requireSafeUrl('--api', apiBase);
  // The stored credential is about to be sent to `apiBase` in the revoke below,
  // so it is bound by the same origin rule every other stored-bearer command
  // obeys. Without this, `--api` (or a stale config.json api_url) redirects a
  // live production credential to an arbitrary host.
  requireStoredCredentialOrigin(args, apiBase);

  printReplaceNotice();

  const prompter = createPrompter();
  const ask = (question) => prompter.ask(question);
  let cred;
  try {
    cred = await connectByPairing(apiBase, ask);
  } finally {
    prompter.close();
  }

  // Declined, expired, or the user closed stdin: nothing was written, so the old
  // credential is still the one on disk and still valid.
  if (!cred) {
    process.stdout.write('  Kept your current connection.\n');
    return EXIT.EXPIRED;
  }

  return revokePrevious(apiBase, stored);
}

/**
 * Step 4 of the reconnect contract, shared with `pair`: revoke the credential
 * the new one replaces, using the OLD bearer.
 *
 * Only ever called after connectByPairing has already written the replacement,
 * so a failure here is untidy rather than dangerous — it leaves a stale-but-
 * harmless registration the human can remove from Connected Agents, which is
 * why it returns EXIT.OK either way.
 */
async function revokePrevious(apiBase, stored, { json: jsonOut = false } = {}) {
  const { res, json, error } = await httpJson('POST', `${apiBase}/api/agent/auth/revoke`, {
    headers: { Authorization: `Bearer ${stored.token}` },
    body: {},
    soft: true,
  });
  if (error || !res || !res.ok) {
    const detail = error ? error.message : apiDetail(res, json);
    if (jsonOut) {
      writeEvent({ event: 'previous_connection', revoked: false, detail });
    } else {
      process.stdout.write(`  Note: the previous connection could not be revoked (${detail}).\n`);
      process.stdout.write('  Remove it from PingRoom → Settings → Connected Agents when convenient.\n');
    }
    return EXIT.OK;
  }

  if (jsonOut) writeEvent({ event: 'previous_connection', revoked: true });
  else process.stdout.write('  Previous connection revoked.\n');
  return EXIT.OK;
}

/** The four lines a human sees before re-pairing replaces a live credential. */
function printReplaceNotice() {
  process.stdout.write('  Reconnecting updates the permissions this CLI holds.\n');
  process.stdout.write('  Your current connection keeps working until the new one is approved,\n');
  process.stdout.write('  and is then revoked — any other machine or CI job using that same\n');
  process.stdout.write('  credential will stop working.\n\n');
}

// --- pair -------------------------------------------------------------------

/**
 * Pairing for machines with no terminal: print the approval link, wait once,
 * save, and (when replacing a stored credential) revoke the old one.
 *
 * Deliberately a separate command rather than a flag or a non-TTY fallback.
 * AGENT_PAIRING_SPEC.md § CLI behaviour requires that a non-interactive
 * `pingroom` keep exiting 0 with the PINGROOM_TOKEN hint — `pingroom | head`
 * is a normal thing to do, and silently starting a 15-minute poll there would
 * mint a registration from any stray pipe. Asking for `pair` is the consent.
 *
 * Differences from the interactive path, all of them deliberate:
 *   - never renders a QR (nothing can scan a log pipe);
 *   - never prompts, and never constructs a prompter, so an open stdin cannot
 *     hold the process open and a closed one cannot end it early;
 *   - exactly one round — an expired link exits 3 rather than offering another,
 *     because there is no human at this terminal to answer the offer.
 */
export async function pair(args) {
  if (args.help) { process.stdout.write(`${commandHelp('pair')}\n`); return EXIT.OK; }
  if (args._ && args._.length > 0) {
    fail('usage: pingroom pair [--api <url>] [--json]', EXIT.USAGE);
  }

  // Same reasoning as reconnect: an env token is not ours to replace, and
  // pairing into a credential that PINGROOM_TOKEN immediately shadows would
  // look like it worked while every later command used the other one.
  if (process.env.PINGROOM_TOKEN) {
    fail(
      'PINGROOM_TOKEN is set, and it would shadow whatever this pairing stores.\n'
      + '  Unset it and run "pingroom pair" again, or keep using the token as-is.',
      EXIT.USAGE,
    );
  }

  const jsonOut = Boolean(args.json);
  const apiBase = resolveApiBase(args);
  requireSafeUrl('--api', apiBase);

  // Re-pairing sends the stored credential to `apiBase` in the revoke below, so
  // it is bound by the same origin rule as every other stored-bearer command.
  const stored = readStoredCredential();
  if (stored) {
    requireStoredCredentialOrigin(args, apiBase);
    if (!jsonOut) printReplaceNotice();
  }

  const cred = await connectByPairing(apiBase, null, { qr: false, json: jsonOut });

  if (!cred) {
    if (!jsonOut) {
      process.stdout.write('  Run "pingroom pair" again for a fresh link.\n');
      if (stored) process.stdout.write('  Kept your current connection.\n');
    }
    return EXIT.EXPIRED;
  }

  if (stored) return revokePrevious(apiBase, stored, { json: jsonOut });
  return EXIT.OK;
}
