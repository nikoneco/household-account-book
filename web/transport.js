const copy = value => structuredClone(value);
const error = (code, message) => Object.assign(new Error(message), {code});

export function createTransport(config, environment = {}) {
  const win = environment.window || window;
  const doc = environment.document || document;
  const random = environment.crypto || crypto;
  const timeoutMs = environment.timeoutMs || 45000;
  const channel = (random.randomUUID() + random.randomUUID()).replaceAll('-', '');
  const url = new URL(config.bridgeUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || !/^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname)) {
    throw error('CONFIGURATION', '接続先の設定を確認してください。');
  }
  url.search = '';
  url.hash = '';
  url.searchParams.set('channel', channel);
  let source, origin, session = '', closed = false;
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Avoid an unhandled rejection if a user remains on the signed-out screen.
  ready.catch(() => {});
  const readyTimer = setTimeout(() => readyReject(error('CONNECTION', '接続できません。通信と接続先の設定を確認してください。')), timeoutMs);
  const iframe = doc.createElement('iframe');
  iframe.title = '家計簿の安全な接続';
  iframe.hidden = true;
  iframe.referrerPolicy = 'no-referrer';
  iframe.src = url.href;
  function onMessage(event) {
    const data = event.data;
    if (closed || !data || data.channel !== channel) return;
    if (!source && data.type === 'household:ready') {
      let sender;
      try { sender = new URL(event.origin); } catch { return; }
      const googleFrame = sender.protocol === 'https:' && /(^|\.)googleusercontent\.com$/.test(sender.hostname);
      const directFrame = event.origin === 'https://script.google.com' && event.source === iframe.contentWindow;
      if (!event.source || (!googleFrame && !directFrame)) return;
      source = event.source; origin = event.origin;
      clearTimeout(readyTimer); readyResolve(); return;
    }
    if (event.source !== source || event.origin !== origin || data.type !== 'household:response') return;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id); clearTimeout(request.timer);
    if (data.ok) request.resolve(data.result);
    else {
      if (['UNAUTHENTICATED', 'UNAUTHORIZED', 'AUTH_REQUIRED', 'AUTH_FORBIDDEN'].includes(data.error?.code)) session = '';
      request.reject(error(data.error?.code || 'SERVER', data.error?.message || '保存できませんでした。'));
    }
  }
  win.addEventListener('message', onMessage);
  doc.body.append(iframe);
  async function call(method, payload) {
    if (closed) throw error('CLOSED', '接続を終了しました。');
    await ready;
    if (closed) throw error('CLOSED', '接続を終了しました。');
    const id = random.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(error('TIMEOUT', '応答を確認できませんでした。同じ操作を再試行してください。'));
      }, timeoutMs);
      pending.set(id, {resolve, reject, timer});
      source.postMessage({type:'household:request', channel, id, method, payload}, origin);
    });
  }
  async function rpc(operation, payload) {
    if (!session) throw error('UNAUTHENTICATED', 'Googleでログインしてください。');
    return call('rpc', {session, operation, payload});
  }
  // A timeout is ambiguous: reuse the original operation ID for exactly one retry.
  async function durable(operation, payload) {
    try { return await rpc(operation, payload); }
    catch (failure) {
      if (failure.code !== 'TIMEOUT') throw failure;
      return rpc(operation, payload);
    }
  }
  return {
    prepareLogin: () => call('authPrepare', channel),
    async login(code, state) {
      const result = await call('authLogin', {code, state, channel});
      if (!result || typeof result.session !== 'string') throw error('UNAUTHENTICATED', 'ログインを確認できませんでした。');
      session = result.session;
      return {expiresAt:result.expiresAt,role:result.role || 'editor'};
    },
    async logout() { const previous = session; session = ''; if (previous) await call('authLogout', {session:previous}); },
    load: () => rpc('load', {}),
    mutate: command => durable('mutate', copy(command)),
    uploadReceipt: payload => durable('uploadReceipt', copy(payload)),
    receiptImage: receiptId => rpc('receiptImage', {receiptId}),
    close() {
      closed = true; session = ''; clearTimeout(readyTimer);
      readyReject(error('CLOSED', '接続を終了しました。'));
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error('CLOSED', '接続を終了しました。')); }
      pending.clear(); win.removeEventListener('message', onMessage); iframe.remove();
    }
  };
}

export function createDemoTransport() {
  let state = globalThis.HouseholdDomain.emptyState();
  const images = new Map();
  const mutate = async command => {
    const response = globalThis.HouseholdDomain.execute(state, copy(command));
    state = response.state;
    return copy(response);
  };
  return {
    prepareLogin:async () => ({state:'demo'}), login:async () => ({role:'editor'}),
    load:async () => copy(state), mutate,
    async uploadReceipt(payload) {
      const response = await mutate({type:'registerReceipt', operationId:payload.operationId,
        payload:{imageHash:payload.imageHash,fileName:payload.fileName,mimeType:payload.mimeType,fileId:crypto.randomUUID()}});
      images.set(response.result.id, `data:${payload.mimeType};base64,${payload.base64}`);
      return response;
    },
    receiptImage:async id => ({dataUrl:images.get(id),fileName:state.receipts.find(item => item.id === id)?.fileName}),
    logout:async () => {state = globalThis.HouseholdDomain.emptyState(); images.clear();},
    close:() => {state = globalThis.HouseholdDomain.emptyState(); images.clear();}
  };
}
