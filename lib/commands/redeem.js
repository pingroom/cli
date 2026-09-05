import { EXIT } from '../constants.js';
import { agentContext } from '../config.js';
import { commandHelp } from '../help.js';
import { apiDetail, httpJson } from '../http.js';
import { fail, stripControlChars } from '../util.js';

export async function redeem(args) {
  if (args.help) { process.stdout.write(`${commandHelp('redeem')}\n`); return EXIT.OK; }
  if (args._.length > 1 || (args._.length && args.code !== undefined)) {
    fail('provide one code: pingroom redeem <code> or pingroom redeem --code <code>', EXIT.USAGE);
  }
  const input = String(args.code ?? args._[0] ?? process.env.PINGROOM_REDEEM_CODE ?? '').trim();
  if (!/^[A-Za-z0-9]{12}$/.test(input)) {
    fail('a gift or promotional code must contain exactly 12 letters or digits. Use pingroom redeem <code>, --code, or PINGROOM_REDEEM_CODE.', EXIT.USAGE);
  }
  const code = input.toUpperCase();

  const { token, apiBase } = agentContext(args);
  const { res, json, error } = await httpJson('POST', `${apiBase}/api/agent/redeem-code`, {
    headers: { Authorization: `Bearer ${token}` }, body: { code }, soft: true,
  });
  // Transport and parser errors may include request/response text. This write
  // is never automatically retried: a dropped response can follow redemption.
  if (error || !res) fail('could not confirm redemption. Check your account plan before retrying.');
  const safeText = (value) => stripControlChars(value).replace(new RegExp(code, 'gi'), '[redacted]');
  if (!res.ok) {
    const detail = apiDetail(res, {
      message: safeText(json?.errors?.code?.[0] ?? json?.message ?? json?.error ?? `HTTP ${res.status}`),
      code: typeof json?.code === 'string' ? safeText(json.code) : undefined,
    });
    fail(`redemption failed: ${detail}`);
  }
  if (json?.plan !== 'pro' || !['gift', 'redeem'].includes(json.kind) || typeof json.lifetime !== 'boolean') {
    fail('could not confirm redemption from the API response. Check your account plan before retrying.');
  }

  // Only publish the receipt fields; response extras must not echo the code.
  const receipt = {
    message: typeof json.message === 'string' ? safeText(json.message) : 'Code redeemed.',
    kind: json.kind,
    reward_days: Number.isInteger(json.reward_days) ? json.reward_days : null,
    package: typeof json.package === 'string' ? safeText(json.package) : null,
    lifetime: json.lifetime,
    plan: json.plan,
    plan_expires_at: typeof json.plan_expires_at === 'string' ? safeText(json.plan_expires_at) : null,
  };
  if (args.json) process.stdout.write(`${JSON.stringify(receipt)}\n`);
  else {
    const benefit = receipt.lifetime
      ? 'Lifetime Pro is active.'
      : receipt.plan_expires_at ? `Pro is active until ${receipt.plan_expires_at}.` : 'Pro is active.';
    process.stdout.write(`Code redeemed for the connected account. ${benefit}\n`);
  }
  return EXIT.OK;
}
