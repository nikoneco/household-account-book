// Check public release metadata only; never clear sessions or reload without a click.
export const APP_VERSION = '0.1.18';
export function initUpdates(environment = {}) {
  const win = environment.window || window;
  const doc = environment.document || document;
  const nav = environment.navigator || navigator;
  const request = environment.fetch || fetch;
  const banner = doc.querySelector('#app-update');
  const button = doc.querySelector('#app-update-button');
  const note = doc.querySelector('#app-update-note');
  if (!banner || !button || !note) return;
  let latest = null, checking = false, lastCheck = 0;
  const registrationReady = 'serviceWorker' in nav ? nav.serviceWorker.register('./sw.js', {updateViaCache:'none'}).catch(() => null) : Promise.resolve(null);
  function waitForWorker(worker, states) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Update timeout')), 15000);
      const finish = error => {clearTimeout(timer); worker.removeEventListener('statechange', inspect); error ? reject(error) : resolve();};
      const inspect = () => {if (states.includes(worker.state)) finish(); else if (worker.state === 'redundant') finish(new Error('Update installation failed'));};
      worker.addEventListener('statechange', inspect); inspect();
    });
  }
  async function check() {
    if (checking || nav.onLine === false || Date.now() - lastCheck < 60000) return;
    checking = true; lastCheck = Date.now();
    try {
      const response = await request(new URL('./sw.js', win.location.href), {cache:'no-cache'});
      if (!response.ok) return;
      const version = (await response.text()).match(/const CACHE = 'household-shell-v(\d+\.\d+\.\d+)'/);
      const parts = value => value.split('.').map(Number);
      if (version) {
        const candidate = parts(version[1]), current = parts(APP_VERSION);
        const firstDifference = candidate.findIndex((value, i) => value !== current[i]);
        if (firstDifference >= 0 && candidate[firstDifference] > current[firstDifference]) {latest = version[1]; banner.hidden = false;}
      }
    } catch { /* Offline is an ordinary state. */ }
    finally {checking = false;}
  }
  button.addEventListener('click', async () => {
    if (!latest || button.disabled) return;
    if (environment.canUpdate && !environment.canUpdate()) {note.textContent = '保存結果の確認が終わってから更新してください。'; return;}
    button.disabled = true;
    note.textContent = '更新を確認しています…';
    try {
      const response = await request(new URL('./index.html?v=' + latest, win.location.href), {cache:'no-cache'});
      if (!response.ok) throw new Error('Update unavailable');
      // Install/activate only on the user's explicit update action. No controllerchange reload.
      const registration = await registrationReady;
      if ('serviceWorker' in nav && !registration) throw new Error('Update unavailable');
      if (registration) {
        await registration.update();
        if (registration.installing) await waitForWorker(registration.installing, ['installed','activating','activated']);
        if (registration.waiting) {
          const worker = registration.waiting;
          worker.postMessage({type:'ACTIVATE_UPDATE'});
          await waitForWorker(worker, ['activated']);
        }
      }
      if (environment.canUpdate && !environment.canUpdate()) {
        note.textContent = '保存結果の確認が終わってから更新してください。'; button.disabled = false; return;
      }
      const url = new URL('./', win.location.href); url.searchParams.set('v', latest);
      win.location.replace(url.href);
    } catch {
      note.textContent = '更新できませんでした。通信を確認して、もう一度お試しください。';
      button.disabled = false;
    }
  });
  win.addEventListener('online', () => {lastCheck = 0; void check();});
  doc.addEventListener('visibilitychange', () => {if (doc.visibilityState === 'visible') void check();});
  void check();
  return {check};
}
