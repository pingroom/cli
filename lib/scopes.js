// What the official CLI asks for, and what each command actually needs.
//
// One pairing approval enables every command PingRoom ships. That is a
// deliberate reading of OAuth's minimum-required principle (RFC 9700 §2.3): the
// unit being authorized here is the complete official CLI, not the server's
// whole capability surface. Consent is an intersection server-side
// (AgentAuthController::pairingClaim), so this list is a hard CEILING — a scope
// missing here can never be granted, and the only remedy is a fresh pairing.
// That is why the set is not trimmed to "what you happen to run today".
//
// Two catalog scopes are deliberately absent:
//   pingroom:profile:write — no CLI command sets the agent avatar or handle.
//   pingroom:agents:ping   — retired; the route answers 410.
//
// Ordered by the group the consent screen shows, so the approval reads as three
// coherent sections even on a client that has not shipped the grouping yet.
export const CLI_SCOPES = [
  // Communication and human decisions
  'pingroom:broadcast:send',    // ping
  'pingroom:attachments:write', // ping --attach (upload), attachment delete
  'pingroom:notifications:read',// listen, attachment get
  'pingroom:questions:ask',     // ask / watch / cancel / list, approval, the hook
  'pingroom:approvals:request', // the legacy approvals surface (SDK/MCP parity)
  'pingroom:handoffs:create',   // handoff / handoffs / activate
  'pingroom:live:write',        // live start/update/end/get
  // Rooms and quick actions
  'pingroom:rooms:read',        // rooms list/get, actions list, room icons
  'pingroom:rooms:write',       // rooms create
  'pingroom:rooms:publish',     // rooms create --public
  'pingroom:rooms:join',        // rooms join
  'pingroom:actions:trigger',   // actions trigger
  'pingroom:actions:write',     // actions set
  // Webhooks
  'pingroom:webhooks:read',     // webhooks list
  'pingroom:webhooks:write',    // webhooks create/update
  'pingroom:webhooks:delete',   // webhooks delete
];

/**
 * Command -> every scope any of its verbs can need, taken from the route
 * middleware in laravel/routes/api.php.
 *
 * This exists to be TESTED, not consulted at runtime for authorization: the
 * server is the authority. `test/cli.test.mjs` asserts both directions — every
 * dispatched command appears here, and every scope named here is in
 * CLI_SCOPES — so a new command whose scope nobody requested cannot ship. That
 * check is the thing that would have caught `approval` 403ing on a fresh
 * pairing for as long as it did.
 *
 * An empty array means the command touches no agent-authenticated route.
 */
export const COMMAND_SCOPES = {
  ping: ['pingroom:broadcast:send', 'pingroom:attachments:write'],
  ask: ['pingroom:questions:ask'],
  watch: ['pingroom:questions:ask'],
  await: ['pingroom:questions:ask'],
  cancel: ['pingroom:questions:ask'],
  list: ['pingroom:questions:ask'],
  approval: ['pingroom:questions:ask'],
  handoff: ['pingroom:handoffs:create'],
  handoffs: ['pingroom:handoffs:create'],
  activate: ['pingroom:handoffs:create'],
  listen: ['pingroom:notifications:read'],
  hook: ['pingroom:questions:ask', 'pingroom:broadcast:send'],
  live: ['pingroom:live:write'],
  rooms: [
    'pingroom:rooms:read', 'pingroom:rooms:write',
    'pingroom:rooms:publish', 'pingroom:rooms:join',
  ],
  actions: ['pingroom:rooms:read', 'pingroom:actions:write', 'pingroom:actions:trigger'],
  webhooks: ['pingroom:webhooks:read', 'pingroom:webhooks:write', 'pingroom:webhooks:delete'],
  attachment: ['pingroom:notifications:read', 'pingroom:attachments:write'],
  // Local-only: no agent-authenticated route, so nothing to request.
  mcp: [],
  skills: [],
  config: [],
  logout: [],
  // reconnect and pair mint their OWN pre-claim credential and only touch the
  // unscoped pair/start, pair/status and revoke routes, so they request nothing
  // here. What they ask the human to approve is CLI_SCOPES above.
  reconnect: [],
  pair: [],
};

/**
 * Scopes a command needs that this credential was never granted.
 *
 * Returns [] whenever the answer is not knowable — no stored scope list at all
 * (a PINGROOM_TOKEN in CI has none), or an unrecognized command. That is the
 * whole contract: this is a courtesy that turns a 403 into a sentence naming
 * the fix, never a gate. Refusing on unknown scopes would break every CI job
 * holding a perfectly good token.
 */
export function missingScopesFor(command, grantedScopes) {
  if (!Array.isArray(grantedScopes) || grantedScopes.length === 0) return [];
  const needed = COMMAND_SCOPES[command];
  if (!needed || needed.length === 0) return [];
  return needed.filter((scope) => !grantedScopes.includes(scope));
}
