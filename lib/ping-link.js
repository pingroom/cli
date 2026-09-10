import { BUILTIN_API } from './constants.js';

/** The web app can open IDs from the hosted API, not a custom server. */
export function pingWebUrl(json, requestUrl) {
  try {
    if (new URL(requestUrl).origin !== BUILTIN_API) return null;
  } catch {
    return null;
  }
  const id = json?.notification_id ?? json?.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) {
    return null;
  }
  return `https://pingroom.io/app/notifications/${id}`;
}
