// What each command needs. Pairing itself intentionally sends no scope list:
// the server owns the full access policy and consent copy, so adding a command
// never makes an older client mint a narrower credential or demand a reconnect.

/**
 * Command -> every scope any of its verbs can need, taken from the route
 * middleware in laravel/routes/api.php.
 *
 * This exists to document and test the client-to-route contract, not to drive
 * authorization. The server is the pairing and authorization authority.
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
  redeem: ['pingroom:codes:redeem'],
  // Local-only: no agent-authenticated route, so nothing to request.
  mcp: [],
  skills: [],
  config: [],
  logout: [],
  // reconnect and pair mint their own pre-claim credential and only touch the
  // unscoped pair/start, pair/status and revoke routes.
  reconnect: [],
  pair: [],
};
