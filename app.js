// 育児ログ（家族共有版）
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy,
  onSnapshot, writeBatch, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { ICON, BABY } from './icons.js';

/* ---------- Firebase ---------- */
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
// オフラインでも記録できるように端末内にキャッシュ（電波が戻ったら自動で同期）
const fs = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

/* ---------- 定数・ユーティリティ ---------- */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const LEGACY_KEY = 'babylog_v1';
const TYPES = {
  feed:   {label:'授乳', icon:ICON.feed, color:'var(--g-feed)'},
  sleep:  {label:'睡眠', icon:ICON.sleep, color:'var(--g-sleep)'},
  diaper: {label:'おむつ', icon:ICON.diaper, color:'var(--g-diaper)'},
  temp:   {label:'体温', icon:ICON.temp, color:'var(--g-temp)'},
  memo:   {label:'メモ', icon:ICON.memo, color:'var(--g-memo)'}
};
const startOfDay = t => { const d = new Date(t); d.setHours(0,0,0,0); return d.getTime(); };
const hm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const toInput = t => { const d = new Date(t); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes()); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const r1 = x => Math.round(x*10)/10;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleepDur = e => (e.end ?? Date.now()) - e.t;
function durTxt(ms){
  const m = Math.round(ms / MIN);
  const h = Math.floor(m / 60), mm = m % 60;
  return h ? `${h}時間${pad(mm)}分` : `${mm}分`;
}

/* ---------- 状態 ---------- */
const S = {
  user: null,
  familyId: null,
  baby: {name:'', birth:''},
  members: {},     // uid -> {name, photo}
  events: [],
  ready: false,
  unsubs: []
};
let view = 'today';
let rangeDays = 7;
let F = null;

/* ---------- 画面の出し分け ---------- */
function showScreen(name){
  // name: loading / login / onboard / app
  document.body.dataset.screen = name;
  $('v-loading').hidden = name !== 'loading';
  $('v-login').hidden = name !== 'login';
  $('v-onboard').hidden = name !== 'onboard';
  if(name !== 'app') ['today','stats','set'].forEach(v => $('v-' + v).hidden = true);
  if(name === 'app') render();
  else renderHeader();
}

function renderHeader(){
  $('title').textContent = S.baby.name ? S.baby.name + 'の育児ログ' : '育児ログ';
  $('age').textContent = document.body.dataset.screen === 'app' ? ageTxt() : '';
}

function ageTxt(){
  if(!S.baby.birth) return '設定で名前と生年月日を入れると月齢が出ます';
  const b = new Date(S.baby.birth + 'T00:00');
  const now = new Date();
  const days = Math.floor((startOfDay(now) - b.getTime()) / DAY);
  if(days < 0) return '';
  let m = (now.getFullYear()-b.getFullYear())*12 + now.getMonth() - b.getMonth();
  if(now.getDate() < b.getDate()) m--;
  const name = S.baby.name ? S.baby.name + '・' : '';
  return m >= 1 ? `${name}生後${m}か月（${days}日目）` : `${name}生後${days}日目`;
}

