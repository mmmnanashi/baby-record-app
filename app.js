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

/* ---------- 夜間モード ---------- */
const THEME_KEY = 'babylog_theme';   // auto / on / off（端末ごとの設定）
function themePref(){ try{ return localStorage.getItem(THEME_KEY) || 'auto'; }catch(e){ return 'auto'; } }
function isNightHour(){ const h = new Date().getHours(); return h >= 19 || h < 6; }
function applyTheme(){
  const p = themePref();
  const night = p === 'on' || (p === 'auto' && isNightHour());
  const want = night ? 'night' : 'day';
  if(document.documentElement.dataset.theme !== want) document.documentElement.dataset.theme = want;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', night ? '#1d1930' : '#ffeef4');
}
applyTheme();

/* ---------- 振動・取り消しボタン付きの通知 ---------- */
const buzz = (ms = 25) => { try{ navigator.vibrate?.(ms); }catch(e){} };
const atoast = document.createElement('div');
atoast.className = 'atoast';
document.body.appendChild(atoast);
let atoastTimer;
function hideAtoast(){ atoast.classList.remove('show'); }
function actionToast(msg, actions){
  document.getElementById('toast')?.classList.remove('show');
  atoast.innerHTML = '<div class="at-msg"></div><div class="at-btns"></div>';
  atoast.querySelector('.at-msg').textContent = msg;
  const box = atoast.querySelector('.at-btns');
  actions.forEach((a, i) => {
    const b = document.createElement('button');
    b.textContent = a.label;
    if(i === 0) b.className = 'at-undo';
    b.onclick = () => { hideAtoast(); a.fn(); };
    box.appendChild(b);
  });
  atoast.classList.add('show');
  clearTimeout(atoastTimer);
  atoastTimer = setTimeout(hideAtoast, 6000);
}
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
// 便色カード（母子健康手帳）に合わせた7段階。画面の色はあくまで目安
const STOOL = [
  [1, '#f3f1e1', '白っぽい'], [2, '#efe7b4', 'うすいクリーム色'], [3, '#e8d98a', 'うすい黄色'],
  [4, '#dcb945', '黄色'], [5, '#c99a2e', '山吹色'], [6, '#97853a', '黄土色〜うすい緑'], [7, '#56602f', '緑']
];
const stoolOf = n => STOOL[Number(n) - 1] || null;
const isPoop = e => e.type === 'diaper' && (e.sub === 'うんち' || e.sub === '両方');
const isMilk = e => e.type === 'feed' && e.sub === 'ミルク';
const isBreast = e => e.type === 'feed' && e.sub !== 'ミルク';
// 母乳とミルクを30分以内に続けてあげたときは「1回の授乳」としてまとめる
function feedSessions(list){
  const out = [];
  list.filter(e => e.type === 'feed').forEach(e => {
    if(out.length && e.t - out[out.length - 1].last <= 30 * MIN) out[out.length - 1].last = e.t;
    else out.push({ t: e.t, last: e.t });
  });
  return out;
}
function avgGapOf(times){
  const g = [];
  for(let i = 1; i < times.length; i++){ const x = times[i] - times[i-1]; if(x < 8 * HOUR) g.push(x); }
  return g.length ? { avg: g.reduce((a, b) => a + b, 0) / g.length, n: g.length } : null;
}
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
  milton: null,     // ミルトン（消毒液）を最後に交換した時刻 {t, by}
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
  S.familyId = null; S.events = []; S.members = {}; S.baby = {name:'', birth:''}; S.milton = null; S.ready = false;
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


