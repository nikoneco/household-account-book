import { createTransport, createDemoTransport } from './transport.js';

const D = globalThis.HouseholdDomain;
const CATEGORIES = ['食費', '酒', '趣味', '外食', '必要経費', 'その他'];
const PAYMENTS = {cash:'現金',bank:'銀行',card:'カード'};
const main = document.querySelector('#main');
const yen = value => '¥' + Number(value || 0).toLocaleString('ja-JP');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const monthLabel = value => `${Number(value.slice(0,4))}年${Number(value.slice(5,7))}月`;
const savedTime = value => value ? new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '未確認';
let month = today().slice(0,7), page = 'home', tab = 'expense', state = null, transport = null, config = null;
let busy = false, loginLoading = false, pendingCommand = null, pendingSuccess = null, editing = null, settingEdit = null, loginPreparation = null, googleClient = null;
let transferPreset = null, imageUrl = null, imageRequest = 0, authEpoch = 0, sessionRole = 'editor';
const materialized = new Set();
const list = key => (state?.[key] || []).filter(item => key !== 'expenses' || !item.deleted);
const withdrawalRemaining = expense => expense.amount - list('transfers').filter(t=>t.kind==='withdrawal'&&t.expenseId===expense.id).reduce((sum,t)=>sum+t.amount,0);
const savings = () => list('settings').filter(item => item.kind === 'saving');
const options = (values, selected, label = value => value) => values.map(value => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label(value))}</option>`).join('');
const settingOptions = (items, selected = '', empty = '指定しない') => `<option value="">${empty}</option>` + items.map(item => `<option value="${esc(item.id)}"${item.id === selected ? ' selected' : ''}>${esc(item.name)}</option>`).join('');
const field = (name,label,value,type='text',extra='') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const moneyField = (name,label,value,extra='required') => field(name,label,value,'number',`min="0" step="1" inputmode="numeric" ${extra}`);
const paymentField = (value='cash') => `<label>支払方法<select name="paymentMethod">${options(Object.keys(PAYMENTS),value,key=>PAYMENTS[key])}</select></label>`;
const categoryField = (value='食費') => `<label>分類<select name="category">${options(CATEGORIES,value)}</select></label>`;
function message(text, error = false) { const el = document.querySelector(error ? '#error' : '#message'); el.textContent = text; el.hidden = !text; }
function clearMessages() { message(''); message('',true); }
function dateLabel(date) { return `${date.slice(5,7)}/${date.slice(8,10)}`; }
function heading(title,caption) { return `<div class="page-head"><h1>${title}</h1><label class="month-field">表示する月<input id="month" type="month" value="${month}" required></label></div><p class="muted page-caption">${caption}</p>`; }
function button(action,label,id='',cls='quiet small') { return `<button type="button" class="${cls}" data-action="${action}" data-id="${esc(id)}">${label}</button>`; }
function formStart(id) { return `<form id="${id}"><div class="form-grid">`; }
function formEnd(label='保存する',cancel='') { return `</div><div class="form-actions"><button type="submit">${label}</button>${cancel ? button(cancel,'キャンセル') : ''}</div></form>`; }

function renderAuth() {
  closeDetail();
  document.querySelector('#navigation').hidden = true;
  document.querySelector('#logout').hidden = true;
  main.setAttribute('aria-busy',String(loginLoading));
  if(loginLoading){
    main.innerHTML='<section class="panel auth-panel"><h1>読み込み中</h1><p class="muted" role="status">家計簿を読み込んでいます…</p></section>';
    return;
  }
  main.innerHTML = `<section class="panel auth-panel"><h1>ログイン</h1><p class="muted">Googleアカウントでログインしてください。</p>${config ? `<button id="google-login" ${!googleClient ? 'disabled' : ''}>${googleClient ? 'Googleでログイン' : 'ログインを準備しています…'}</button>` : `<p class="notice">Google連携の準備が必要です。接続設定後にログインできます。</p>`}<div class="separator"><button id="demo-login" class="quiet">サンプルで試す</button><p class="hint">サンプルの入力は保存されず、終了すると消えます。</p></div></section>`;
}

function summary() {
  if (D?.summarize) return D.summarize(state,month);
  throw new Error('集計機能を読み込めませんでした。ページを再読み込みしてください。');
}
function renderHome() {
  const s = summary();
  const categoryAmounts = s.categories;
  const fundedPurchases = s.pendingFunding.map(e=>({...e,id:e.expenseId,amount:e.pending}));
  const savingsBalance = s.savings.reduce((total,item)=>total+item.balance,0);
  return heading(monthLabel(month),'給与・支出・積立の集計') + `<section class="panel ledger"><div class="ledger-main"><div class="ledger-title"><span>今月の残り</span>${button('toggle-income','給与を入力')}</div><div class="big-money ${s.monthlyRemaining<0?'negative':''}">${yen(s.monthlyRemaining)}</div><div class="account-line"><span>給与</span><strong>${yen(s.income)}</strong></div><div class="account-line"><span>給与からの購入・支払い</span><strong>− ${yen(s.salaryExpenses)}</strong></div><div class="account-line"><span>積立への入金</span><strong>− ${yen(s.savingsDeposited)}</strong></div><div id="income-edit" class="inline-edit" hidden>${formStart('income-form')}${moneyField('amount','この月の給与',s.income)}${formEnd('給与を保存')}</div><p class="ledger-foot">積立で賄った購入分は、給与から引きません。<br>残りは翌月に持ち越しません。</p>${s.savingsPending?`<p class="notice">積立で賄う購入の取り崩しが ${yen(s.savingsPending)} 未登録です。記録するまで給与からの購入・支払いに含まれます。</p>`:``}</div><div class="ledger-side"><h2>積立</h2><div class="account-line"><span>今月の積立予定</span><strong>${yen(s.savingsPlanned)}</strong></div><div class="account-line"><span>今月の積立入金</span><strong>${yen(s.savingsDeposited)}</strong></div><div class="account-line"><span>今月の取り崩し</span><strong>${yen(s.savingsWithdrawn)}</strong></div><div class="account-line emphasis"><span>積立残金</span><strong>${yen(savingsBalance)}</strong></div></div></section><div class="cols"><section class="panel"><h2>購入・支払の内訳</h2><p class="hint">積立で賄った購入も含みます。</p>${CATEGORIES.map(c=>`<div class="category"><span>${c}</span><meter class="bar" min="0" max="${s.expenses || 1}" value="${categoryAmounts[c]}" aria-label="${c}の割合"></meter><strong>${yen(categoryAmounts[c])}</strong></div>`).join('')}${!s.expenses?'<p class="hint">「登録」から支出を記録できます。</p>':''}</section><section class="panel"><h2>カードの照合</h2><div class="account-line"><span>購入明細の合計</span><strong>${yen(s.cardTotal)}</strong></div><div class="account-line"><span>確定請求額</span><strong>${s.confirmedAmount == null ? '未入力' : yen(s.confirmedAmount)}</strong></div><div class="account-line"><span>差額（請求 − 明細）</span><strong>${s.billDifference == null ? '—' : yen(s.billDifference)}</strong></div><p class="hint">27日締め・翌月28日請求。確定請求額は照合用で、支出に加算しません。</p>${formStart('bill-form')}${moneyField('confirmedAmount','確定請求額',s.confirmedAmount ?? '')}<label class="full">メモ<input name="memo" maxlength="300" value="${esc(list('bills').find(b=>b.month===month)?.memo||'')}"></label>${formEnd('請求額を保存')}</section></div><section class="panel section-space"><div class="row-head"><h2>積立残高</h2>${button('go-transfer','入金・取り崩し')}</div>${s.savings.length?s.savings.map(item=>`<div class="saving-row"><div class="row-head"><h3>${esc(item.name)}</h3><strong class="number">${yen(item.balance)}</strong></div><div class="account-line"><span>今月の積立予定</span><strong>${yen(item.planned)}</strong></div><div class="account-line"><span>今月の積立入金</span><strong>${yen(item.deposited)}</strong></div><div class="account-line"><span>今月の取り崩し</span><strong>${yen(item.withdrawn)}</strong></div><p class="hint">積立残金${item.targetAmount?' ／ 目標 '+yen(item.targetAmount):''}</p></div>`).join(''):'<div class="empty"><strong>積立はありません。</strong>「毎月の設定」で、積立の名前と金額を決められます。</div>'}${fundedPurchases.length ? `<div class="notice">積立で賄う購入の取り崩しを記録できます。カードは請求月に、支払い確認後に記録してください。</div>${fundedPurchases.map(e=>`<div class="saving-row"><div class="row-head"><span>${esc(e.description||e.category)} · ${yen(e.amount)}</span>${button('funded-withdraw',e.paymentMethod==='card'?'支払い確認・取り崩し':'取り崩しを記録',e.id)}</div></div>`).join('')}`:''}</section>`;
}

function expenseForm() {
  const e = editing || {useDate:today(),amount:'',paymentMethod:'cash',category:'食費',accountingMonth:today().slice(0,7)};
  const fixedPlans=list('plans').filter(p=>p.month===e.accountingMonth && p.kind==='fixed');
  const fixedChoice=`<label class="full check-label"><input type="checkbox" name="fixed" ${e.fixed?'checked':''}>固定費として記録する</label>`;
  const actions=`<div class="form-actions"><button type="submit">${editing?'変更を保存':'支出を保存'}</button>${editing?button('cancel-expense','キャンセル'):''}</div>`;
  return `<section class="panel scroll-anchor" id="expense-panel">
    ${editing?'<h2>支出を編集</h2>':''}
    <form id="expense-form" aria-label="支出の登録"><div class="form-grid">
      ${field('useDate','使った日',e.useDate,'date','required')}${moneyField('amount','金額（円）',e.amount,'required min="1"')}
      ${categoryField(e.category)}${paymentField(e.paymentMethod)}
      <label class="full">内容<input name="description" value="${esc(e.description)}" maxlength="200" placeholder="スーパー、ランチなど"></label>
    </div>
    <p class="hint accounting-note">計上月：<output id="accounting-label">${esc(monthLabel(e.accountingMonth))}</output></p>
    ${editing?'':actions}
    <details class="expense-options" ${editing?'open':''}>
      <summary>固定費・積立・メモ・計上月の変更</summary>
      <div class="form-grid">
        <label>計上月<input name="accountingMonth" type="month" value="${esc(e.accountingMonth)}" required></label>
        <label>固定費の実績<select name="planId">${settingOptions(fixedPlans,e.planId,'予定を選ばない')}</select></label>
        ${fixedChoice}
        <label class="full">どの積立で賄う？<select name="fundingSettingId">${settingOptions(savings(),e.fundingSettingId)}</select><span class="hint">指定だけでは取り崩しません。カードは請求月に、支払い確認後の取り崩しを記録します。</span></label>
        ${field('quantity','数量（任意）',e.quantity??'','number','min="1" step="1" inputmode="numeric"')}<p class="hint">金額は数量分の合計です。数量が不明なら空欄にします。</p><label class="full">メモ<textarea name="memo" maxlength="500">${esc(e.memo)}</textarea></label>
      </div>
    </details>
    ${editing?actions:''}
    </form><p class="hint">現金・銀行は使った月。カードは27日締め・翌月28日請求です。</p>
    </section>`;
}
function transferForm() {
  const p=transferPreset||{};
  const eligible=list('expenses').filter(e=>e.accountingMonth===month && withdrawalRemaining(e)>0);
  return `<section class="panel"><h2>積立の入金・取り崩し</h2>${!savings().length?'<p class="notice">「毎月の設定」で積立を追加してください。</p>':''}${formStart('transfer-form')}<label>積立<select name="settingId" required>${settingOptions(savings(),p.settingId,'積立を選ぶ')}</select></label><div class="full" id="transfer-balance" aria-live="polite"><div class="account-line"><span>積立の残金</span><strong id="transfer-current-balance">積立を選んでください</strong></div><div class="account-line"><span>今回の移動後の残金</span><strong id="transfer-after-balance">—</strong></div></div><label>記録の種類<select name="kind">${options(['deposit','withdrawal'],p.kind||'deposit',k=>k==='deposit'?'入金':'取り崩し')}</select></label>${field('date','実際に移動した日',p.date||today(),'date',`required max="${today()}"`)}${moneyField('amount','金額（円）',p.amount||'','required min="1"')}<label class="full">取り崩しに対応する支出<select name="expenseId"><option value="">購入と関連付けない</option>${eligible.map(e=>`<option value="${esc(e.id)}"${e.id===p.expenseId?' selected':''}>${dateLabel(e.useDate)} ${esc(e.description||e.category)} · ${yen(withdrawalRemaining(e))}（${PAYMENTS[e.paymentMethod]}・取り崩し残額）</option>`).join('')}</select><span class="hint">カードは表示中の請求月の購入を選び、支払い確認後に記録します。</span></label><label class="full">メモ<textarea name="memo" maxlength="500">${esc(p.memo)}</textarea></label>${formEnd('実際の移動を保存')}<p class="hint">取り崩しは資金の移動です。購入の支出をもう一度加算しません。未来の日付は登録できません。</p></section>`;
}
function updateTransferBalance() {
  const form=document.querySelector('#transfer-form');
  if(!form)return;
  const item=savings().find(item=>item.id===form.elements.settingId.value);
  const current=document.querySelector('#transfer-current-balance'),after=document.querySelector('#transfer-after-balance');
  if(!item){current.textContent='積立を選んでください';after.textContent='—';after.classList.remove('negative');return;}
  const balance=D.balance(state,item.id),amount=Number(form.elements.amount.value||0);
  current.textContent=yen(balance);
  const projected=balance+(form.elements.kind.value==='withdrawal'?-amount:amount);
  after.textContent=Number.isSafeInteger(projected)?yen(projected):'金額を確認してください';
  after.classList.toggle('negative',projected<0);
}
function receiptForm() {
  return `<section class="panel"><h2>レシート画像を保存</h2><p class="muted">レシートに印字された購入日が読める写真を選んでください。</p><form id="receipt-form"><label>レシート画像<input name="image" type="file" accept="image/jpeg,image/png,image/webp" required></label><p class="hint">JPEG・PNG・WebP、8MBまで。</p><div class="form-actions"><button type="submit">画像を保存</button></div></form></section><section class="panel"><h2>保存したレシート</h2><p class="hint">購入日はレシートで確認できた日付です。保存日時とは別に表示します。</p>${renderReceipts()}</section>`;
}
function renderReceipts() {
  return list('receipts').length?list('receipts').slice().reverse().map(r=>`<article class="receipt-row"><div class="row-head"><h3>${esc(r.fileName||'レシート')}</h3><span class="pill ${r.status==='needsReview'?'review':''}">${{pending:'解析待ち',needsReview:'確認待ち',imported:'取込済み',failed:'保存失敗'}[r.status]||esc(r.status)}</span></div><p class="muted">購入日：${esc(r.purchaseDate||'未確認')}<br>保存日時：${esc(savedTime(r.uploadedAt))}</p>${r.reason?`<p class="muted">${esc(r.reason)}</p>`:''}${button('receipt-image','画像を見る',r.id)}${r.status==='needsReview' ? button('receipt-pending','再解析待ちにする',r.id) : ''}</article>`).join(''):'<div class="empty">保存したレシートは、ここに並びます。</div>';
}
function renderRegister() {
  return heading('登録','支出、積立の移動、レシートの記録')+`<div class="tabs" role="tablist" aria-label="登録の種類">${[['expense','支出'],['transfer','積立'],['receipt','レシート']].map(([key,label])=>`<button type="button" role="tab" aria-selected="${tab===key}" data-tab="${key}">${label}</button>`).join('')}</div>`+(tab==='expense'?expenseForm():tab==='transfer'?transferForm():receiptForm());
}
function historyGroups(expenses) {
  const receipts = new Map(list('receipts').map(r=>[r.id,r]));
  const groups = new Map();
  for(const e of expenses){
    const key=e.receiptId?`receipt:${e.receiptId}`:`expense:${e.id}`;
    if(!groups.has(key))groups.set(key,{id:e.id,receipt:receipts.get(e.receiptId),items:[]});
    groups.get(key).items.push(e);
  }
  return [...groups.values()];
}
function purchaseTitle(group) {return group.receipt?(group.receipt.merchant||'レシート'):(group.items[0].description||group.items[0].category);}
function purchaseDate(group) {return group.receipt?.purchaseDate||group.items[0].useDate;}
function expenseActions(e) {return `${button('edit-expense','編集',e.id)}${button('delete-expense','削除',e.id,'danger small')}`;}
function renderHistory() {
  const expenses=list('expenses').filter(e=>e.accountingMonth===month).sort((a,b)=>b.useDate.localeCompare(a.useDate));
  const groups=historyGroups(expenses);
  const transfers=list('transfers').filter(t=>t.month===month).sort((a,b)=>b.date.localeCompare(a.date));
  return heading('履歴','計上月ごとの支出と積立の移動')+`<section class="panel"><div class="row-head"><h2>支出</h2><span class="muted">${groups.length}件 · ${yen(expenses.reduce((n,e)=>n+e.amount,0))}</span></div>${groups.length?groups.map(group=>{
    const e=group.items[0],date=purchaseDate(group),title=purchaseTitle(group);
    const methods=[...new Set(group.items.map(item=>PAYMENTS[item.paymentMethod]))].join('・');
    const fixedLabel=group.items.every(item=>item.fixed)?' · 固定費':group.items.some(item=>item.fixed)?' · 一部固定費':'';
    return `<article class="entry history-entry"><button type="button" class="history-open" data-action="expense-detail" data-id="${esc(e.id)}" aria-label="${esc(dateLabel(date)+' '+title+'の詳細')}"><span class="entry-date">${date.slice(8)}<small>${date.slice(5,7)}月</small></span><span class="entry-copy"><span class="entry-title">${esc(title)}</span><span class="muted">${group.receipt?`${group.items.length}明細 · `:esc(e.category)+' · '}${methods}${fixedLabel}<br>利用日 ${esc(date)} ／ 計上月 ${esc(month)}</span></span><span class="entry-right"><strong>${yen(group.items.reduce((n,item)=>n+item.amount,0))}</strong><span class="detail-cue">詳細 ›</span></span></button>${!group.receipt?`<div class="entry-actions">${expenseActions(e)}</div>`:''}</article>`;
  }).join(''):'<div class="empty"><strong>この月の支出はありません。</strong>「登録」から支出を記録できます。</div>'}</section><section class="panel"><h2>積立の移動</h2>${transfers.length?transfers.map(t=>`<article class="entry"><div class="entry-date">${t.date.slice(8)}<small>${t.date.slice(5,7)}月</small></div><div><h3>${esc(savings().find(s=>s.id===t.settingId)?.name||'積立')}</h3><p class="muted">${t.kind==='deposit'?'入金':'取り崩し'} · ${esc(t.date)}${t.expenseId?' · 購入に関連付け済み':''}</p>${t.memo?`<p class="muted">${esc(t.memo)}</p>`:''}</div><div class="entry-right"><strong>${yen(t.amount)}</strong>${button('delete-transfer','削除',t.id,'danger small')}</div></article>`).join(''):'<div class="empty">この月の入金・取り崩しはありません。</div>'}</section><section id="image-preview" hidden></section>`;
}
function closeDetail() {
  const dialog=document.querySelector('#expense-detail');
  if(!dialog)return;
  closeImage();dialog.close();dialog.remove();
}
function showExpenseDetail(id) {
  const expense=list('expenses').find(e=>e.id===id);if(!expense)return;
  closeDetail();closeImage();
  const items=expense.receiptId?list('expenses').filter(e=>e.receiptId===expense.receiptId):[expense];
  const receipt=list('receipts').find(r=>r.id===expense.receiptId);
  const group={receipt,items},date=purchaseDate(group),title=purchaseTitle(group);
  const dialog=document.createElement('dialog');dialog.id='expense-detail';dialog.className='expense-detail';dialog.setAttribute('aria-labelledby','expense-detail-title');
  dialog.innerHTML=`<div class="row-head detail-head"><div><p class="muted">${esc(dateLabel(date))}</p><h2 id="expense-detail-title">${esc(title)}</h2></div>${button('close-detail','閉じる')}</div><p class="hint">金額は数量分の合計です。</p><div class="purchase-items">${items.map(e=>`<article class="purchase-item" data-expense-id="${esc(e.id)}"><div class="row-head"><h3>${esc(e.description||e.category)}</h3><strong class="number">${yen(e.amount)}</strong></div><p class="muted">${esc(e.category)}${e.quantity!=null?' × '+e.quantity:' · 数量未確認'} · ${PAYMENTS[e.paymentMethod]}${e.fixed?' · 固定費':''}</p><p class="muted">利用日 ${esc(e.useDate)} ／ 計上月 ${esc(e.accountingMonth)}</p>${e.fundingSettingId?`<p class="muted">積立：${esc(savings().find(x=>x.id===e.fundingSettingId)?.name||'未設定')}</p>`:''}${e.memo?`<p class="muted">${esc(e.memo)}</p>`:''}${sessionRole==='editor'?`<div class="entry-actions">${expenseActions(e)}</div>`:''}</article>`).join('')}</div><div class="account-line emphasis"><span>購入合計</span><strong>${yen(items.reduce((n,e)=>n+e.amount,0))}</strong></div>${items.some(e=>e.accountingMonth!==month)?`<p class="hint">${esc(monthLabel(month))}に計上：${yen(items.filter(e=>e.accountingMonth===month).reduce((n,e)=>n+e.amount,0))}。履歴の合計は表示月の明細だけです。</p>`:''}${receipt?`<div class="form-actions">${button('receipt-image','レシート画像を見る',receipt.id)}</div>`:''}`;
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeDetail();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeDetail();}});
  document.body.append(dialog);dialog.showModal();
}
function settingForm() {
  const s=settingEdit||{kind:'fixed',name:'',plannedAmount:'',category:'必要経費',paymentMethod:'bank',openingBalance:0,targetAmount:0,active:true};
  return `<section class="panel scroll-anchor" id="setting-panel"><h2>${settingEdit?'設定を編集':'毎月の項目を追加'}</h2>${formStart('setting-form')}<label>種類<select name="kind" ${settingEdit?'disabled':''}>${options(['fixed','saving'],s.kind,k=>k==='fixed'?'固定費':'積立')}</select></label>${field('name','名前',s.name,'text','required maxlength="100"')}${moneyField('plannedAmount','毎月の予定金額（円）',s.plannedAmount)}${paymentField(s.paymentMethod)}${categoryField(s.category)}${moneyField('openingBalance','開始残高（積立）',s.openingBalance)}${moneyField('targetAmount','目標金額（積立・任意）',s.targetAmount,'')}<label class="full">メモ<textarea name="memo" maxlength="500">${esc(s.memo)}</textarea></label>${formEnd(settingEdit?'設定を保存':'項目を追加',settingEdit?'cancel-setting':'')}<p class="hint">変更は次に作る月の予定へ反映します。すでに作成した月の予定は変わりません。</p></section>`;
}
function renderSettings() {
  const plans=list('plans').filter(p=>p.month===month);
  return heading('毎月の設定','固定費と積立の予定')+`<section class="panel settings-intro"><h2>固定費・積立</h2>${list('settings').length?list('settings').map(s=>`<div class="setting-row"><div class="row-head"><div><h3>${esc(s.name)}</h3><span class="muted">${s.kind==='saving'?'積立':'固定費'} · ${yen(s.plannedAmount)} / 月${!s.active?' · 停止中':''}</span></div><div>${button('edit-setting','編集',s.id)}${button('toggle-setting',s.active?'停止':'再開',s.id)}</div></div></div>`).join(''):'<div class="empty"><strong>毎月の項目はありません。</strong>固定費や積立を追加してください。</div>'}</section>${settingForm()}<section class="panel"><h2>${esc(month)} の予定</h2><p class="hint">この月だけ金額を変えたいときに。予定の変更だけでは支出や積立実績は増えません。</p>${plans.length?plans.map(p=>`<form class="monthly-form" data-plan-id="${esc(p.id)}"><h3>${esc(p.name)} <span class="pill">${p.kind==='saving'?'積立':'固定費'}</span></h3><div class="form-grid">${moneyField('plannedAmount','この月の予定金額',p.plannedAmount)}<label>メモ<input name="memo" value="${esc(p.memo)}" maxlength="500"></label></div><div class="form-actions"><button type="submit" class="quiet">この月の予定を保存</button></div></form>`).join(''):'<div class="empty">この月の予定はありません。項目を追加すると、次に開く月から予定が作られます。</div>'}</section>`;
}

function render() {
  closeDetail();
  if (!state) return renderAuth();
  closeImage();
  document.querySelector('#navigation').hidden=false;
  document.querySelector('#logout').hidden=false;
  document.querySelector('#mode-note').hidden=!transport?.isDemo;
  document.querySelector('#mode-note').textContent=transport?.isDemo?'サンプルを表示中 · 入力は保存されません':' ';
  main.innerHTML=page==='home'?renderHome():page==='register'?renderRegister():page==='history'?renderHistory():renderSettings();
  if(sessionRole==='viewer'){
    if(page==='register')main.innerHTML=heading('閲覧のみ','このアカウントでは記録の確認ができます。')+'<section class="panel"><p>支出や積立の変更は、編集できるアカウントでログインしてください。</p></section>';
    main.querySelectorAll('form,[data-action="toggle-income"],[data-action="go-transfer"],[data-action="funded-withdraw"],[data-action="edit-expense"],[data-action="delete-expense"],[data-action="delete-transfer"],[data-action="edit-setting"],[data-action="toggle-setting"]').forEach(el=>el.hidden=true);
    document.querySelector('#mode-note').hidden=false;document.querySelector('#mode-note').textContent='閲覧のみ';
  }
  document.querySelectorAll('[data-page]').forEach(el=>{if(el.dataset.page===page)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  updateTransferBalance();
  setBusy(busy);
}
function setBusy(value) {
  busy=value;
  document.querySelectorAll('form button[type="submit"], [data-action="delete-expense"], [data-action="delete-transfer"], [data-action="toggle-setting"]').forEach(el=>el.disabled=value || !!pendingCommand);
  document.querySelector('#retry').disabled=value;
  main.setAttribute('aria-busy',String(value));
}
async function mutate(type,payload,onSuccess=()=>render(),exact=null) {
  if (busy || (pendingCommand && !exact) || sessionRole==='viewer') return;
  clearMessages();
  const command=exact||{type,payload,operationId:crypto.randomUUID(),expectedRevision:state.revision};
  const epoch=authEpoch;
  pendingSuccess=onSuccess;
  setBusy(true);
  try {
    const response=command.type==='uploadReceipt'?await transport.uploadReceipt({...command.payload,operationId:command.operationId}):await transport.mutate(command);
    if(epoch!==authEpoch)return;
    state=response.state;
    pendingCommand=null; document.querySelector('#pending').hidden=true;
    const successNotice=onSuccess(response.result);
    message(typeof successNotice==='string'?successNotice:'保存しました。');
  } catch(error) {
    if(epoch!==authEpoch)return;
    if(['AUTH_REQUIRED','AUTH_FORBIDDEN','UNAUTHENTICATED','UNAUTHORIZED'].includes(error.code)){await logout();message('ログインの有効期限が切れました。Googleでログインし直してください。',true);return;}
    if(error.code==='CONFLICT'){
      try{const latest=await transport.load();if(epoch!==authEpoch)return;state=latest;pendingCommand=null;pendingSuccess=null;document.querySelector('#pending').hidden=true;message('最新情報を読み込みました。入力内容を確認して、もう一度保存してください。',true);return;}catch{}
    }
    const retryable = ['TIMEOUT','NETWORK','NETWORK_ERROR','TRANSPORT_ERROR','CONNECTION_ERROR'].includes(error.code) || /timeout|timed out|通信|接続|ネットワーク|fetch/i.test(error.message);
    if (retryable) { pendingCommand=command;document.querySelector('#pending').hidden=false; }
    message(error.message||'保存できませんでした。入力を確認してください。',true);
  } finally { if(epoch===authEpoch)setBusy(false); }
}
async function ensureMonth() {
  if (materialized.has(month)||sessionRole==='viewer') return;
  const captured=month;
  const existing=new Set(list('plans').filter(plan=>plan.month===captured).map(plan=>plan.settingId));
  const missing=list('settings').some(setting=>setting.active&&!existing.has(setting.id));
  if(captured<today().slice(0,7)||!missing){materialized.add(captured);return;}
  await mutate('materializeMonth',{month:captured},()=>{materialized.add(captured);render();});
}
function closeImage(invalidate=true) { if(invalidate)imageRequest++;if(imageUrl){URL.revokeObjectURL(imageUrl);imageUrl=null;} }
async function loadSession(demo=false) {
  const epoch=authEpoch;
  const loaded=await transport.load();
  if(epoch!==authEpoch)return;
  state=loaded;
  if(demo)transport.isDemo=true;
  render();
  await ensureMonth();
  if(!pendingCommand)message('');
}
function switchPage(next) {page=next;clearMessages();render();main.focus({preventScroll:true});window.scrollTo({top:0,behavior:'auto'});}
function getForm(form) {return Object.fromEntries(new FormData(form).entries());}
const num = value => Number(value || 0);

document.addEventListener('submit',async event=>{
  const form=event.target;if(!(form instanceof HTMLFormElement))return;
  event.preventDefault();if(!form.reportValidity() || busy || pendingCommand)return;
  const p=getForm(form);
  if(form.id==='expense-form'){
    const plan=list('plans').find(x=>x.id===p.planId);
    const payload={...editing,...p,id:editing?.id||crypto.randomUUID(),quantity:p.quantity?Number(p.quantity):null,amount:num(p.amount),fixed:!!plan||p.fixed==='on',settingId:plan?.settingId||'',planId:plan?.id||'',fundingSettingId:p.fundingSettingId||'',manualEdited:!!editing};
    if(plan&&plan.month!==p.accountingMonth)delete payload.planId;
    await mutate('upsertExpense',payload,()=>{editing=null;render();if(payload.accountingMonth!==month)return `保存しました。計上月は${monthLabel(payload.accountingMonth)}です。`;});
  } else if(form.id==='income-form')await mutate('saveIncome',{month,amount:num(p.amount)});
  else if(form.id==='bill-form')await mutate('saveBill',{month,confirmedAmount:num(p.confirmedAmount),memo:p.memo});
  else if(form.id==='transfer-form'){
    if(p.kind==='deposit')p.expenseId='';
    await mutate('saveTransfer',{...p,id:crypto.randomUUID(),month:p.date.slice(0,7),amount:num(p.amount)},()=>{transferPreset=null;render();});
  } else if(form.id==='setting-form'){
    const isNew=!settingEdit;
    await mutate('saveSetting',{...settingEdit,...p,id:settingEdit?.id||crypto.randomUUID(),kind:settingEdit?.kind||p.kind,plannedAmount:num(p.plannedAmount),openingBalance:num(p.openingBalance),targetAmount:num(p.targetAmount),active:settingEdit?.active??true},()=>{settingEdit=null;if(isNew)materialized.delete(month);render();if(isNew)setTimeout(()=>ensureMonth(),0);});
  } else if(form.matches('[data-plan-id]')){
    const plan=list('plans').find(x=>x.id===form.dataset.planId);
    await mutate('savePlan',{...plan,plannedAmount:num(p.plannedAmount),memo:p.memo});
  } else if(form.id==='receipt-form')await uploadReceipt(form);
});
document.addEventListener('input',event=>{if(event.target.closest('#transfer-form'))updateTransferBalance();});

document.addEventListener('change',async event=>{
  const el=event.target;
  if(el.id==='month'){
    if(busy||pendingCommand){el.value=month;message('処理中の保存を確認してから月を変えてください。',true);return;}
    if(!/^\d{4}-\d{2}$/.test(el.value))return;
    month=el.value;editing=null;transferPreset=null;render();await ensureMonth();
  }
  if(el.closest('#expense-form') && (el.name==='useDate'||el.name==='paymentMethod')){
    const f=el.form;const date=f.elements.useDate.value;
    if(date)f.elements.accountingMonth.value=f.elements.paymentMethod.value==='card'?D.cardMonth(date):date.slice(0,7);
  }
  if(el.closest('#expense-form') && el.name==='planId'){
    const p=list('plans').find(x=>x.id===el.value);if(p){const f=el.form;f.elements.amount.value=p.plannedAmount;f.elements.category.value=p.category;f.elements.paymentMethod.value=p.paymentMethod;f.elements.description.value=p.name;f.elements.fixed.checked=true;f.elements.accountingMonth.value=p.paymentMethod==='card'?D.cardMonth(f.elements.useDate.value):f.elements.useDate.value.slice(0,7);}
  }
  if(el.closest('#expense-form')){
    const accounting=el.form.elements.accountingMonth.value;
    if(accounting){
      document.querySelector('#accounting-label').textContent=monthLabel(accounting);
      const selector=el.form.elements.planId,chosen=selector.value;
      selector.innerHTML=settingOptions(list('plans').filter(plan=>plan.kind==='fixed'&&plan.month===accounting),chosen,'予定を選ばない');
    }
  }
  if(el.closest('#transfer-form') && el.name==='expenseId'){
    const expense=list('expenses').find(e=>e.id===el.value);if(expense){const f=el.form;f.elements.kind.value='withdrawal';f.elements.amount.value=withdrawalRemaining(expense);if(expense.fundingSettingId)f.elements.settingId.value=expense.fundingSettingId;}
  }
  if(el.closest('#transfer-form'))updateTransferBalance();
});
document.addEventListener('click',async event=>{
  const homeLink=event.target.closest('.brand');if(homeLink&&state){event.preventDefault();if(!busy&&!pendingCommand)switchPage('home');return;}
  const btn=event.target.closest('button');if(!btn)return;
  if(btn.id==='demo-login'){
    try{authEpoch++;sessionRole='editor';transport?.close?.();transport=createDemoTransport();transport.isDemo=true;await loadSession(true);}catch(error){message(error.message,true);}return;
  }
  if(btn.id==='google-login'){googleClient?.requestCode();return;}
  if(btn.id==='logout'){await logout();return;}
  if(btn.id==='retry'){if(pendingCommand)await mutate(null,null,pendingSuccess,pendingCommand);return;}
  if(busy&&(btn.dataset.page||btn.dataset.tab||btn.dataset.action)){message('保存が終わるまでお待ちください。入力はこの画面に残っています。',true);return;}
  if(pendingCommand&&(btn.dataset.page||btn.dataset.tab||btn.dataset.action)){message('同じ内容で再試行して保存結果を確認してください。入力はこの画面に残っています。',true);return;}
  if(btn.dataset.page){switchPage(btn.dataset.page);return;}
  if(btn.dataset.tab){tab=btn.dataset.tab;render();return;}
  const action=btn.dataset.action,id=btn.dataset.id;
  if(action==='expense-detail'){showExpenseDetail(id);return;}
  if(action==='close-detail'){closeDetail();return;}
  if(action==='toggle-income'){const panel=document.querySelector('#income-edit');panel.hidden=!panel.hidden;if(!panel.hidden)panel.querySelector('input').focus();}
  if(action==='go-transfer'){tab='transfer';switchPage('register');}
  if(action==='edit-expense'){closeDetail();editing={...list('expenses').find(e=>e.id===id)};tab='expense';switchPage('register');}
  if(action==='cancel-expense'){editing=null;render();}
  if(action==='delete-expense' && confirm('この支出を削除しますか？'))await mutate('deleteExpense',{id});
  if(action==='delete-transfer' && confirm('この積立の移動を削除しますか？'))await mutate('deleteTransfer',{id});
  if(action==='edit-setting'){settingEdit={...list('settings').find(s=>s.id===id)};render();document.querySelector('#setting-panel').scrollIntoView({block:'start'});}
  if(action==='cancel-setting'){settingEdit=null;render();}
  if(action==='toggle-setting'){const setting=list('settings').find(s=>s.id===id);await mutate('saveSetting',{...setting,active:!setting.active});}
  if(action==='funded-withdraw'){
    const e=list('expenses').find(x=>x.id===id);transferPreset={kind:'withdrawal',expenseId:id,settingId:e.fundingSettingId,amount:withdrawalRemaining(e),date:today()};tab='transfer';switchPage('register');message(e.paymentMethod==='card'?'カードの支払いが済んでいることを確認し、実際の移動日を入力して保存してください。':'実際に積立から支払った日と金額を確認して保存してください。');
  }
  if(action==='receipt-image')await showImage(id,btn);
  if(action==='close-image'){closeImage();btn.closest('.image-panel').remove();}
  if(action==='receipt-pending')await mutate('setReceiptStatus',{id,status:'pending',reason:''});
});

async function uploadReceipt(form) {
  const file=form.elements.image.files[0];
  if(!file)return;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024){message('JPEG・PNG・WebPの画像を8MB以内で選んでください。',true);return;}
  setBusy(true);clearMessages();
  const epoch=authEpoch;
  try{
    const bytes=new Uint8Array(await file.arrayBuffer());
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    const imageHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    let raw='';for(let i=0;i<bytes.length;i+=0x8000)raw+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
    if(epoch!==authEpoch)return;
    setBusy(false);
    await mutate('uploadReceipt',{imageHash,fileName:file.name,mimeType:file.type,base64:btoa(raw)});
  }catch(error){message(error.message||'画像を保存できませんでした。画像は選択したままです。',true);}finally{setBusy(false);}
}
async function showImage(id,trigger) {
  clearMessages();const epoch=authEpoch;
  const target=document.querySelector('#expense-detail')||main;const request=++imageRequest;
  const label=trigger?.textContent;
  if(trigger){trigger.disabled=true;trigger.textContent='画像を読み込み中…';}
  target.querySelector('.image-error')?.remove();
  try{
    const result=await transport.receiptImage(id);if(epoch!==authEpoch||request!==imageRequest||!target.isConnected)return;
    closeImage(false);const parsed=/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(result.dataUrl||'');const base64=result.base64||result.data||parsed?.[2];const mime=result.mimeType||parsed?.[1]||'image/jpeg';
    if(!['image/jpeg','image/png','image/webp'].includes(mime) || typeof base64!=='string')throw new Error('画像データを確認できませんでした。');
    const raw=atob(base64);const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));imageUrl=URL.createObjectURL(new Blob([bytes],{type:mime}));
    let host=target.querySelector('[data-image-preview],#image-preview');if(!host){host=document.createElement('section');host.dataset.imagePreview='';target.append(host);}host.hidden=false;
    host.innerHTML=`<div class="image-panel"><div class="row-head"><h2>レシート画像</h2>${button('close-image','閉じる')}</div><img class="private-image" src="${esc(imageUrl)}" alt="保存したレシート画像"></div>`;host.scrollIntoView({block:'start'});
  }catch(error){
    if(epoch!==authEpoch||request!==imageRequest||!target.isConnected)return;
    const text=error.message||'画像を取得できませんでした。';
    if(target.id==='expense-detail'){const alert=document.createElement('p');alert.className='message error image-error';alert.setAttribute('role','alert');alert.textContent=text;target.append(alert);}
    else message(text,true);
  }finally{if(trigger?.isConnected){trigger.disabled=false;trigger.textContent=label;}}
}
async function logout() {
  authEpoch++;closeImage();const previous=transport;
  state=null;pendingCommand=null;pendingSuccess=null;editing=null;settingEdit=null;transferPreset=null;materialized.clear();page='home';tab='expense';busy=false;loginLoading=false;sessionRole='editor';
  main.replaceChildren();document.querySelector('#pending').hidden=true;document.querySelector('#mode-note').hidden=true;clearMessages();
  transport=null;renderAuth();
  try{await previous?.logout?.();}catch{}finally{previous?.close?.();}
  try{await initializeConfig();}catch(error){message(error.message,true);}
}
async function initializeConfig() {
  const epoch=authEpoch;
  config=null;googleClient=null;loginPreparation=null;loginLoading=false;
  try{const response=await fetch('./runtime-config.json',{cache:'no-store'});if(response.ok)config=await response.json();}catch{}
  if(config?.mode!=='google' || !config.clientId || !config.bridgeUrl){config=null;renderAuth();return;}
  transport=createTransport(config);const loginTransport=transport;const loginConfig=config;renderAuth();
  try{
    await new Promise((resolve,reject)=>{if(globalThis.google?.accounts?.oauth2){resolve();return;}const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.onload=resolve;script.onerror=()=>reject(new Error('Googleログインを読み込めませんでした。通信を確認して再読み込みしてください。'));document.head.append(script);});
    if(epoch!==authEpoch)return;
    googleClient=google.accounts.oauth2.initCodeClient({client_id:loginConfig.clientId,scope:'openid email profile',ux_mode:'popup',callback:async result=>{
      if(epoch!==authEpoch)return;
      if(result.error){message('Googleログインが完了しませんでした。もう一度お試しください。',true);return;}
      loginLoading=true;clearMessages();renderAuth();
      try{loginPreparation=await loginTransport.prepareLogin();const loginResult=await loginTransport.login(result.code,loginPreparation.state);if(epoch!==authEpoch)return;sessionRole=loginResult.role||'editor';await loadSession();}
      catch(error){if(epoch!==authEpoch)return;message(error.message||'ログインできませんでした。',true);}
      finally{if(epoch===authEpoch){loginLoading=false;if(!state)renderAuth();}}
    },error_callback:()=>message('ログイン画面が閉じられました。もう一度ログインできます。',true)});
    renderAuth();
  }catch(error){if(epoch===authEpoch){message(error.message,true);renderAuth();}}
}
await initializeConfig();
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
