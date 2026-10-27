// The pairing and connection JSON a configured API host returns, reduced to
// what is safe to print and persist: the robot, owner and room identity, and
// the QR, browser, latest-pings and install links. Split out of connect.js.

import { INSTALL_APP_URL } from '../constants.js';
import { isJsonObject, isNullableString, stripControlChars } from '../util.js';

// What the human reads on the approval screen. A product name, not a package
// id: the phone shows it verbatim ("PingRoom CLI wants to connect"). Callers
// may make the robot more specific with --agent-label (for example, "OpenClaw
// on studio-mac") without changing the default existing installs send.
export const DEFAULT_AGENT_LABEL = 'PingRoom CLI';

/**
 * Prefer the explicit QR field while retaining old-server compatibility.
 */
export function pairingQrUrl(pairing) {
  const pairUrl = stripControlChars(pairing?.pair_url ?? '');
  const candidate = typeof pairing?.pair_qr_url === 'string'
    ? stripControlChars(pairing.pair_qr_url)
    : '';

  return candidate.trim() === '' ? pairUrl : candidate;
}

/** Browser approval uses its own link without changing the legacy QR URL. */
export function pairingBrowserUrl(pairing) {
  const candidate = typeof pairing?.pair_browser_url === 'string'
    ? stripControlChars(pairing.pair_browser_url)
    : '';
  return candidate.trim() === '' ? stripControlChars(pairing?.pair_url ?? '') : candidate;
}

export function optionalTerminalText(value) {
  if (typeof value !== 'string') return null;
  const clean = stripControlChars(value).trim();
  return clean === '' ? null : clean;
}

export function normalizeAgentProfile(value, fallbackLabel) {
  const agent = isJsonObject(value) ? value : {};
  const profile = isJsonObject(agent.profile) ? agent.profile : {};
  const displayName = optionalTerminalText(profile.display_name)
    || optionalTerminalText(agent.label)
    || fallbackLabel;
  const handle = optionalTerminalText(profile.handle) || optionalTerminalText(agent.handle);
  const avatarId = optionalTerminalText(profile.avatar_id);
  const avatarUrl = validHttpUrl(profile.avatar_url) || null;

  return {
    ...(optionalTerminalText(agent.id) ? { id: optionalTerminalText(agent.id) } : {}),
    label: optionalTerminalText(agent.label) || displayName,
    handle,
    profile: {
      display_name: displayName,
      handle,
      avatar_id: avatarId,
      avatar_url: avatarUrl,
    },
  };
}

function normalizeOwner(value, fallbackAccount) {
  const owner = isJsonObject(value) ? value : {};
  const account = isJsonObject(fallbackAccount) ? fallbackAccount : {};
  const name = optionalTerminalText(owner.name) || optionalTerminalText(account.name);
  return name ? { name } : null;
}

function normalizeRoom(value) {
  if (!isJsonObject(value)) return null;
  const inviteCode = optionalTerminalText(value.invite_code);
  if (!inviteCode) return null;
  return {
    ...(optionalTerminalText(value.id) ? { id: optionalTerminalText(value.id) } : {}),
    invite_code: inviteCode,
    name: optionalTerminalText(value.name),
  };
}

function normalizeRoomMembership(value) {
  if (!isJsonObject(value)) return null;
  const status = value.status === 'active' || value.status === 'removed' ? value.status : null;
  const room = normalizeRoom(value.room);
  if (!status && !room) return null;
  return {
    status,
    joined_at: isNullableString(value.joined_at) ? value.joined_at : null,
    removed_at: isNullableString(value.removed_at) ? value.removed_at : null,
    room,
  };
}

/** Select and sanitize the additive v2 identity fields safe to print in logs. */
export function pairingMetadata(value, { agent, account, room } = {}) {
  const source = isJsonObject(value) ? value : {};
  const normalizedAgent = normalizeAgentProfile(source.agent ?? agent, agent?.profile?.display_name ?? DEFAULT_AGENT_LABEL);
  const owner = normalizeOwner(source.owner, source.account ?? account);
  const homeRoom = normalizeRoom(source.home_room) || normalizeRoom(room);
  const hasMembership = Object.hasOwn(source, 'room_membership');
  const membership = source.room_membership === null
    ? null
    : normalizeRoomMembership(source.room_membership);

  return {
    ...(source.flow_version === 2 ? { flow_version: 2 } : {}),
    ...(source.claim_mode === 'agent_identity' ? { claim_mode: 'agent_identity' } : {}),
    agent: normalizedAgent,
    ...(owner ? { owner } : {}),
    ...(homeRoom ? { home_room: homeRoom } : {}),
    ...(hasMembership ? { room_membership: membership } : {}),
  };
}

export function agentDisplay(agent, fallbackHandle) {
  const name = optionalTerminalText(agent?.profile?.display_name)
    || optionalTerminalText(agent?.label)
    || 'Robot';
  const handle = optionalTerminalText(agent?.profile?.handle)
    || optionalTerminalText(agent?.handle)
    || optionalTerminalText(fallbackHandle);
  return `${name}${handle ? ` (@${handle.replace(/^@/, '')})` : ''}`;
}

/**
 * Keep only safe read/install links. Pairing data is controlled by the selected
 * API host and is printed to a terminal, so malformed schemes and control
 * characters are discarded instead of being persisted indefinitely.
 *
 * Older servers do not return `links`. Their stable notifications endpoint is a
 * useful, token-free fallback: callers still authenticate in the usual header.
 */
export function pairingLinks(value, apiBase) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const supplied = validHttpUrl(source.latest_pings);
  let latestPings = supplied;

  if (!latestPings) {
    try {
      const parsedBase = new URL(apiBase);
      const normalizedBase = `${parsedBase.origin}${parsedBase.pathname}`.replace(/\/+$/, '');
      latestPings = validHttpUrl(
        `${normalizedBase}/api/agent/notifications?limit=25&page=1`,
      );
    } catch {
      // The install handoff below is still useful even if an invalid API base
      // prevents construction of the old-server latest-pings fallback.
    }
  }

  return {
    ...(latestPings ? { latest_pings: latestPings } : {}),
    install_app: pairingInstallUrl(source),
  };
}

/**
 * Select the server's additive install link only when it is the canonical,
 * token-free mobile handoff. A configured API host controls pairing JSON, so
 * arbitrary URLs or query parameters must never become an agent's install CTA.
 */
export function pairingInstallUrl(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const links = source.links && typeof source.links === 'object' && !Array.isArray(source.links)
    ? source.links
    : {};
  const mobileApp = source.mobile_app && typeof source.mobile_app === 'object'
    && !Array.isArray(source.mobile_app)
    ? source.mobile_app
    : {};
  const candidates = [
    source.app_install_url,
    source.install_app,
    source.install_url,
    links.install_app,
    mobileApp.install_url,
  ];

  for (const candidate of candidates) {
    const supplied = validHttpUrl(candidate);
    if (supplied === INSTALL_APP_URL) return supplied;
  }
  return INSTALL_APP_URL;
}

function validHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const clean = stripControlChars(value).trim();
  if (clean !== value.trim()) return undefined;
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.username !== '' || parsed.password !== '') return undefined;
    return clean;
  } catch {
    return undefined;
  }
}
