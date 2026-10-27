// Agent Inbox activation: `pingroom activate` sends a test Question with the
// saved robot credential and waits for the phone round-trip.

import { EXIT, INSTALL_APP_URL } from '../constants.js';
import {
  fail, isJsonObject, isNonEmptyString, isNullableString, sleep, stripControlChars,
} from '../util.js';
import { commandHelp } from '../help.js';
import { httpJson, requireSafeUrl, retryAfterMs } from '../http.js';
import { readStoredCredential, resolveApiBase } from '../config.js';
import { optionalTerminalText } from './connect-pairing-data.js';
import { connectedOutput } from './connect-status.js';

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

function activationFailureDetail(result) {
  if (result.error) return result.error.message;
  const status = result.res ? `HTTP ${result.res.status}` : 'request failed';
  return (result.json && (result.json.message || result.json.error || result.json.code)) || status;
}

function activationFailureCode(result) {
  const direct = optionalTerminalText(result?.json?.code);
  if (direct) return direct;
  return optionalTerminalText(result?.json?.error?.code);
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
    const instruction = activationFailureCode(ensured) === 'recipient_not_ready'
      ? `Install or update PingRoom: ${INSTALL_APP_URL}\n`
        + '  Open it, sign in, and enable notifications; then run "pingroom activate" again.'
      : undefined;
    activationIncomplete(detail, instruction);
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

/** Retry activation only for the durable robot credential saved by this CLI. */
export async function activateStoredInbox(args) {
  if (args.help) { process.stdout.write(`${commandHelp('activate')}\n`); return EXIT.OK; }
  if (args._.length > 0) fail('usage: pingroom activate', EXIT.USAGE);
  if (args.token !== undefined) {
    fail('pingroom activate uses the saved robot credential; remove --token', EXIT.USAGE);
  }
  const unsupported = Object.keys(args).filter((key) => !['_', 'help', 'api', 'token'].includes(key));
  if (unsupported.length > 0) {
    fail('usage: pingroom activate [--api <url>]', EXIT.USAGE);
  }

  const credential = readStoredCredential();
  if (!credential) {
    fail('no saved robot credential; run "pingroom" in an interactive terminal first', EXIT.USAGE);
  }
  if (!credential.room || !isNonEmptyString(credential.room.invite_code)) {
    // An all-rooms grant normally carries an eligible private home room,
    // but older servers (or accounts with none) may still return no destination.
    // The fix is picking one, not repeatedly pairing again.
    fail(
      credential.room_access === 'all'
        ? 'this robot was granted all rooms but has no home room; pick one in the PingRoom app under Connected Agents, then run "pingroom activate" again'
        : 'the saved robot has no home room; choose one under Connected Agents before running "pingroom activate"',
      EXIT.USAGE,
    );
  }
  const apiBase = resolveApiBase(args);
  requireSafeUrl('--api', apiBase);
  if (!isNonEmptyString(credential.api_url)) {
    fail('the saved robot credential has no trusted API origin; pair again before running "pingroom activate"', EXIT.USAGE);
  }
  let credentialOrigin;
  let targetOrigin;
  try {
    credentialOrigin = new URL(credential.api_url).origin;
    targetOrigin = new URL(apiBase).origin;
  } catch {
    fail('the saved robot credential has an invalid API origin; pair again', EXIT.USAGE);
  }
  if (credentialOrigin !== targetOrigin) {
    fail(`stored credential is bound to ${credentialOrigin}; refusing to send it to ${targetOrigin}`, EXIT.USAGE);
  }
  process.stdout.write(`${connectedOutput(credential)}\n`);

  const completed = await activateInboxAfterPairing({
    ...credential,
    apiBase,
  });
  return completed ? EXIT.OK : EXIT.ERROR;
}