/* ---------- エラー表示 ---------- */
// サーバーから応答がないとき、いつまでも待たないようにする
function withTimeout(promise, ms = 15000){
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej({ code: 'timeout' }), ms))]);
}
function showError(title, e){
  const code = e?.code || 'unknown';
  const hints = {
    'permission-denied': 'Firestoreのルールで拒否されました。Firebaseコンソールの「Firestore Database」→「ルール」に firestore.rules の内容が貼られて「公開」されているか確認してください。',
    'timeout': 'サーバーから応答がありません。Firestoreのデータベースがまだ作成されていない（または「ネイティブモード」以外で作られている）可能性があります。通信状態も確認してください。',
    'unavailable': 'サーバーにつながりません。通信状態か、Firestoreのデータベースが作成されているか確認してください。',
    'not-found': 'Firestoreのデータベースが見つかりません。「Firestore Database」で（default）データベースを作成してください。',
    'failed-precondition': 'Firestoreの準備ができていません。データベースが「ネイティブモード」で作成されているか確認してください。'
  };
  openSheet(`
    <h3>${esc(title)}</h3>
    <p class="note">${esc(hints[code] || '予期しないエラーが起きました。下の内容を教えてもらえれば原因を調べられます。')}</p>
    <div class="err-box">エラーコード: ${esc(code)}${e?.message ? '<br>' + esc(e.message) : ''}</div>
    <div class="btns"><button class="ghost" id="err_close">閉じる</button></div>`);
  $('err_close').onclick = closeSheet;
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
    await withTimeout(b.commit());
    toast('家族のノートを作りました ✓');
    startFamily(famRef.id);
  }catch(e){
    console.error(e);
    showError('家族のノートを作れませんでした', e);
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
      inv = await withTimeout(getDoc(doc(fs, 'invites', code)));
    }catch(e){
      if(e.code !== 'permission-denied'){ showError('招待コードを確認できませんでした', e); btn.disabled = false; return; }
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
    await withTimeout(b.commit());
    history.replaceState(null, '', location.pathname);
    toast('家族に参加しました ✓');
    startFamily(fid);
  }catch(e){
    console.error(e);
    showError('家族に参加できませんでした', e);
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
    S.milton = snap.data()?.milton || null;
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
    case 'diaper': {
      const c = stoolOf(e.color);
      return esc(e.sub || 'おむつ')
        + (c ? ` <span class="sw" style="background:${c[1]}"></span>便色${c[0]}` : '')
        + (e.stool ? `・${esc(e.stool)}` : '');
    }
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
  const milks = S.events.filter(isMilk), breasts = S.events.filter(isBreast);
  const lastMilk = milks[milks.length - 1], lastBreast = breasts[breasts.length - 1];
  const todayMilk = feeds.filter(isMilk).length, todayBreast = feeds.length - todayMilk;
  const ongoing = S.events.find(e => e.type === 'sleep' && !e.end);

  $('v-today').innerHTML = `
    ${ongoing ? `<div class="banner"><div class="bn-ic">${ICON.sleep}<span>すやすや睡眠中</span></div><small>${hm(ongoing.t)} から ・ 経過 ${durTxt(Date.now() - ongoing.t)}</small></div>` : ''}
    <div class="act-grid">
      <button class="act" style="background:var(--g-breast)" data-act="breast"><b>${ICON.breast}</b><span class="al">母乳<small>${lastBreast?.amount ? lastBreast.amount + '分' : 'すぐ記録'}</small></span></button>
      <button class="act" style="background:var(--g-feed)" data-act="milk"><b>${ICON.feed}</b><span class="al">ミルク<small>${lastMilk?.amount ? lastMilk.amount + 'ml' : 'すぐ記録'}</small></span></button>
      <button class="act" style="background:var(--g-sleep)" data-act="sleep"><b>${ongoing ? ICON.wake : ICON.sleep}</b><span class="al">${ongoing ? '起きた' : '寝た'}<small>すぐ記録</small></span></button>
      <button class="act" style="background:var(--g-diaper)" data-act="diaper"><b>${ICON.diaper}</b><span class="al">おむつ<small>おしっこ</small></span></button>
      <button class="act" style="background:var(--g-temp)" data-act="temp"><b>${ICON.temp}</b><span class="al">体温<small>入力</small></span></button>
      <button class="act" style="background:var(--g-memo)" data-act="memo"><b>${ICON.memo}</b><span class="al">メモ<small>入力</small></span></button>
    </div>
    <p class="act-hint">タップですぐ記録 ・ 母乳・ミルク・おむつは<b>長押し</b>で詳しく入力</p>
    ${miltonHTML()}
    <div class="stats">
      <div class="stat"><div class="k">今日の授乳</div><div class="v">${feedSessions(list).length}<small>回</small></div><div class="d">ミルク${todayMilk}回 ${milk}ml ・ 母乳${todayBreast}回</div></div>
      <div class="stat"><div class="k">今日の睡眠</div><div class="v">${durTxt(sleepMs)}</div><div class="d">${sleeps.length}回</div></div>
      <div class="stat"><div class="k">今日のおむつ</div><div class="v">${diapers.length}<small>回</small></div><div class="d">おしっこ ${pee} ・ うんち ${poop}</div>${lastPoopHTML()}</div>
      <div class="stat"><div class="k">前回から</div>
        ${sinceRow('ミルク', lastMilk, 'milk', 'ml')}
        ${sinceRow('母乳', lastBreast, 'breast', '分')}
      </div>
    </div>
    <div class="card"><h3>今日のタイムライン</h3>${timelineHTML(list)}</div>
  `;
  $('v-today').querySelectorAll('[data-act]').forEach(bindActButton);
  if($('mt_done')) $('mt_done').onclick = miltonDone;
  if($('mt_edit')) $('mt_edit').onclick = miltonEdit;
  $('v-today').querySelectorAll('[data-ev]').forEach(li => li.onclick = () => openForm(null, li.dataset.ev));
}
/* ---------- ミルトン（哺乳びんの消毒液） ---------- */
// 薬液は1日1回の交換で24時間有効とされているので、24時間を目安に表示
const MILTON_LIMIT = 24 * HOUR;
function miltonHTML(){
  const m = S.milton;
  const t = m && typeof m.t === 'number' ? m.t : null;
  const ms = t ? Date.now() - t : 0;
  const over = t && ms >= MILTON_LIMIT;
  const soon = t && !over && ms >= MILTON_LIMIT - 3 * HOUR;
  const d = t ? new Date(t) : null;
  const when = t ? (startOfDay(t) === startOfDay(Date.now()) ? '' : `${d.getMonth() + 1}/${d.getDate()} `) + hm(t) : '';
  const who = t && whoName(m.by) ? ` ・ ${esc(whoName(m.by))}` : '';
  const pct = t ? Math.min(100, ms / MILTON_LIMIT * 100) : 0;
  return `<div class="milton ${over ? 'over' : soon ? 'soon' : ''}">
    <span class="mt-ic">${ICON.milton}</span>
    <div class="mt-body">
      <div class="mt-k">ミルトン交換から</div>
      ${t ? `<div class="mt-v">${durTxt(ms)}</div>
        <div class="mt-bar"><i style="width:${pct}%"></i></div>
        <button class="mt-sub" id="mt_edit">${when}に交換${who}${over ? ' ・ <b>交換の目安（24時間）を過ぎています</b>' : soon ? ' ・ そろそろ交換' : ''}</button>`
        : `<div class="mt-v none">まだ記録がありません</div><div class="mt-sub">交換したら右のボタンを押してね</div>`}
    </div>
    <button class="mt-btn" id="mt_done">交換した</button>
  </div>`;
}
function saveMilton(val){
  updateDoc(doc(fs, 'families', S.familyId), { milton: val }).catch(e => { console.error(e); toast('保存に失敗しました'); });
}
function miltonDone(){
  const prev = S.milton || null;
  saveMilton({ t: Date.now(), by: S.user.uid });
  buzz();
  actionToast('ミルトンの交換を記録しました', [
    { label: '取り消す', fn: () => { saveMilton(prev); toast('取り消しました'); } },
    { label: '時刻を直す', fn: miltonEdit }
  ]);
}
function miltonEdit(){
  const t = S.milton?.t || Date.now();
  openSheet(`
    <h3 class="fh"><span class="fh-ic" style="background:var(--g-milton)">${ICON.milton}</span>ミルトンの交換時刻</h3>
    <p class="note">薬液は24時間を目安に交換します。</p>
    <label>交換した時刻<input id="mt_t" type="datetime-local" value="${toInput(t)}"></label>
    <div class="btns"><button class="ghost" id="mt_cancel">やめる</button><button class="primary" id="mt_save">保存</button></div>`);
  $('mt_cancel').onclick = closeSheet;
  $('mt_save').onclick = () => {
    const v = $('mt_t').value;
    if(!v){ toast('時刻を入れてね'); return; }
    const nt = new Date(v).getTime();
    if(nt > Date.now() + 5 * MIN){ toast('未来の時刻は入れられません'); return; }
    saveMilton({ t: nt, by: S.milton?.by || S.user.uid });
    closeSheet();
    toast('保存しました ✓');
  };
}

