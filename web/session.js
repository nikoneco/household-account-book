// Only the opaque, short-lived app session is retained. Ledger/OAuth data stays in memory.
export const SESSION_STORAGE_KEY = 'household.session.v1';
const MAX_SESSION_MS = 60 * 60 * 1000;
const target = config => `${config.bridgeUrl}|${config.clientId}`;
export function validSession(value, now = Date.now()) {
  return value && /^[a-f0-9]{64}$/.test(value.session) && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt > now && value.expiresAt <= now + MAX_SESSION_MS;
}
export function clearSession() {
  try { localStorage.removeItem(SESSION_STORAGE_KEY); }
  catch { try { localStorage.setItem(SESSION_STORAGE_KEY, 'null'); } catch {} }
}
export function readSession(config) {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!validSession(saved) || saved.target !== target(config)) { clearSession(); return null; }
    return {session:saved.session,expiresAt:saved.expiresAt};
  } catch { clearSession(); return null; }
}
export function saveSession(config, value) {
  if (!validSession(value)) { clearSession(); return; }
  try { localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({session:value.session,expiresAt:value.expiresAt,target:target(config)})); }
  catch {} // Private mode/storage restrictions do not prevent an in-memory login.
}
