import {validSession, readSession} from './session.js';

// A device-only display cache. Authentication remains exclusively in session.js.
export const SNAPSHOT_STORAGE_KEY = 'household.startup-snapshot.v1';
export const MAX_SNAPSHOT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 4 * 1024 * 1024;
const fields = {
  expenses:'id useDate accountingMonth amount quantity category paymentMethod fixed manualEdited version deleted description memo fundingSettingId planId settingId receiptId receiptLineId',
  settings:'id kind name plannedAmount openingBalance targetAmount paymentMethod category memo active',
  plans:'id month settingId kind name plannedAmount paymentMethod category memo bankAutoHandled depositSkipped',
  transfers:'id date month amount memo kind settingId expenseId',
  incomes:'id month amount',
  bills:'id month confirmedAmount memo',
  receipts:'id status reason fileName uploadedAt purchaseDate merchant expenseIds deleted analysisRequestId analysisNotes archiveStatus archiveError'
};
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const select = (row, keys) => Object.fromEntries(keys.split(' ').filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));

// Reuse the domain's complete ledger/link/amount/date validation, including
// nested receipt notes. Exclude operation results, image bytes and Drive IDs.
export function displayState(value, domain = globalThis.HouseholdDomain) {
  if (!record(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('Invalid display state');
  const result = {schemaVersion:1,revision:value.revision};
  let count = 0;
  for (const [table, keys] of Object.entries(fields)) {
    if (!Array.isArray(value[table]) || (count += value[table].length) > 50000) throw new Error('Invalid display table');
    result[table] = value[table].map(row=>{
      if (!record(row)) throw new Error('Invalid display record');
      const item = select(row,keys);
      if (table === 'receipts') {
        item.imageHash = 'display-' + item.id; item.fileId = ''; item.mimeType = '';
        if (Object.hasOwn(item,'analysisNotes')) {
          if (!Array.isArray(item.analysisNotes)) throw new Error('Invalid receipt notes');
          item.analysisNotes = item.analysisNotes.map(note=>{
            if (!record(note)) throw new Error('Invalid receipt note');
            return select(note,'analysisRequestId requestedAt memo reviewReason');
          });
        }
        if (item.archiveStatus != null && !['archived','failed'].includes(item.archiveStatus)) throw new Error('Invalid archive status');
        if (item.archiveError != null && (typeof item.archiveError !== 'string' || item.archiveError.length > 5000)) throw new Error('Invalid archive error');
      }
      return item;
    });
  }
  result.operations = [];
  domain.summarize(result,'2000-01');
  return result;
}
async function binding(config, session) {
  const bytes = new TextEncoder().encode(JSON.stringify([config.bridgeUrl,config.clientId,session.session]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function clearSnapshot() {
  try { localStorage.removeItem(SNAPSHOT_STORAGE_KEY); }
  catch { try { localStorage.setItem(SNAPSHOT_STORAGE_KEY,'null'); } catch {} }
}
export async function readSnapshot(config, session, now = Date.now()) {
  let raw=null;
  try {
    if (!validSession(session,now)) { clearSnapshot(); return null; }
    raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    if (raw.length > MAX_BYTES) throw new Error('Oversize snapshot');
    const saved = JSON.parse(raw);
    if (!record(saved) || saved.version !== 1 || !['editor','viewer'].includes(saved.role) ||
      !Number.isSafeInteger(saved.savedAt) || saved.savedAt > now ||
      !Number.isSafeInteger(saved.expiresAt) || saved.expiresAt <= now || saved.expiresAt <= saved.savedAt ||
      saved.expiresAt > saved.savedAt + MAX_SNAPSHOT_MS || saved.expiresAt > session.expiresAt ||
      saved.binding !== await binding(config,session)) throw new Error('Invalid snapshot');
    // A digest yields to other tabs. Its original session must still own the
    // device before any private display data is returned to the renderer.
    if(readSession(config)?.session!==session.session || !validSession(session))return null;
    return {state:displayState(saved.state),role:saved.role,savedAt:saved.savedAt};
  } catch {
    // Do not remove a newer tab's cache if it changed while validation awaited.
    try{if(localStorage.getItem(SNAPSHOT_STORAGE_KEY)===raw)clearSnapshot();}catch{}
    return null;
  }
}
export async function saveSnapshot(config, session, state, role, now = Date.now()) {
  try {
    if (!validSession(session,now) || !['editor','viewer'].includes(role)) return false;
    const projected = displayState(state), key = await binding(config,session);
    // Logout/session replacement during the digest must win over this write.
    const current = readSession(config);
    if (!current || current.session !== session.session || current.expiresAt !== session.expiresAt) return false;
    const prior = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if (prior) {
      try { const saved=JSON.parse(prior); if(saved.binding===key && saved.state?.revision>projected.revision)return false; } catch {}
    }
    const raw = JSON.stringify({version:1,binding:key,savedAt:now,expiresAt:Math.min(now+MAX_SNAPSHOT_MS,session.expiresAt),role,state:projected});
    if (raw.length > MAX_BYTES) return false;
    localStorage.setItem(SNAPSHOT_STORAGE_KEY,raw);
    return localStorage.getItem(SNAPSHOT_STORAGE_KEY) === raw;
  } catch { return false; }
}