/* ---------- ログイン ---------- */
$('loginBtn').onclick = async () => {
  try{
    await signInWithPopup(auth, new GoogleAuthProvider());
  }catch(e){
    console.error(e);
    if(e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    if(e.code === 'auth/popup-blocked') toast('ポップアップがブロックされました。許可してもう一度押してね');
    else if(e.code === 'auth/unauthorized-domain') toast('このURLがFirebaseに登録されていません（READMEの手順4）');
    else toast('ログインできませんでした（' + (e.code || 'エラー') + '）');
  }
};

onAuthStateChanged(auth, async user => {
  stopListeners();
  S.user = user;
  S.familyId = null; S.events = []; S.members = {}; S.baby = {name:'', birth:''}; S.ready = false;
  if(!user){ showScreen('login'); return; }
  showScreen('loading');
  try{
    const snap = await getDoc(doc(fs, 'users', user.uid));
    const fid = snap.exists() ? snap.data().familyId : null;
    if(fid && await canReadFamily(fid)){
      startFamily(fid);
    } else {
      renderOnboard();
      showScreen('onboard');
    }
  }catch(e){
    console.error(e);
    renderOnboard();
    showScreen('onboard');
  }
});

async function canReadFamily(fid){
  try{
    const f = await getDoc(doc(fs, 'families', fid));
    return f.exists();
  }catch(e){
    return false;   // メンバーから外れている
  }
}

/* ---------- 家族をはじめる・参加する ---------- */
function renderOnboard(){
  const code = new URLSearchParams(location.search).get('join') || '';
  $('v-onboard').innerHTML = `
    <div class="card hello">
      <div class="hello-ic">${BABY}</div>
      <div><b>ようこそ、${esc(S.user?.displayName || '')}さん</b><small>家族の記録をはじめましょう</small></div>
    </div>
    ${code ? '' : `
    <div class="card">
      <h3>はじめて使う</h3>
      <p class="note">赤ちゃんの情報を入れて、家族のノートを作ります。あとから家族を招待できます。</p>
      <div class="set-row"><label>赤ちゃんの名前（ニックネームでOK）</label><input id="ob_name" placeholder="はなちゃん"></div>
      <div class="set-row"><label>生年月日</label><input id="ob_birth" type="date"></div>
      <div class="btns"><button class="primary" id="ob_create">家族のノートを作る</button></div>
    </div>`}
    <div class="card">
      <h3>招待コードで参加</h3>
      <p class="note">家族から届いた招待コードを入れてください。</p>
      <div class="set-row"><label>招待コード</label><input id="ob_code" class="code-in" value="${esc(code)}" placeholder="ABCD2345" autocapitalize="characters" autocomplete="off"></div>
      <div class="btns"><button class="primary" id="ob_join">参加する</button></div>
    </div>
    ${code ? '<button class="linkbtn center" id="ob_new">自分で新しく家族のノートを作る</button>' : ''}
    <button class="linkbtn center" id="ob_logout">ログアウト</button>
  `;
  if($('ob_create')) $('ob_create').onclick = createFamily;
  $('ob_join').onclick = joinFamily;
  $('ob_logout').onclick = () => signOut(auth);
  if($('ob_new')) $('ob_new').onclick = () => { history.replaceState(null, '', location.pathname); renderOnboard(); };
}

function myMember(){
  return { name: S.user.displayName || 'わたし', photo: S.user.photoURL || '' };
}

async function createFamily(){
  const btn = $('ob_create');
  btn.disabled = true;
  try{
    const famRef = doc(collection(fs, 'families'));
    const b = writeBatch(fs);
    b.set(famRef, {
      createdBy: S.user.uid,
      baby: { name: $('ob_name').value.trim(), birth: $('ob_birth').value },
      createdAt: serverTimestamp()
    });
    b.set(doc(fs, 'families', famRef.id, 'members', S.user.uid), { ...myMember(), role: 'owner', joinedAt: serverTimestamp() });
    b.set(doc(fs, 'users', S.user.uid), { familyId: famRef.id });
    await b.commit();
    toast('家族のノートを作りました ✓');
    startFamily(famRef.id);
  }catch(e){
    console.error(e);
    toast('作成できませんでした（' + (e.code || 'エラー') + '）');
    btn.disabled = false;
  }
}

async function joinFamily(){
  const code = $('ob_code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if(code.length < 6){ toast('招待コードを入れてね'); return; }
  const btn = $('ob_join');
  btn.disabled = true;
  try{
    let inv;
    try{
      inv = await getDoc(doc(fs, 'invites', code));
    }catch(e){
      inv = null;
    }
    if(!inv || !inv.exists()){
      toast('コードが見つからないか、期限切れです');
      btn.disabled = false;
      return;
    }
    const fid = inv.data().familyId;
    const b = writeBatch(fs);
    b.set(doc(fs, 'families', fid, 'members', S.user.uid), { ...myMember(), code, joinedAt: serverTimestamp() });
    b.set(doc(fs, 'users', S.user.uid), { familyId: fid });
    await b.commit();
    history.replaceState(null, '', location.pathname);
    toast('家族に参加しました ✓');
    startFamily(fid);
  }catch(e){
    console.error(e);
    toast('参加できませんでした（' + (e.code || 'エラー') + '）');
    btn.disabled = false;
  }
}

/* ---------- リアルタイム同期 ---------- */
function stopListeners(){
  S.unsubs.forEach(u => u());
  S.unsubs = [];
}

function startFamily(fid){
  stopListeners();
  S.familyId = fid;
  view = 'today';
  showScreen('loading');
  let gotEvents = false, gotFamily = false;
  const ready = () => {
    if(gotEvents && gotFamily && !S.ready){
      S.ready = true;
      showScreen('app');
      offerLegacyImport();
    } else if(S.ready) render();
  };
  const onErr = e => {
    console.error(e);
    if(e.code === 'permission-denied'){
      toast('この家族のノートを見る権限がありません');
      stopListeners();
      renderOnboard();
      showScreen('onboard');
    }
  };

  S.unsubs.push(onSnapshot(doc(fs, 'families', fid), snap => {
    S.baby = snap.data()?.baby || {name:'', birth:''};
    gotFamily = true; ready();
  }, onErr));

  S.unsubs.push(onSnapshot(collection(fs, 'families', fid, 'members'), snap => {
    S.members = {};
    snap.forEach(d => S.members[d.id] = d.data());
    if(S.ready && view === 'set') render();
  }, onErr));

  // 分析で使う直近31日ぶんを購読
  const since = startOfDay(Date.now()) - 31 * DAY;
  const q = query(collection(fs, 'families', fid, 'events'), where('t', '>=', since), orderBy('t'));
  S.unsubs.push(onSnapshot(q, snap => {
    S.events = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    gotEvents = true; ready();
  }, onErr));
}

const eventsCol = () => collection(fs, 'families', S.familyId, 'events');

// 書き込みは待たずに画面へ反映（オフラインでも記録でき、つながったら同期される）
function putEvent(ev){
  const data = { ...ev };
  delete data.id;
  delete data.updatedAt;
  data.by = data.by || S.user.uid;
  data.updatedAt = serverTimestamp();
  setDoc(doc(eventsCol(), ev.id), data).catch(e => { console.error(e); toast('保存に失敗しました（' + (e.code || 'エラー') + '）'); });
}
function removeEvent(id){
  deleteDoc(doc(eventsCol(), id)).catch(e => { console.error(e); toast('削除に失敗しました'); });
}

/* ---------- メイン画面 ---------- */
function render(){
  if(document.body.dataset.screen !== 'app') return;
  renderHeader();
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  ['today','stats','set'].forEach(v => $('v-' + v).hidden = (v !== view));
  if(view === 'today') renderToday();
  else if(view === 'stats') renderStats();
  else renderSet();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => { view = b.dataset.view; render(); window.scrollTo(0,0); });
document.querySelectorAll('.nv').forEach(el => el.innerHTML = ICON[el.dataset.ic]);
$('loginArt').innerHTML = BABY;

function describe(e){
  switch(e.type){
    case 'feed':   return e.sub === 'ミルク'
                    ? `ミルク${e.amount ? ' ' + e.amount + 'ml' : ''}`
                    : `母乳${e.amount ? ' ' + e.amount + '分' : ''}`;
    case 'sleep':  return e.end ? `寝た ${durTxt(e.end - e.t)}` : `睡眠中（${durTxt(Date.now() - e.t)}）`;
    case 'diaper': return esc(e.sub || 'おむつ');
    case 'temp':   return `${esc(e.value)}℃`;
    case 'memo':   return esc(e.memo?.slice(0, 30) || 'メモ');
  }
  return '';
}
const whoName = u => S.members[u]?.name || '';

/* ---------- 今日 ---------- */
function renderToday(){
  const s = startOfDay(Date.now());
  const list = S.events.filter(e => e.t >= s && e.t < s + DAY);
  const feeds = list.filter(e => e.type === 'feed');
  const milk = feeds.filter(e => e.sub === 'ミルク').reduce((a,e) => a + (e.amount || 0), 0);
  const sleeps = list.filter(e => e.type === 'sleep');
  const sleepMs = sleeps.reduce((a,e) => a + sleepDur(e), 0);
  const diapers = list.filter(e => e.type === 'diaper');
  const pee = diapers.filter(e => e.sub === 'おしっこ' || e.sub === '両方').length;
  const poop = diapers.filter(e => e.sub === 'うんち' || e.sub === '両方').length;
  const allFeeds = S.events.filter(e => e.type === 'feed');
  const lastFeed = allFeeds[allFeeds.length - 1];
  const ongoing = S.events.find(e => e.type === 'sleep' && !e.end);

  $('v-today').innerHTML = `
    ${ongoing ? `<div class="banner"><div class="bn-ic">${ICON.sleep}<span>すやすや睡眠中</span></div><small>${hm(ongoing.t)} から ・ 経過 ${durTxt(Date.now() - ongoing.t)}</small></div>` : ''}
    <div class="act-grid">
      <button class="act" style="background:var(--g-feed)" data-act="feed"><b>${ICON.feed}</b>授乳</button>
      <button class="act" style="background:var(--g-sleep)" data-act="sleep"><b>${ongoing ? ICON.wake : ICON.sleep}</b>${ongoing ? '起きた' : '寝た'}</button>
      <button class="act" style="background:var(--g-diaper)" data-act="diaper"><b>${ICON.diaper}</b>おむつ</button>
      <button class="act" style="background:var(--g-temp)" data-act="temp"><b>${ICON.temp}</b>体温</button>
      <button class="act" style="background:var(--g-memo)" data-act="memo"><b>${ICON.memo}</b>メモ</button>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">今日の授乳</div><div class="v">${feeds.length}<small>回</small></div><div class="d">ミルク合計 ${milk}ml</div></div>
      <div class="stat"><div class="k">今日の睡眠</div><div class="v">${durTxt(sleepMs)}</div><div class="d">${sleeps.length}回</div></div>
      <div class="stat"><div class="k">今日のおむつ</div><div class="v">${diapers.length}<small>回</small></div><div class="d">おしっこ ${pee} ・ うんち ${poop}</div></div>
      <div class="stat"><div class="k">前回の授乳から</div><div class="v">${lastFeed ? durTxt(Date.now() - lastFeed.t) : '—'}</div><div class="d">${lastFeed ? hm(lastFeed.t) + ' ' + describe(lastFeed) : 'まだ記録なし'}</div></div>
    </div>
    <div class="card"><h3>今日のタイムライン</h3>${timelineHTML(list)}</div>
  `;
  $('v-today').querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
    const t = b.dataset.act;
    if(t === 'sleep') quickSleep(); else openForm(t);
  });
  $('v-today').querySelectorAll('[data-ev]').forEach(li => li.onclick = () => openForm(null, li.dataset.ev));
}
function timelineHTML(list){
  if(!list.length) return '<div class="empty">まだ記録がありません。上のボタンから記録してね</div>';
  return '<ul class="tl">' + [...list].reverse().map(e => {
    const who = whoName(e.by);
    const sub = e.memo ? esc(e.memo) : TYPES[e.type].label;
    return `
    <li data-ev="${esc(e.id)}">
      <span class="time">${hm(e.t)}</span>
      <span class="dot" style="background:${TYPES[e.type].color}">${TYPES[e.type].icon}</span>
      <span class="txt">${describe(e)}<small>${sub}${who ? ` ・ <span class="who">${esc(who)}</span>` : ''}</small></span>
    </li>`;
  }).join('') + '</ul>';
}
function quickSleep(){
  const on = S.events.find(e => e.type === 'sleep' && !e.end);
  if(on){
    const end = Date.now();
    putEvent({ ...on, end });
    toast('おはよう ☀️ 睡眠 ' + durTxt(end - on.t));
  } else {
    putEvent({ id: uid(), type: 'sleep', t: Date.now(), end: null });
    toast('おやすみ 🌙');
  }
}