// 最後のうんち（今日でなければ日付も）
function lastPoopHTML(){
  const ps = S.events.filter(isPoop);
  const e = ps[ps.length - 1];
  if(!e) return '<div class="lastpoop">最後のうんち <b>—</b></div>';
  const d = new Date(e.t), ms = Date.now() - e.t;
  const when = (startOfDay(e.t) === startOfDay(Date.now()) ? '' : `${d.getMonth() + 1}/${d.getDate()} `) + hm(e.t);
  const ago = ms < HOUR ? `${Math.max(0, Math.round(ms / MIN))}分前` : ms < DAY ? `${durTxt(ms)}前` : `${Math.floor(ms / DAY)}日前`;
  const c = stoolOf(e.color);
  return `<div class="lastpoop">最後のうんち<br><b>${when}</b>${c ? ` <span class="sw" style="background:${c[1]}"></span>` : ''}<small>（${ago}）</small></div>`;
}
function sinceRow(label, e, cls, unit){
  return `<div class="since"><span class="tag tag-${cls}">${label}</span>`
    + (e ? `<b>${durTxt(Date.now() - e.t)}</b><small>${hm(e.t)}${e.amount ? ' ・ ' + esc(e.amount) + unit : ''}</small>` : '<b class="none">—</b>')
    + '</div>';
}
function timelineHTML(list){
  if(!list.length) return '<div class="empty">まだ記録がありません。上のボタンから記録してね</div>';
  return '<ul class="tl">' + [...list].reverse().map(e => {
    const who = whoName(e.by);
    const sub = e.memo ? esc(e.memo) : TYPES[e.type].label;
    return `
    <li data-ev="${esc(e.id)}">
      <span class="time">${hm(e.t)}</span>
      <span class="dot" style="background:${isBreast(e) ? 'var(--g-breast)' : TYPES[e.type].color}">${isBreast(e) ? ICON.breast : TYPES[e.type].icon}</span>
      <span class="txt">${describe(e)}<small>${sub}${who ? ` ・ <span class="who">${esc(who)}</span>` : ''}</small></span>
    </li>`;
  }).join('') + '</ul>';
}
// ボタン：タップで即記録、授乳とおむつは長押しで入力画面
function bindActButton(b){
  const t = b.dataset.act;
  const quick = t === 'breast' || t === 'milk' || t === 'diaper';
  const longOpen = () => t === 'diaper' ? openForm('diaper') : openForm('feed', null, { sub: t === 'milk' ? 'ミルク' : '母乳' });
  let timer = null, long = false;
  if(quick){
    const cancel = () => { clearTimeout(timer); timer = null; b.classList.remove('pressing'); };
    b.addEventListener('pointerdown', () => {
      long = false;
      b.classList.add('pressing');
      timer = setTimeout(() => { long = true; cancel(); buzz(40); longOpen(); }, 550);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, cancel));
    b.addEventListener('contextmenu', e => e.preventDefault());
  }
  b.onclick = () => {
    if(long){ long = false; return; }
    if(t === 'sleep') quickSleep();
    else if(t === 'milk') quickFeed('ミルク');
    else if(t === 'breast') quickFeed('母乳');
    else if(t === 'diaper') quickDiaper();
    else openForm(t);
  };
}
function editLater(id){
  if(S.events.find(x => x.id === id)) openForm(null, id);
  else toast('少し待ってから、タイムラインで編集してね');
}
const undo = id => () => { removeEvent(id); toast('取り消しました'); };

