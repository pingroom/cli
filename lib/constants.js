// Endpoints and exit codes shared by every command surface.

export const BUILTIN_API = 'https://api.pingroom.io';
export const MCP_ENDPOINT = `${BUILTIN_API}/api/agent/mcp`;
export const DEFAULT_API = process.env.PINGROOM_API_URL || BUILTIN_API;
// One token-free handoff for every agent and pairing surface. `/i` selects the
// appropriate store without carrying claim tokens or other secret parameters.
export const INSTALL_APP_URL = 'https://pingroom.io/i';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, EXPIRED: 3, CANCELLED: 4 };

// A caller holding only a room code or webhook URL cannot know the room's
// visibility without another request. Keep the CLI's local ceiling at the
// public-room limit; Laravel applies the tighter private-room limit.
export const PING_TITLE_MAX_LENGTH = 40;
export const PRIVATE_PING_MESSAGE_MAX_LENGTH = 120;
export const PUBLIC_PING_MESSAGE_MAX_LENGTH = 160;

// Reserved data.location display metadata. Coordinate ranges are part of the
// numeric format itself; these caps mirror the API's Unicode-aware string rules.
export const LOCATION_LABEL_MAX_LENGTH = 100;
export const LOCATION_ADDRESS_MAX_LENGTH = 255;
