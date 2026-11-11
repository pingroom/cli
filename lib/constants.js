// Endpoints and exit codes shared by every command surface.

export const BUILTIN_API = 'https://api.pingroom.io';
export const MCP_ENDPOINT = `${BUILTIN_API}/api/agent/mcp`;
export const DEFAULT_API = process.env.PINGROOM_API_URL || BUILTIN_API;
// One token-free handoff for every agent and pairing surface. `/i` selects the
// appropriate store without carrying claim tokens or other secret parameters.
export const INSTALL_APP_URL = 'https://pingroom.io/i';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, EXPIRED: 3, CANCELLED: 4, MORE_EVENTS: 5 };

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

// Ping tags. Mirror PingTagRules::MAX_TAGS / TAG_MAX / PATTERN in
// laravel/app/Support/PingTagRules.php.
export const PING_TAGS_MAX = 10;
export const PING_TAG_MAX_LENGTH = 32;
export const PING_TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// A `replace_key`: the sender's own handle for "the ping I keep updating".
// Mirrors PingReplacement::KEY_MAX_LENGTH / KEY_PATTERN in
// laravel/app/Support/PingReplacement.php.
export const REPLACE_KEY_MAX_LENGTH = 64;
export const REPLACE_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

// Reserved data.checklist caps. Mirror ChecklistRules::MAX_ITEMS / ITEM_MAX in
// laravel/app/Support/ChecklistRules.php.
export const CHECKLIST_MAX_ITEMS = 25;
export const CHECKLIST_ITEM_MAX_LENGTH = 80;

// Room metrics. Mirror RoomMetric::MAX_PER_ROOM / FORMATS and RoomMetricRules in
// laravel/app/Support/RoomMetricRules.php. The currency list stays on the server:
// the CLI checks only the [A-Z]{3} shape, so it never refuses a code the server
// would accept.
export const METRIC_MAX_PER_ROOM = 8;
export const METRIC_FORMATS = ['number', 'currency', 'percent', 'unit', 'text'];
export const METRIC_KEY_MAX_LENGTH = 40;
export const METRIC_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const METRIC_LABEL_MAX_LENGTH = 24;
export const METRIC_UNIT_MAX_LENGTH = 8;
export const METRIC_TEXT_VALUE_MAX_LENGTH = 24;
export const METRIC_MAX_ABSOLUTE_VALUE = 1e15;
export const METRIC_CURRENCY_PATTERN = /^[A-Z]{3}$/;