function quickFeed(sub){
  const same = S.events.filter(sub === 'ミルク' ? isMilk : isBreast);
  const last = same[same.length - 1];
  const ev = { id: uid(), type: 'feed', t: Date.now(), sub };
  if(last?.amount) ev.amount = last.amount;
  putEvent(ev);
  buzz();
  actionToast(`${describe(ev)}を記録しました`, [
    { label: '取り消す', fn: undo(ev.id) },
    { label: '編集する', fn: () => editLater(ev.id) }
  ]);
}
function quickDiaper(){
  const ev = { id: uid(), type: 'diaper', t: Date.now(), sub: 'おしっこ' };
  putEvent(ev);
  buzz();
  const change = sub => {
    putEvent({ ...ev, sub });
    const age = babyAge();
    if(!age || age.days <= 135){
      actionToast(`「${sub}」に変更しました。うんちの色も記録できます`, [
        { label: '色を選ぶ', fn: () => editLater(ev.id) },
        { label: '今はしない', fn: () => {} }
      ]);
    } else toast(`「${sub}」に変更しました ✓`);
  };
  actionToast('おむつ（おしっこ）を記録しました', [
    { label: '取り消す', fn: undo(ev.id) },
    { label: 'うんちに変更', fn: () => change('うんち') },
    { label: '両方', fn: () => change('両方') }
  ]);
}
function quickSleep(){
  const on = S.events.find(e => e.type === 'sleep' && !e.end);
  buzz();
  if(on){
    const end = Date.now();
    putEvent({ ...on, end });
    actionToast('おはよう ☀️ 睡眠 ' + durTxt(end - on.t), [
      { label: '取り消す', fn: () => { putEvent({ ...on, end: null }); toast('取り消しました'); } }
    ]);
  } else {
    const ev = { id: uid(), type: 'sleep', t: Date.now(), end: null };
    putEvent(ev);
    actionToast('おやすみ 🌙 睡眠を記録中', [{ label: '取り消す', fn: undo(ev.id) }]);
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
  if(F.type === 'diaper' && group.dataset.k === 'sub' && $('poopBox')) $('poopBox').hidden = F.sub === 'おしっこ';
});

