// Only the opaque, short-lived app session is retained. Ledger/OAuth data stays in memory.
export const SESSION_STORAGE_KEY = 'household.session.v1';
const MAX_SESSION_MS = 60 * 60 * 1000;
// Local filtering tolerates clock skew; the server still enforces its original expiry.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const target = config => `${config.bridgeUrl}|${config.clientId}`;
function rejectionReason(value, now = Date.now()) {
  if (!value || typeof value.session !== 'string' || !/^[a-f0-9]{64}$/.test(value.session)) return 'token';
  if (!Number.isSafeInteger(value.expiresAt)) return 'number';
  if (value.expiresAt <= now) return 'late';
  if (value.expiresAt > now + MAX_SESSION_MS + CLOCK_SKEW_MS) return 'too_far';
  return null;
}
export function validSession(value, now = Date.now()) {
  return rejectionReason(value, now) === null;
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
  const reason = rejectionReason(value);
  if (reason) { clearSession(); return {saved:false,reason}; }
  try {
    const raw = JSON.stringify({session:value.session,expiresAt:value.expiresAt,target:target(config)});
    localStorage.setItem(SESSION_STORAGE_KEY, raw);
    // Verify only within the app; report a boolean/reason, never credentials or values.
    if (localStorage.getItem(SESSION_STORAGE_KEY) !== raw) return {saved:false,reason:'storage-not-retained'};
    return {saved:true,reason:'stored'};
  } catch { return {saved:false,reason:'storage'}; }
  // Private mode/storage restrictions do not prevent an in-memory login.
}
