// Connecting: QR pairing, the email fallback, Agent Inbox activation, and the
// bare `pingroom` status/prompt. Everything a human touches once and then never
// thinks about again.
//
// This is the module bin/pingroom.js and the tests import. The work lives in
// its siblings:
//   connect-pairing-data.js  what is safe to keep from the server's pairing JSON
//   connect-pairing.js       QR pairing, the email fallback, reconnect and pair
//   connect-activation.js    pingroom activate
//   connect-status.js        the connected-status line and bare pingroom

export { pairingBrowserUrl, pairingInstallUrl, pairingLinks, pairingQrUrl } from './connect-pairing-data.js';
export { connect, pair, reconnect } from './connect-pairing.js';
export { activateStoredInbox } from './connect-activation.js';
export { bare } from './connect-status.js';