/* ---------- 記録フォーム ---------- */
const amtLabel = () => F.type === 'temp' ? '体温 (℃)' : (F.sub === 'ミルク' ? '量 (ml)' : '時間 (分)');
function seg(key, opts, cur){
  return `<div class="seg" data-k="${key}">${opts.map(o => `<button type="button" data-v="${o}" class="${o === cur ? 'on' : ''}">${o}</button>`).join('')}</div>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('.seg button');
  if(!b) return;
  const group = b.parentElement;
  group.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  F[group.dataset.k] = b.dataset.v;
  if(F.type === 'feed' && $('amtLabel')) $('amtLabel').firstChild.textContent = amtLabel();
});

function openForm(type, id){
  const ev = id ? S.events.find(x => x.id === id) : null;
  if(ev) type = ev.type;
  const e = ev || {};
  F = {type, id: e.id || null, by: e.by || null, sub: e.sub || ({feed:'母乳', diaper:'おしっこ'}[type] || null)};

  let h = `<h3 class="fh"><span class="fh-ic" style="background:${TYPES[type].color}">${TYPES[type].icon}</span>${TYPES[type].label}を${ev ? '編集' : '記録'}</h3>`;
  if(ev && whoName(ev.by)) h += `<p class="note">記録した人：${esc(whoName(ev.by))}</p>`;
  if(type === 'feed')   h += seg('sub', ['母乳','ミルク'], F.sub);
  if(type === 'diaper') h += seg('sub', ['おしっこ','うんち','両方'], F.sub);
  if(type === 'feed' || type === 'temp'){
    const v = type === 'temp' ? (e.value ?? '') : (e.amount ?? '');
    h += `<label id="amtLabel">${amtLabel()}<input id="f_amt" type="number" inputmode="decimal" step="any" value="${esc(v)}" placeholder="${type === 'temp' ? '36.5' : ''}"></label>`;
  }
  h += `<label>${type === 'sleep' ? '寝た時間' : '時刻'}<input id="f_t" type="datetime-local" value="${toInput(e.t ?? Date.now())}"></label>`;
  if(type === 'sleep')
    h += `<label>起きた時間（空欄だと睡眠中）<input id="f_end" type="datetime-local" value="${e.end ? toInput(e.end) : ''}"></label>`;
  h += `<label>${type === 'memo' ? '内容' : 'メモ（任意）'}<textarea id="f_note">${esc(e.memo)}</textarea></label>`;
  h += `<div class="btns">${ev ? '<button class="danger" id="f_del">削除</button>' : ''}<button class="ghost" id="f_cancel">やめる</button><button class="primary" id="f_save">保存</button></div>`;
  openSheet(h);
  $('f_save').onclick = saveForm;
  $('f_cancel').onclick = closeSheet;
  if($('f_del')) $('f_del').onclick = delEv;
}
function openSheet(html){ $('sheet').innerHTML = html; $('ov').classList.add('show'); }
function closeSheet(){ $('ov').classList.remove('show'); }
$('ov').onclick = e => { if(e.target === $('ov')) closeSheet(); };

function saveForm(){
  const tv = $('f_t').value;
  if(!tv){ toast('時刻を入れてね'); return; }
  const note = $('f_note').value.trim();
  const ev = {id: F.id || uid(), type: F.type, t: new Date(tv).getTime()};
  if(F.by) ev.by = F.by;

  if(F.type === 'sleep'){
    const en = $('f_end').value;
    ev.end = en ? new Date(en).getTime() : null;
    if(ev.end && ev.end < ev.t){ toast('起きた時間が寝た時間より前です'); return; }
  }
  if(F.type === 'feed'){
    ev.sub = F.sub;
    const v = $('f_amt').value;
    if(v) ev.amount = +v;
  }
  if(F.type === 'diaper') ev.sub = F.sub;
  if(F.type === 'temp'){
    const v = $('f_amt').value;
    if(!v){ toast('体温を入れてね'); return; }
    ev.value = +v;
  }
  if(F.type === 'memo' && !note){ toast('内容を入れてね'); return; }
  if(note) ev.memo = note;

  putEvent(ev);
  closeSheet();
  toast('保存しました ✓');
}
function delEv(){
  if(!F.id) return;
  if(!confirm('この記録を削除しますか？（家族全員の画面から消えます）')) return;
  removeEvent(F.id);
  closeSheet();
  toast('削除しました');
}

/* ---------- 分析 ---------- */
function renderStats(){
  const today = startOfDay(Date.now());
  const days = [];
  for(let i = rangeDays - 1; i >= 0; i--){
    const d = new Date(today); d.setDate(d.getDate() - i); days.push(d.getTime());
  }
  const lbl = s => { const d = new Date(s); return rangeDays > 14 ? String(d.getDate()) : (d.getMonth()+1) + '/' + d.getDate(); };
  const rows = days.map(s => {
    const L = S.events.filter(e => e.t >= s && e.t < s + DAY);
    const feeds = L.filter(e => e.type === 'feed');
    return {
      s, label: lbl(s), L,
      feeds: feeds.length,
      ml: feeds.filter(e => e.sub === 'ミルク').reduce((a,e) => a + (e.amount || 0), 0),
      sleep: L.filter(e => e.type === 'sleep').reduce((a,e) => a + sleepDur(e), 0) / HOUR,
      diaper: L.filter(e => e.type === 'diaper').length
    };
  });

  const start = rows[0].s;
  const n = rows.length;
  const sumOf = k => rows.reduce((a,r) => a + r[k], 0);
  const feedTimes = S.events.filter(e => e.type === 'feed' && e.t >= start).map(e => e.t);
  const gaps = []; for(let i = 1; i < feedTimes.length; i++) gaps.push(feedTimes[i] - feedTimes[i-1]);
  const avgGap = gaps.length ? gaps.reduce((a,b) => a + b, 0) / gaps.length : 0;
  const sleeps = S.events.filter(e => e.type === 'sleep' && e.t >= start);
  const longest = sleeps.length ? Math.max(...sleeps.map(sleepDur)) : 0;

  const railHTML = r => {
    const s = r.s;
    const segs = S.events.filter(e => e.type === 'sleep' && (e.end ?? Date.now()) > s && e.t < s + DAY).map(e => {
      const a = Math.max(e.t, s), b = Math.min(e.end ?? Date.now(), s + DAY);
      return `<div class="s" style="left:${(a-s)/DAY*100}%;width:${(b-a)/DAY*100}%"></div>`;
    }).join('');
    const fd = r.L.filter(e => e.type === 'feed').map(e => `<div class="f" style="left:${(e.t-s)/DAY*100}%"></div>`).join('');
    return `<div class="rail-row"><span class="d">${r.label}</span><div class="rail">${segs}${fd}</div></div>`;
  };

  $('v-stats').innerHTML = `
    <div class="range">${[7,14,30].map(n => `<button class="${n === rangeDays ? 'on' : ''}" data-range="${n}">${n}日間</button>`).join('')}</div>
    <div class="stats">
      <div class="stat"><div class="k">1日あたりの授乳</div><div class="v">${(sumOf('feeds')/n).toFixed(1)}<small>回</small></div><div class="d">期間合計 ${sumOf('feeds')}回</div></div>
      <div class="stat"><div class="k">授乳の平均間隔</div><div class="v">${gaps.length ? durTxt(avgGap) : '—'}</div><div class="d">${gaps.length ? gaps.length + 1 + '回の授乳から算出' : '記録が2回以上で表示'}</div></div>
      <div class="stat"><div class="k">1日あたりの睡眠</div><div class="v">${durTxt(sumOf('sleep')/n*HOUR)}</div><div class="d">期間の平均</div></div>
      <div class="stat"><div class="k">最長の睡眠</div><div class="v">${longest ? durTxt(longest) : '—'}</div><div class="d">期間中の1回あたり</div></div>
    </div>
    ${barsHTML(ICON.feed, '授乳回数（回/日）', rows, 'feeds', 'var(--feed)', v => v)}
    ${barsHTML(ICON.feed, 'ミルク量（ml/日）', rows, 'ml', 'var(--feed)', v => v)}
    ${barsHTML(ICON.sleep, '睡眠時間（時間/日）', rows, 'sleep', 'var(--sleep)', v => r1(v))}
    ${barsHTML(ICON.diaper, 'おむつ回数（回/日）', rows, 'diaper', 'var(--diaper)', v => v)}
    <div class="card">
      <h3>1日の流れ</h3>
      <div class="rail-row"><span class="d"></span><div class="axis"><span>0時</span><span>6時</span><span>12時</span><span>18時</span><span>24時</span></div></div>
      ${[...rows].reverse().map(railHTML).join('')}
      <div class="legend"><span><i style="background:var(--sleep)"></i>睡眠</span><span><i style="background:var(--feed)"></i>授乳</span></div>
    </div>
  `;
  $('v-stats').querySelectorAll('[data-range]').forEach(b => b.onclick = () => { rangeDays = +b.dataset.range; render(); });
}
function barsHTML(icon, title, rows, key, color, fmt){
  const max = Math.max(1, ...rows.map(r => r[key]));
  return `<div class="card"><h3 class="h-ic"><span>${icon}</span>${title}</h3><div class="bars">${rows.map(r => {
    const v = r[key];
    return `<div class="col">
      <div class="val">${v ? fmt(v) : ''}</div>
      <div class="plot"><div class="bar" style="height:${v / max * 100}%;background:${color}"></div></div>
      <div class="lb">${r.label}</div>
    </div>`;
  }).join('')}</div></div>`;
}

/* ---------- 設定 ---------- */
function renderSet(){
  const me = S.members[S.user.uid] || {};
  const mem = Object.entries(S.members).map(([id, m]) => `
    <li><span class="av">${m.photo ? `<img src="${esc(m.photo)}" alt="" referrerpolicy="no-referrer">` : esc((m.name || '?').slice(0,1))}</span>
      <span>${esc(m.name || '名前なし')}${id === S.user.uid ? '<small>あなた</small>' : ''}</span></li>`).join('');
  $('v-set').innerHTML = `
    <div class="card"><h3>赤ちゃんの情報</h3>
      <div class="set-row"><label>名前（ニックネームでOK）</label><input id="s_name" value="${esc(S.baby.name)}"></div>
      <div class="set-row"><label>生年月日</label><input id="s_birth" type="date" value="${esc(S.baby.birth || '')}"></div>
      <div class="btns"><button class="primary" id="s_save">保存</button></div>
    </div>
    <div class="card"><h3>家族のメンバー</h3>
      <ul class="members">${mem}</ul>
      <div class="btns"><button class="primary" id="s_invite">家族を招待する</button></div>
    </div>
    <div class="card"><h3>あなたの呼び名</h3>
      <p class="note">記録に「だれが記録したか」として表示されます。</p>
      <div class="set-row"><input id="s_me" value="${esc(me.name || '')}" placeholder="ママ、パパ など"></div>
      <div class="btns"><button class="ghost" id="s_mesave">呼び名を保存</button></div>
    </div>
    <div class="card"><h3>データ</h3>
      <button class="linkbtn" id="s_export">バックアップを書き出す（JSON）</button>
      <button class="linkbtn" id="s_import">バックアップから読み込む</button>
    </div>
    <div class="card"><h3>アカウント</h3>
      <p class="note">${esc(S.user.email || '')} でログイン中</p>
      <button class="linkbtn" id="s_logout">ログアウト</button>
      <button class="linkbtn warn" id="s_leave">この家族から抜ける</button>
    </div>`;
  $('s_save').onclick = saveBaby;
  $('s_invite').onclick = invite;
  $('s_mesave').onclick = saveMyName;
  $('s_export').onclick = exportData;
  $('s_import').onclick = () => $('importFile').click();
  $('s_logout').onclick = () => signOut(auth);
  $('s_leave').onclick = leaveFamily;
}

function saveBaby(){
  const baby = {name: $('s_name').value.trim(), birth: $('s_birth').value};
  updateDoc(doc(fs, 'families', S.familyId), { baby }).catch(e => toast('保存に失敗しました'));
  toast('保存しました ✓');
}
function saveMyName(){
  const name = $('s_me').value.trim();
  if(!name){ toast('呼び名を入れてね'); return; }
  updateDoc(doc(fs, 'families', S.familyId, 'members', S.user.uid), { name }).catch(e => toast('保存に失敗しました'));
  toast('保存しました ✓');
}

async function invite(){
  const btn = $('s_invite');
  btn.disabled = true;
  try{
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const r = crypto.getRandomValues(new Uint8Array(8));
    const code = Array.from(r, x => A[x % A.length]).join('');
    await setDoc(doc(fs, 'invites', code), {
      familyId: S.familyId,
      createdBy: S.user.uid,
      expiresAt: Timestamp.fromMillis(Date.now() + 48 * HOUR),
      createdAt: serverTimestamp()
    });
    const url = location.origin + location.pathname + '?join=' + code;
    openSheet(`
      <h3>家族を招待</h3>
      <p class="note">このリンクかコードを家族に送ってください。相手はGoogleでログインして参加します。<b>48時間</b>有効です。</p>
      <div class="code-box">${code.slice(0,4)} ${code.slice(4)}</div>
      <div class="btns">
        <button class="ghost" id="i_copy">リンクをコピー</button>
        ${navigator.share ? '<button class="primary" id="i_share">送る</button>' : ''}
      </div>
      <div class="btns"><button class="ghost" id="i_close">閉じる</button></div>`);
    $('i_copy').onclick = async () => {
      try{ await navigator.clipboard.writeText(url); toast('コピーしました ✓'); }
      catch(e){ prompt('このリンクをコピーしてね', url); }
    };
    if($('i_share')) $('i_share').onclick = () => navigator.share({ title: '育児ログに招待', text: `育児ログの招待コード: ${code}`, url }).catch(() => {});
    $('i_close').onclick = closeSheet;
  }catch(e){
    console.error(e);
    toast('招待コードを作れませんでした（通信を確認してね）');
  }
  btn.disabled = false;
}

async function leaveFamily(){
  const others = Object.keys(S.members).filter(u => u !== S.user.uid).length;
  const msg = others
    ? 'この家族から抜けますか？記録は残りますが、あなたは見られなくなります。もう一度参加するには招待コードが必要です。'
    : 'あなたが最後のメンバーです。抜けると、この家族の記録には誰もアクセスできなくなります。先にバックアップを書き出してください。本当に抜けますか？';
  if(!confirm(msg)) return;
  try{
    const fid = S.familyId;
    stopListeners();
    await deleteDoc(doc(fs, 'families', fid, 'members', S.user.uid));
    await setDoc(doc(fs, 'users', S.user.uid), { familyId: null });
    S.familyId = null; S.events = []; S.members = {}; S.baby = {name:'', birth:''}; S.ready = false;
    renderOnboard();
    showScreen('onboard');
    toast('家族から抜けました');
  }catch(e){
    console.error(e);
    toast('うまくいきませんでした');
  }
}

/* ---------- バックアップ ---------- */
async function exportData(){
  try{
    const snap = await getDocs(eventsCol());
    const events = snap.docs.map(d => { const x = d.data(); delete x.updatedAt; return { ...x, id: d.id }; })
      .sort((a,b) => a.t - b.t);
    const blob = new Blob([JSON.stringify({ baby: S.baby, events }, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `babylog_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
  }catch(e){
    console.error(e);
    toast('書き出せませんでした');
  }
}