function openForm(type, id, preset = {}){
  const ev = id ? S.events.find(x => x.id === id) : null;
  if(ev) type = ev.type;
  const e = ev || {};
  F = {type, id: e.id || null, by: e.by || null, sub: e.sub || preset.sub || ({feed:'母乳', diaper:'おしっこ'}[type] || null),
       color: stoolOf(e.color) ? Number(e.color) : null, stool: e.stool || null};

  let h = `<h3 class="fh"><span class="fh-ic" style="background:${TYPES[type].color}">${TYPES[type].icon}</span>${TYPES[type].label}を${ev ? '編集' : '記録'}</h3>`;
  if(ev && whoName(ev.by)) h += `<p class="note">記録した人：${esc(whoName(ev.by))}</p>`;
  if(type === 'feed')   h += seg('sub', ['母乳','ミルク'], F.sub);
  if(type === 'diaper'){
    h += seg('sub', ['おしっこ','うんち','両方'], F.sub);
    h += `<div id="poopBox" ${F.sub === 'おしっこ' ? 'hidden' : ''}>
      <div class="lbl">うんちの色（便色カード）</div>
      <div class="stool-colors">${STOOL.map(([n, c, l]) =>
        `<button type="button" data-color="${n}" style="background:${c}" aria-label="${n}番 ${l}"><span>${n}</span></button>`).join('')}</div>
      <div class="stool-scale"><span>← うすい（1〜3は受診の目安）</span><span>こい →</span></div>
      <p class="stool-name" id="stoolName"></p>
      <div class="stool-warn" id="stoolWarn" hidden>白っぽい・うすい黄色のうんち（1〜3番）は、胆道閉鎖症など肝臓の病気のサインのことがあります。<b>すぐに小児科を受診</b>してください。</div>
      <p class="note small">画面の色は実物と違って見えることがあります。明るい場所で、母子手帳の便色カードと見比べてください。迷ったら小さい番号を選びます。</p>
      <div class="lbl">うんちの状態（任意）</div>
      ${seg('stool', ['かため','ふつう','やわらかい','水っぽい'], F.stool)}
    </div>`;
  }
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
  $('sheet').querySelectorAll('[data-color]').forEach(b => b.onclick = () => {
    const n = Number(b.dataset.color);
    F.color = F.color === n ? null : n;
    updateStoolUI();
  });
  if(type === 'diaper') updateStoolUI();
  $('f_cancel').onclick = closeSheet;
  if($('f_del')) $('f_del').onclick = delEv;
}
function updateStoolUI(){
  if(!$('stoolName')) return;
  $('sheet').querySelectorAll('[data-color]').forEach(b => b.classList.toggle('on', Number(b.dataset.color) === F.color));
  const c = stoolOf(F.color);
  $('stoolName').textContent = c ? `${c[0]}番：${c[2]}（タップで選択を解除）` : '近い色をタップ（任意）';
  $('stoolWarn').hidden = !(c && c[0] <= 3);
}
function showStoolAlert(n){
  openSheet(`
    <h3 class="fh"><span class="fh-ic alert-ic">!</span>うんちの色が便色カード${n}番に近いです</h3>
    <p class="sa-text">白っぽい・うすい黄色のうんち（1〜3番）は、胆道閉鎖症など肝臓や胆道の病気のサインのことがあります。早く見つけて治療を始めることがとても大切です。</p>
    <ul class="alert-list">
      <li><b>すぐに小児科を受診</b>してください。夜間・休日で迷ったら #8000 へ。</li>
      <li>受診のときは便色カードの番号を伝え、うんちのついたおむつを持っていくと確認してもらいやすいです。</li>
      <li>白目や肌が黄色い、おしっこが濃い黄色、なども一緒に伝えてください。</li>
    </ul>
    <p class="note">照明の色で見え方が変わることがあります。明るい場所で母子手帳の便色カードと見比べてください。</p>
    <div class="btns"><a class="primary btnlink" href="tel:%238000">#8000に電話</a><button class="ghost" id="sa_close">閉じる</button></div>`);
  $('sa_close').onclick = closeSheet;
}
function openSheet(html){ hideAtoast(); $('sheet').innerHTML = html; $('ov').classList.add('show'); }
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
  if(F.type === 'diaper'){
    ev.sub = F.sub;
    if(F.sub !== 'おしっこ'){
      if(stoolOf(F.color)) ev.color = F.color;
      if(F.stool) ev.stool = F.stool;
    }
  }
  if(F.type === 'temp'){
    const v = $('f_amt').value;
    if(!v){ toast('体温を入れてね'); return; }
    ev.value = +v;
  }
  if(F.type === 'memo' && !note){ toast('内容を入れてね'); return; }
  if(note) ev.memo = note;

  putEvent(ev);
  closeSheet();
  if(ev.type === 'diaper' && ev.color && ev.color <= 3) showStoolAlert(ev.color);
  else toast('保存しました ✓');
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
      feeds: feedSessions(L).length,
      ml: feeds.filter(e => e.sub === 'ミルク').reduce((a,e) => a + (e.amount || 0), 0),
      sleep: L.filter(e => e.type === 'sleep').reduce((a,e) => a + sleepDur(e), 0) / HOUR,
      diaper: L.filter(e => e.type === 'diaper').length,
      poop: L.filter(isPoop).length
    };
  });

  const start = rows[0].s;
  const n = rows.length;
  const sumOf = k => rows.reduce((a,r) => a + r[k], 0);
  const inRange = S.events.filter(e => e.t >= start);
  const gMilk = avgGapOf(inRange.filter(isMilk).map(e => e.t));
  const gBreast = avgGapOf(inRange.filter(isBreast).map(e => e.t));
  const nMilk = inRange.filter(isMilk).length, nBreast = inRange.filter(isBreast).length;
  const gapCard = (gMilk || !gBreast)
    ? `<div class="stat"><div class="k">ミルクの平均間隔</div><div class="v">${gMilk ? durTxt(gMilk.avg) : '—'}</div><div class="d">${gBreast ? '母乳 ' + durTxt(gBreast.avg) : (gMilk ? gMilk.n + 1 + '回のミルクから' : '記録が2回以上で表示')}</div></div>`
    : `<div class="stat"><div class="k">母乳の平均間隔</div><div class="v">${durTxt(gBreast.avg)}</div><div class="d">${gBreast.n + 1}回の母乳から</div></div>`;
  const sleeps = S.events.filter(e => e.type === 'sleep' && e.t >= start);
  const longest = sleeps.length ? Math.max(...sleeps.map(sleepDur)) : 0;

  const railHTML = r => {
    const s = r.s;
    const segs = S.events.filter(e => e.type === 'sleep' && (e.end ?? Date.now()) > s && e.t < s + DAY).map(e => {
      const a = Math.max(e.t, s), b = Math.min(e.end ?? Date.now(), s + DAY);
      return `<div class="s" style="left:${(a-s)/DAY*100}%;width:${(b-a)/DAY*100}%"></div>`;
    }).join('');
    const fd = r.L.filter(e => e.type === 'feed').map(e => `<div class="f${isBreast(e) ? ' fb' : ''}" style="left:${(e.t-s)/DAY*100}%"></div>`).join('');
    return `<div class="rail-row"><span class="d">${r.label}</span><div class="rail">${segs}${fd}</div></div>`;
  };

  $('v-stats').innerHTML = `
    ${adviceHTML()}
    <div class="range">${[7,14,30].map(n => `<button class="${n === rangeDays ? 'on' : ''}" data-range="${n}">${n}日間</button>`).join('')}</div>
    <div class="stats">
      <div class="stat"><div class="k">1日あたりの授乳</div><div class="v">${(sumOf('feeds')/n).toFixed(1)}<small>回</small></div><div class="d">母乳とミルクを続けたら1回</div></div>
      ${gapCard}
      <div class="stat"><div class="k">1日あたりの睡眠</div><div class="v">${durTxt(sumOf('sleep')/n*HOUR)}</div><div class="d">期間の平均</div></div>
      <div class="stat"><div class="k">最長の睡眠</div><div class="v">${longest ? durTxt(longest) : '—'}</div><div class="d">期間中の1回あたり</div></div>
    </div>
    ${barsHTML(ICON.feed, '授乳回数（回/日）', rows, 'feeds', 'var(--feed)', v => v)}
    ${barsHTML(ICON.feed, 'ミルク量（ml/日）', rows, 'ml', 'var(--feed)', v => v)}
    ${barsHTML(ICON.sleep, '睡眠時間（時間/日）', rows, 'sleep', 'var(--sleep)', v => r1(v))}
    ${barsHTML(ICON.diaper, 'おむつ回数（回/日）', rows, 'diaper', 'var(--diaper)', v => v)}
    ${barsHTML(ICON.diaper, 'うんち回数（回/日）', rows, 'poop', 'var(--poop)', v => v)}
    ${stoolColorHTML(start)}
    <div class="card">
      <h3>1日の流れ</h3>
      <div class="rail-row"><span class="d"></span><div class="axis"><span>0時</span><span>6時</span><span>12時</span><span>18時</span><span>24時</span></div></div>
      ${[...rows].reverse().map(railHTML).join('')}
      <div class="legend"><span><i style="background:var(--sleep)"></i>睡眠</span><span><i style="background:var(--feed)"></i>ミルク</span><span><i style="background:var(--breast)"></i>母乳</span></div>
    </div>
  `;
  $('v-stats').querySelectorAll('[data-range]').forEach(b => b.onclick = () => { rangeDays = +b.dataset.range; render(); });
}
// うんちの色と状態の内訳（選んだ期間）
function stoolColorHTML(start){
  const poops = S.events.filter(e => isPoop(e) && e.t >= start);
  const withC = poops.filter(e => stoolOf(e.color));
  let body;
  if(!poops.length){
    body = '<p class="note">この期間のうんちの記録はありません。</p>';
  } else if(!withC.length){
    body = '<p class="note">色の記録はまだありません。おむつの記録で「うんち」を選ぶと、色を選べます。</p>';
  } else {
    const cnt = STOOL.map(([n]) => withC.filter(e => Number(e.color) === n).length);
    const max = Math.max(...cnt);
    const top = STOOL[cnt.indexOf(max)];
    const pale = cnt[0] + cnt[1] + cnt[2];
    const rowsH = STOOL.map(([n, c, l], i) => `
      <div class="crow${n <= 3 ? ' pale' : ''}">
        <span class="cn" style="background:${c}">${n}</span>
        <span class="cl">${l}</span>
        <div class="cbar"><i style="width:${cnt[i] / max * 100}%;background:${c}"></i></div>
        <span class="cc">${cnt[i] ? cnt[i] + '回' : '—'}</span>
      </div>`).join('');
    const states = ['かため', 'ふつう', 'やわらかい', '水っぽい'].map(k => [k, poops.filter(e => e.stool === k).length]).filter(x => x[1]);
    body = `
      <p class="ctop">いちばん多いのは <span class="cn sm" style="background:${top[1]}">${top[0]}</span> <b>${top[2]}</b>（${max}回）</p>
      ${pale ? `<div class="stool-warn">1〜3番（白っぽい・うすい黄色）の記録が${pale}回あります。まだ受診していなければ、すぐに小児科を受診してください。</div>` : ''}
      <div class="crows">${rowsH}</div>
      <p class="note small">色を記録したうんち ${withC.length}回${poops.length > withC.length ? ` ・ 色の記録なし ${poops.length - withC.length}回` : ''}</p>
      ${states.length ? `<div class="lbl">うんちの状態</div><div class="chips">${states.map(([k, v]) => `<span class="chip${k === '水っぽい' ? ' chip-w' : ''}">${k} <b>${v}</b></span>`).join('')}</div>` : ''}`;
  }
  return `<div class="card"><h3 class="h-ic"><span>${ICON.diaper}</span>うんちの色（${rangeDays}日間）</h3>${body}</div>`;
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

/* ---------- アドバイス ---------- */
// 一般的な目安と記録を比べて、状態とアドバイスを出す（診断ではない）
//  授乳回数（新生児〜2か月）1日8〜12回 / おしっこ 生後1週ごろから1日6回以上
//  発熱 38℃以上（生後3か月未満は早めの受診）
//  睡眠 National Sleep Foundation: 0〜3か月14〜17時間, 4〜11か月12〜15時間, 1〜2歳11〜14時間, 3〜5歳10〜13時間
function babyAge(){
  if(!S.baby.birth) return null;
  const b = new Date(S.baby.birth + 'T00:00');
  const days = Math.floor((startOfDay(Date.now()) - b.getTime()) / DAY);
  if(isNaN(days) || days < 0) return null;
  const now = new Date();
  let months = (now.getFullYear() - b.getFullYear()) * 12 + now.getMonth() - b.getMonth();
  if(now.getDate() < b.getDate()) months--;
  return { days, months: Math.max(0, months) };
}
const f1 = x => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
function dayStats(s){
  const L = S.events.filter(e => e.t >= s && e.t < s + DAY);
  const d = L.filter(e => e.type === 'diaper');
  const sl = L.filter(e => e.type === 'sleep');
  return {
    any: L.length > 0,
    feeds: feedSessions(L).length,
    diapers: d.length,
    wet: d.filter(e => e.sub === 'おしっこ' || e.sub === '両方').length,
    sleepN: sl.length,
    sleepH: sl.reduce((a, e) => a + sleepDur(e), 0) / HOUR
  };
}
// ミルクの記録が十分あればミルクの間隔、なければ「1回の授乳」どうしの間隔
function avgFeedGap(from, to, kind){
  const L = S.events.filter(e => e.t >= from && e.t < to);
  const times = kind === 'milk' ? L.filter(isMilk).map(e => e.t) : feedSessions(L).map(x => x.t);
  const g = avgGapOf(times);
  return g && g.n >= 5 ? g.avg : null;
}
function longestSleep(from, to){
  const L = S.events.filter(e => e.type === 'sleep' && e.end && e.t >= from && e.t < to);
  return L.length ? Math.max(...L.map(e => e.end - e.t)) : null;
}
function sleepRange(age){
  if(!age) return null;
  if(age.months < 4) return [14, 17, '0〜3か月'];
  if(age.months < 12) return [12, 15, '4〜11か月'];
  if(age.months < 24) return [11, 14, '1〜2歳'];
  return [10, 13, '3〜5歳'];
}
const avgOf = (arr, k) => arr.reduce((a, x) => a + x[k], 0) / arr.length;

function buildAdvice(){
  const A = [];
  const add = (level, title, text) => A.push({ level, title, text });
  const age = babyAge();
  const now = Date.now();
  const today = startOfDay(now);

  // 体温（直近24時間の最新）
  const temps = S.events.filter(e => e.type === 'temp' && e.t >= now - DAY && typeof e.value === 'number');
  const lt = temps[temps.length - 1];
  if(lt){
    const v = lt.value;
    if(v >= 38 && age && age.days < 90){
      add('alert', `生後3か月未満で${v}℃の熱があります（${hm(lt.t)}）`,
        'この月齢の38℃以上の発熱は、元気そうに見えても早めの受診がすすめられています。夜間・休日でも、かかりつけ医や救急外来に連絡してください。');
    } else if(v >= 38){
      add('warn', `${v}℃の熱があります（${hm(lt.t)}）`,
        '母乳・ミルクが飲めているか、おしっこが出ているか、機嫌はどうかを見てください。ぐったりしている、飲めない、呼吸が苦しそう、けいれんがあるときはすぐ受診を。'
        + (age ? '' : '生後3か月未満なら、元気そうでも早めに受診してください。'));
    } else if(v >= 37.5){
      add('info', `体温が少し高めです（${v}℃・${hm(lt.t)}）`,
        '赤ちゃんはもともと体温が高めで、着せすぎや室温、授乳や泣いた直後でも上がります。服や室温を調整して、30分ほどしてから測り直してみてください。');
    }
  }

  // うんちの色（便色カード1〜3番・直近7日）
  const pale = S.events.filter(e => e.type === 'diaper' && stoolOf(e.color) && Number(e.color) <= 3 && e.t >= now - 7 * DAY);
  if(pale.length){
    const p = pale[pale.length - 1];
    const d = new Date(p.t);
    add('alert', `うんちの色が便色カード${p.color}番に近い記録があります（${d.getMonth() + 1}/${d.getDate()} ${hm(p.t)}）`,
      '白っぽい・うすい黄色のうんちは、胆道閉鎖症など肝臓の病気のサインのことがあります。まだ受診していなければ、すぐに小児科を受診してください。番号を伝え、うんちのついたおむつを持っていくと確認してもらいやすいです。');
  }

  // 水っぽいうんち（24時間で3回以上）
  const watery = S.events.filter(e => e.type === 'diaper' && e.stool === '水っぽい' && e.t >= now - DAY).length;
  if(watery >= 3) add('warn', `水っぽいうんちが続いています（24時間で${watery}回）`,
    '母乳・ミルクが飲めているか、おしっこが出ているかを見てください。おしっこが減る、ぐったりしている、吐く、うんちに血が混じる、熱があるなどのときは早めに小児科へ。');

  // 生後4か月ごろまでは便色チェックのすすめ
  if(age && age.days <= 135){
    const recentPoops = S.events.filter(e => e.type === 'diaper' && (e.sub === 'うんち' || e.sub === '両方') && e.t >= now - 14 * DAY);
    if(recentPoops.length && !recentPoops.some(e => stoolOf(e.color))) add('info', 'うんちの色もチェックしてみましょう',
      '生後4か月ごろまでは、うんちの色を母子手帳の便色カードと見比べておくと安心です（特に生後2週・1か月・1〜4か月ごろ）。おむつの記録で「うんち」を選ぶと、色を選べます。');
  }

  // 直近3日間（今日を除く、記録がある日だけ）
  const ds = [1, 2, 3].map(i => { const d = new Date(today); d.setDate(d.getDate() - i); return d.getTime(); })
    .map(dayStats).filter(x => x.any);

  if(!ds.length){
    add('info', '記録がたまると、アドバイスが表示されます',
      '丸1日分の記録がたまると、授乳・おしっこ・睡眠のようすを目安と比べてお知らせします。');
  }

  // 授乳回数（生後2か月ごろまで）
  const dsF = ds.filter(x => x.feeds > 0);
  const mixNote = S.events.some(isMilk) && S.events.some(isBreast) ? '（母乳とミルクを30分以内に続けてあげたときは1回と数えています）' : '';
  if(dsF.length && age && age.days < 60){
    const a = avgOf(dsF, 'feeds');
    if(a < 7) add('warn', `授乳回数が少なめです（1日平均${f1(a)}回）`,
      '記録漏れがなければ、生後2か月ごろまでは1日8〜12回くらいが目安です。おしっこの回数や体重の増えも合わせて見て、少ない日が続くときは小児科や助産師に相談してください。');
    else if(a < 8) add('info', `授乳回数はやや少なめです（1日平均${f1(a)}回）`,
      '目安は1日8〜12回くらいです。おしっこがしっかり出ていれば、飲めているサインです。' + mixNote);
    else if(a <= 12) add('good', `授乳回数は目安の範囲です（1日平均${f1(a)}回）`,
      '生後2か月ごろまでの目安（1日8〜12回）に入っています。' + mixNote);
    else add('info', `授乳回数が多めです（1日平均${f1(a)}回）`,
      '急によく飲みたがる時期や、1回に飲む量が少ないときは回数が増えることがあります。おしっこが出て機嫌がよければ、心配しすぎなくて大丈夫です。');
  }

  // 授乳間隔の変化（直近7日 と その前の7日）
  let kind = 'milk';
  let g1 = avgFeedGap(today - 6 * DAY, now, kind), g0 = avgFeedGap(today - 13 * DAY, today - 6 * DAY, kind);
  if(!(g1 && g0)){ kind = 'all'; g1 = avgFeedGap(today - 6 * DAY, now, kind); g0 = avgFeedGap(today - 13 * DAY, today - 6 * DAY, kind); }
  const gname = kind === 'milk' ? 'ミルク' : '授乳';
  if(g1 && g0){
    if(g1 - g0 >= 15 * MIN) add('good', `${gname}の間隔がのびてきました（${durTxt(g0)} → ${durTxt(g1)}）`,
      '1回にしっかり飲めるようになってきたサインです。');
    else if(g0 - g1 >= 30 * MIN) add('info', `${gname}の間隔が短くなっています（${durTxt(g0)} → ${durTxt(g1)}）`,
      '急によく飲みたがる時期かもしれません。数日で落ち着くことが多いです。おしっこが減る、機嫌が悪い日が続くときは相談してください。');
  }

  // おしっこ（生後1週〜6か月ごろ）
  const dsD = ds.filter(x => x.diapers > 0);
  if(dsD.length && (!age || (age.days >= 6 && age.months < 6))){
    const w = avgOf(dsD, 'wet');
    if(w < 5) add('warn', `おむつがぬれる回数が少なめです（1日平均${f1(w)}回）`,
      '記録漏れがなければ、母乳・ミルクが足りているかの目安になります。生後1週ごろからは1日6回以上ぬれるのが目安です。おしっこの色が濃い黄色でないか、口の中が乾いていないかも見て、少ない日が続くときや元気がないときは小児科に相談してください。');
    else if(w < 6) add('info', `おしっこはほぼ目安どおりです（1日平均${f1(w)}回）`,
      '目安は1日6回以上です。少ない日が続かないか見ていきましょう。');
    else add('good', `おしっこはしっかり出ています（1日平均${f1(w)}回）`,
      '1日6回以上ぬれていれば、しっかり飲めているサインの一つです。');
  }

  // うんち（3日以上記録がない）
  const diapAll = S.events.filter(e => e.type === 'diaper');
  if(diapAll.length && diapAll[0].t < now - 3 * DAY){
    const poops = diapAll.filter(e => e.sub === 'うんち' || e.sub === '両方');
    const lp = poops[poops.length - 1];
    const d = Math.floor((now - (lp ? lp.t : diapAll[0].t)) / DAY);
    if(d >= 3){
      const young = age && age.days < 30;
      add(young ? 'warn' : 'info', `うんちが${d}日${lp ? '' : '以上'}出ていません`,
        '記録漏れがなければ、' + (young
          ? '生後1か月ごろまでは毎日出ることが多いので、出ない日が続くときは早めに小児科に相談してください。'
          : '数日出ないこともあり、機嫌がよく飲めていれば様子を見てよいことも多いです。')
        + 'お腹がはって苦しそう、吐く、機嫌が悪い、硬くて出にくそうなときは小児科に相談してください。');
    }
  }

  // 睡眠時間
  const dsS = ds.filter(x => x.sleepN > 0);
  const rng = sleepRange(age);
  if(dsS.length && rng){
    const h = avgOf(dsS, 'sleepH');
    const [lo, hi, label] = rng;
    if(h < lo) add('info', `睡眠は目安より短めです（1日平均${f1(h)}時間）`,
      `${label}の目安は1日${lo}〜${hi}時間（お昼寝を含む）です。お昼寝も記録できているか確認してみてください。眠る時間は個人差が大きく、機嫌がよく育っていれば心配いらないことも多いです。寝つきが悪い日が続くなら、夜は部屋を暗く静かにする、寝る前の流れを毎日同じにする、などを試してみてください。`);
    else if(h > hi) add('info', `よく眠っています（1日平均${f1(h)}時間）`,
      `${label}の目安は1日${lo}〜${hi}時間です。よく眠ること自体は多くの場合心配いりませんが、起こしても飲まない、ぐったりしているなどのときは小児科に相談してください。`);
    else add('good', `睡眠時間は目安の範囲です（1日平均${f1(h)}時間）`,
      `${label}の目安（1日${lo}〜${hi}時間）に入っています。`);
  }

  // いちばん長い睡眠ののび
  const l1 = longestSleep(today - 6 * DAY, now), l0 = longestSleep(today - 13 * DAY, today - 6 * DAY);
  if(l1 && l0 && l1 - l0 >= 30 * MIN) add('good', `まとまって眠れるようになってきました（最長 ${durTxt(l0)} → ${durTxt(l1)}）`,
    '眠りのリズムが育ってきているサインです。');

  if(!age) add('info', '生年月日を設定すると、アドバイスが詳しくなります',
    '「設定」で赤ちゃんの生年月日を入れると、月齢に合わせた目安と比べられます。');
  if(!A.length) add('good', '特に気になる点はありません', 'この調子で記録を続けていきましょう。');

  const order = { alert: 0, warn: 1, info: 2, good: 3 };
  return A.sort((a, b) => order[a.level] - order[b.level]);
}

function adviceHTML(){
  const mark = { alert: '!', warn: '!', info: 'i', good: '✓' };
  return `<div class="card advice"><h3>今のようすとアドバイス</h3>
    <p class="note">直近3日間の記録と月齢から見た目安です</p>
    <ul class="adv">${buildAdvice().map(a => `
      <li class="adv-${a.level}"><span class="adv-m">${mark[a.level]}</span>
        <div><b>${esc(a.title)}</b><p>${esc(a.text)}</p></div></li>`).join('')}
    </ul>
    <p class="adv-foot">記録をもとにした一般的な目安で、診断ではありません。いつもと様子が違う、ぐったりしている、飲めないなどのときは、迷わず小児科へ。夜間・休日に迷ったら <a href="tel:%238000">#8000</a>（こども医療でんわ相談）へ。</p>
  </div>`;
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
    <div class="card"><h3>夜間モード</h3>
      <p class="note">夜はまぶしくない暗い画面になります（この端末だけの設定）。</p>
      <div class="tseg">${[['auto', '自動（19〜6時）'], ['on', 'いつも'], ['off', 'オフ']].map(([v, l]) =>
        `<button data-theme-v="${v}" class="${themePref() === v ? 'on' : ''}">${l}</button>`).join('')}</div>
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
  $('v-set').querySelectorAll('[data-theme-v]').forEach(b => b.onclick = () => {
    try{ localStorage.setItem(THEME_KEY, b.dataset.themeV); }catch(e){}
    applyTheme();
    renderSet();
  });
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
    S.familyId = null; S.events = []; S.members = {}; S.baby = {name:'', birth:''}; S.milton = null; S.ready = false;
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
  hideAtoast();
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

setInterval(() => {
  applyTheme();
  if(S.ready && view === 'today' && !$('ov').classList.contains('show')) renderToday();
}, 30000);

if('serviceWorker' in navigator && location.protocol === 'https:'){
  // 新しい版に切り替わったら自動で読み込み直す（入力中は「新しい版」の案内だけ）
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if(!hadController || reloading) return;
    if($('ov').classList.contains('show')){ toast('新しい版があります。閉じて開き直すと反映されます'); return; }
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then(reg => {
      // アプリに戻ってきたときにも更新を確認
      document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') reg.update().catch(() => {}); });
    })
    .catch(() => {});
}