async function writeEvents(events){
  const valid = events.filter(e => e && TYPES[e.type] && typeof e.t === 'number');
  for(let i = 0; i < valid.length; i += 400){
    const b = writeBatch(fs);
    valid.slice(i, i + 400).forEach(e => {
      const data = {};
      for(const [k, v] of Object.entries(e)) if(v !== undefined && k !== 'id' && k !== 'updatedAt') data[k] = v;
      data.by = data.by || S.user.uid;
      data.updatedAt = serverTimestamp();
      b.set(doc(eventsCol(), String(e.id || uid())), data);
    });
    await b.commit();
  }
  return valid.length;
}

$('importFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if(!f) return;
  try{
    const d = JSON.parse(await f.text());
    if(!Array.isArray(d.events)) throw new Error('invalid');
    if(!confirm(`${d.events.length}件の記録を家族のノートに追加します。同じ記録は上書きされます。よろしいですか？`)) return;
    toast('読み込み中…');
    const n = await writeEvents(d.events);
    if(d.baby && !S.baby.name && !S.baby.birth) await updateDoc(doc(fs, 'families', S.familyId), { baby: d.baby });
    toast(`${n}件 読み込みました ✓`);
  }catch(err){
    console.error(err);
    toast('ファイルの形式が正しくありません');
  }
});

// 以前の「この端末だけ版」のデータが残っていれば取り込みを提案
async function offerLegacyImport(){
  let old;
  try{ old = JSON.parse(localStorage.getItem(LEGACY_KEY)); }catch(e){ return; }
  if(!old || !Array.isArray(old.events) || !old.events.length) return;
  if(!confirm(`この端末に、以前の記録が${old.events.length}件残っています。家族のノートに取り込みますか？`)) return;
  try{
    const n = await writeEvents(old.events);
    if(old.baby && !S.baby.name && !S.baby.birth) await updateDoc(doc(fs, 'families', S.familyId), { baby: old.baby });
    localStorage.removeItem(LEGACY_KEY);
    toast(`${n}件 取り込みました ✓`);
  }catch(e){
    console.error(e);
    toast('取り込みに失敗しました。あとでもう一度開いてね');
  }
}

/* ---------- 共通 ---------- */
let toastTimer;
function toast(msg){
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

setInterval(() => { if(S.ready && view === 'today' && !$('ov').classList.contains('show')) renderToday(); }, 30000);

if('serviceWorker' in navigator && location.protocol === 'https:'){
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
