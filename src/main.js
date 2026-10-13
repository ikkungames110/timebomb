import './style.css';
import { hostRoom, joinRoom, normalizeCode } from './net.js';
import {
  createGame, addPlayer, setConnected, act, view,
  MIN_PLAYERS, MAX_PLAYERS, ROUNDS, ROLE_TABLE, CARD_NAMES, ROLE_NAMES,
} from './game.js';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const $flash = document.getElementById('flash');

const LAST_KEY = 'timebomb-last';
const NAME_KEY = 'timebomb-name';

// 端末(タブ)ごとのプレイヤーID。リロードしても同じ席に戻れるよう sessionStorage に保持する。
const newId = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
let myId = sessionStorage.getItem('timebomb-id') || newId();
sessionStorage.setItem('timebomb-id', myId);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const urlRoom = normalizeCode(new URLSearchParams(location.search).get('room') || '');

const ui = {
  screen: 'home', // home | connecting | room | error
  status: '',
  role: null, // host | guest
  roomCode: null,
  v: null,
  peek: false, // 自分の役職・手札を表示中か
  flash: null, // 直前に切られたカードの演出
  reconnecting: false,
  rules: false,
  error: null,
};

let net = null;

// ───────── ホスト側 ─────────
let game = null;
const cidToPid = new Map();

function startHost(name) {
  ui.screen = 'connecting';
  ui.status = '部屋を準備中…';
  render();
  net = hostRoom({
    onCode(code) {
      ui.role = 'host';
      ui.roomCode = code;
      game = createGame(myId, name);
      ui.screen = 'room';
      sync();
    },
    onMessage: onGuestMessage,
    onClose(cid) {
      const pid = cidToPid.get(cid);
      cidToPid.delete(cid);
      if (pid && ![...cidToPid.values()].includes(pid)) { setConnected(game, pid, false); sync(); }
    },
    onError(type) { showError('部屋を作れませんでした', explain(type)); },
  });
}

function onGuestMessage(cid, m) {
  if (!game) return;
  if (m.t === 'hello') {
    const id = String(m.id || '').slice(0, 64);
    const name = String(m.name || '').trim().slice(0, 12) || 'ゲスト';
    if (!id || id === myId) { net.send(cid, { t: 'reject', msg: '同じ端末のタブからは参加できません' }); return; }
    const err = addPlayer(game, id, name);
    if (err) { net.send(cid, { t: 'reject', msg: err }); setTimeout(() => net.drop(cid), 800); return; }
    for (const [c, p] of cidToPid) if (p === id && c !== cid) { cidToPid.delete(c); net.drop(c); }
    cidToPid.set(cid, id);
    sync();
    return;
  }
  if (m.t === 'act') {
    const pid = cidToPid.get(cid);
    if (!pid) return;
    const err = act(game, pid, m.a);
    if (err) net.send(cid, { t: 'err', msg: err });
    sync();
  }
}

function sync() {
  for (const [cid, pid] of cidToPid) {
    if (!game.players.some((p) => p.id === pid)) {
      net.send(cid, { t: 'kicked' });
      cidToPid.delete(cid);
      setTimeout(() => net.drop(cid), 800);
      continue;
    }
    net.send(cid, { t: 'state', s: view(game, pid) });
  }
  setView(view(game, myId));
}

// ───────── ゲスト側 ─────────
let retries = 0;
let retryTimer = null;

function startJoin(code, name) {
  ui.role = 'guest';
  ui.roomCode = code;
  if (ui.screen !== 'room') { ui.screen = 'connecting'; ui.status = `部屋 ${code} に接続中…`; render(); }
  net?.close();
  const link = joinRoom(code, {
    onOpen() {
      link.send({ t: 'hello', id: myId, name });
      localStorage.setItem(LAST_KEY, JSON.stringify({ code, id: myId, name, at: Date.now() }));
    },
    onMessage(m) {
      if (m.t === 'state') {
        retries = 0;
        ui.reconnecting = false;
        ui.screen = 'room';
        setView(m.s);
      } else if (m.t === 'err') toast(m.msg);
      else if (m.t === 'reject') { leave(false); showError('参加できませんでした', m.msg); }
      else if (m.t === 'kicked') { leave(false); showError('部屋から退出しました', 'ホストによって除外されました'); }
    },
    onClose() { scheduleRetry(); },
    onError(type) {
      if (ui.screen === 'room') scheduleRetry();
      else showError('接続できませんでした', explain(type));
    },
  });
  net = link;
  net.name = name;
}

function scheduleRetry() {
  if (ui.role !== 'guest') return;
  if (retries++ >= 30) { const n = ui.roomCode; leave(false); showError('接続が切れました', `部屋 ${n} に再接続できませんでした。ホストが退出した可能性があります。`); return; }
  ui.reconnecting = true;
  render();
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => startJoin(ui.roomCode, net?.name || localName()), 2000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (ui.role === 'guest' && ui.reconnecting) { clearTimeout(retryTimer); startJoin(ui.roomCode, net?.name || localName()); }
  if (ui.role === 'host') net?.reconnectSignal();
});

// ───────── 共通 ─────────
function doAct(a) {
  if (ui.role === 'host') {
    const err = act(game, myId, a);
    if (err) toast(err);
    sync();
  } else net?.send({ t: 'act', a });
}

let flashTimer;
function setView(v) {
  const prev = ui.v;
  // 新しく切られたカードがあれば全員の画面で演出する
  if (prev && prev.gameNo === v.gameNo && v.cuts.length > prev.cuts.length) {
    const c = v.cuts[v.cuts.length - 1];
    ui.flash = { ...c, newRound: v.round > prev.round ? v.round : null };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { ui.flash = null; render(); }, c.card === 'B' ? 2600 : 1900);
  }
  if (!prev || prev.gameNo !== v.gameNo || prev.round !== v.round) ui.peek = false;
  if (prev && prev.gameNo !== v.gameNo && v.phase === 'play') toast('役職とカードが配られました');
  ui.v = v;
  render();
}

function leave(clearLast = true) {
  clearTimeout(retryTimer);
  net?.close();
  net = null;
  game = null;
  cidToPid.clear();
  if (clearLast) localStorage.removeItem(LAST_KEY);
  Object.assign(ui, { screen: 'home', role: null, roomCode: null, v: null, reconnecting: false, flash: null, peek: false });
  retries = 0;
  render();
}

function showError(title, sub) {
  clearTimeout(retryTimer);
  net?.close();
  net = null;
  ui.role = null;
  ui.screen = 'error';
  ui.error = { title, sub };
  render();
}

function explain(type) {
  return {
    'peer-unavailable': '部屋が見つかりません。コードを確認してください。',
    timeout: '時間内に接続できませんでした。電波状況を確認してもう一度お試しください。',
    network: 'ネットワークに接続できません。',
    'server-error': '接続サーバーに問題が発生しました。しばらくしてからお試しください。',
    'browser-incompatible': 'このブラウザは対応していません。',
  }[type] || `エラー: ${type}`;
}

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2400);
}

const localName = () => localStorage.getItem(NAME_KEY) || '';
const nameOf = (id) => ui.v?.players.find((p) => p.id === id)?.name ?? '（退出）';
const isHost = () => ui.role === 'host';
const shareUrl = () => `${location.origin}${location.pathname}?room=${ui.roomCode}`;

// ───────── 描画 ─────────
let lastFx = '';
function render() {
  let html = '';
  if (ui.screen === 'home') html = homeHtml();
  else if (ui.screen === 'connecting') html = `<div class="center"><div class="spinner"></div><p>${esc(ui.status)}</p><button class="ghost" data-act="leave">キャンセル</button></div>`;
  else if (ui.screen === 'error') html = `<div class="center"><h2>${esc(ui.error.title)}</h2><p class="sub">${esc(ui.error.sub)}</p><button class="primary" data-act="home">トップへ</button></div>`;
  else if (ui.screen === 'room' && ui.v) html = roomHtml();
  if (ui.rules) html += rulesHtml();
  $app.innerHTML = html;
  // 演出は再描画でアニメーションが巻き戻らないよう #app の外に、変化したときだけ描く
  const fx = ui.flash && ui.screen === 'room' ? flashHtml() : '';
  if (fx !== lastFx) $flash.innerHTML = lastFx = fx;
}

function homeHtml() {
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LAST_KEY)); } catch {}
  if (last && Date.now() - last.at > 6 * 3600e3) last = null;
  return `
  <div class="home">
    <div class="logo-bomb">💣</div>
    <h1 class="logo">タイムボム</h1>
    <p class="tag">ボム処理班 vs ボマー団　正体隠匿の導線カット</p>
    <label class="field">ニックネーム
      <input id="in-name" maxlength="12" autocomplete="nickname" placeholder="例：たろう" value="${esc(localName())}" />
    </label>
    <button class="primary" data-act="create">部屋をつくる</button>
    <div class="or">または</div>
    <div class="join-row">
      <input id="in-code" class="code-input" maxlength="5" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="部屋コード" value="${esc(urlRoom)}" />
      <button class="primary alt" data-act="join">参加</button>
    </div>
    ${last ? `<button class="ghost" data-act="rejoin">前回の部屋（${esc(last.code)}）に戻る</button>` : ''}
    <button class="ghost" data-act="rules">あそびかた</button>
  </div>`;
}

function rulesHtml() {
  return `
  <div class="modal" data-act="rules-close">
    <section class="sheet" data-stop>
      <h2>あそびかた</h2>
      <p><b class="team-p">ボム処理班</b>と<b class="team-b">ボマー団</b>に分かれる正体隠匿ゲームです（4〜8人）。誰がどちらの陣営かは本人にしか分かりません。</p>
      <ol>
        <li>役職カードが1枚ずつ配られます。人数によっては余りの役職カードが1枚伏せられます。</li>
        <li>導線カード（人数×5枚）を全員に5枚ずつ配ります。中身は <b>解除</b>（人数分）・<b>爆弾</b>（1枚）・残りは<b>安全</b>。自分のカードの内訳は見られますが、どこに何があるかは自分にも分かりません。</li>
        <li>自分の手札について自由に話し合います（ウソもOK）。アプリの「宣言」で解除の枚数・爆弾の有無を表明できます。</li>
        <li>ニッパー ✂️ を持つ人が、<b>自分以外</b>の誰かの伏せカードを1枚選んで切ります。切られたカードは公開され、ニッパーは切られた人に移ります。</li>
        <li>人数と同じ回数切ったらラウンド終了。残りのカードを集めて混ぜ、配り直します（4枚→3枚→2枚）。</li>
      </ol>
      <table class="score-table">
        <tr><th class="team-p">ボム処理班の勝利</th><td>解除カードをすべて切る</td></tr>
        <tr><th class="team-b">ボマー団の勝利</th><td>爆弾を切る、または4ラウンド終了までに解除しきれない</td></tr>
      </table>
      <table class="score-table">
        <tr><th>人数</th><td>4</td><td>5</td><td>6</td><td>7</td><td>8</td></tr>
        <tr><th class="team-p">ボム処理班</th>${Object.values(ROLE_TABLE).map(([p]) => `<td>${p}</td>`).join('')}</tr>
        <tr><th class="team-b">ボマー団</th>${Object.values(ROLE_TABLE).map(([, b]) => `<td>${b}</td>`).join('')}</tr>
      </table>
      <p class="note">役職カードは表の枚数を混ぜて1枚ずつ配るので、4人・7人では余り1枚が伏せられ、どちらの陣営が減っているかは分かりません。</p>
      <button class="primary" data-act="rules-close">とじる</button>
    </section>
  </div>`;
}

function roomHtml() {
  const v = ui.v;
  const body = { lobby: lobbyHtml, play: playHtml, end: endHtml }[v.phase]();
  const info = v.phase === 'play'
    ? `<span class="pill">R${v.round}/${ROUNDS}</span><span class="pill">✂️ ${v.cutsInRound}/${v.order.length}</span>`
    : '';
  return `
  <header class="bar">
    <span class="room">🏠 ${esc(ui.roomCode)}</span>${info}
    <span class="grow"></span>
    <button class="icon" data-act="rules" aria-label="ルール">?</button>
    <button class="icon" data-act="leave-room" aria-label="退出">✕</button>
  </header>
  ${ui.reconnecting ? '<div class="banner">再接続中…</div>' : ''}
  <main class="page">${body}</main>`;
}

function lobbyHtml() {
  const v = ui.v;
  const h = isHost();
  const n = v.players.length;
  const roles = ROLE_TABLE[n];
  return `
  <section class="card center-text">
    <div class="label">部屋コード</div>
    <div class="code">${esc(ui.roomCode)}</div>
    <button class="primary alt small" data-act="share">招待リンクを共有</button>
  </section>
  <section class="card">
    <h3>プレイヤー <small>${n}/${MAX_PLAYERS}</small></h3>
    <ul class="players">${v.players.map((p) => `
      <li class="${p.connected ? '' : 'off'}">
        <span class="dot"></span>
        <span class="pname">${esc(p.name)}${p.id === myId ? '<small>（あなた）</small>' : ''}${p.id === v.hostId ? '<small class="tag-host">ホスト</small>' : ''}</span>
        ${h && p.id !== myId ? `<button class="kick" data-act="kick" data-id="${esc(p.id)}">除外</button>` : ''}
      </li>`).join('')}</ul>
    ${roles
      ? `<p class="note">役職カード：<b class="team-p">ボム処理班${roles[0]}</b>・<b class="team-b">ボマー団${roles[1]}</b>（${roles[0] + roles[1] > n ? '1枚は伏せる' : '全員に配る'}）／導線カード${n * 5}枚（解除${n}・爆弾1・安全${n * 4 - 1}）</p>`
      : `<p class="note">${MIN_PLAYERS}〜${MAX_PLAYERS}人で遊べます</p>`}
  </section>
  ${h
    ? `<button class="primary" data-act="start" ${roles ? '' : 'disabled'}>ゲーム開始</button>
       ${n < MIN_PLAYERS ? `<p class="note center-text">あと${MIN_PLAYERS - n}人で開始できます</p>` : ''}`
    : '<p class="wait">ホストの開始を待っています…</p>'}`;
}

const cardFace = (c, cls = '') => `<span class="card-face ${c} ${cls}">${c === 'B' ? '💣' : c === 'D' ? '🔧' : ''}<b>${CARD_NAMES[c]}</b></span>`;

function myPanelHtml() {
  const v = ui.v;
  const m = v.myCards;
  if (!v.myRole || !m) return '<p class="wait">観戦中</p>';
  const total = m.D + m.S + m.B;
  const dec = v.declares[myId];
  const max = total + v.cuts.filter((c) => c.round === v.round && c.from === myId).length;
  return `
  <section class="card mine ${ui.peek ? 'open' : ''}">
    <div class="mine-head">
      <h3>あなたの役職と手札</h3>
      <button class="peek-btn" data-act="peek">${ui.peek ? '隠す' : '👁 見る'}</button>
    </div>
    ${ui.peek
      ? `<div class="role-badge ${v.myRole}">${ROLE_NAMES[v.myRole]}</div>
         <div class="mine-cards">
           ${['D', 'S', 'B'].map((c) => `<div class="mc ${m[c] ? '' : 'zero'}">${cardFace(c, 'sm')}<span>×${m[c]}</span></div>`).join('')}
         </div>
         <p class="note">残り${total}枚。どこに何があるかはあなたにも分かりません。</p>`
      : '<p class="note">周りに見られないように確認してください</p>'}
    <div class="declare">
      <span class="dl">宣言</span>
      <div class="seg wrap">${Array.from({ length: max + 1 }, (_, d) => `<button class="${dec?.d === d ? 'on' : ''}" data-act="declare" data-d="${d}">解除${d}</button>`).join('')}</div>
      <div class="seg"><button class="${dec && !dec.b ? 'on' : ''}" data-act="declare-b" data-b="0">爆弾なし</button><button class="${dec?.b ? 'on bomb' : ''}" data-act="declare-b" data-b="1">爆弾あり</button></div>
    </div>
  </section>`;
}

function tableHtml() {
  const v = ui.v;
  const holder = v.nippers === myId;
  return `<ul class="table">${v.order.map((id) => {
    const p = v.players.find((x) => x.id === id);
    const dec = v.declares[id];
    const size = v.handSizes[id] ?? 0;
    const cutHere = v.cuts.filter((c) => c.round === v.round && c.from === id);
    const can = holder && id !== myId;
    return `<li class="seat ${id === v.nippers ? 'holder' : ''} ${p?.connected === false ? 'off' : ''}">
      <div class="seat-head">
        <span class="pname">${id === v.nippers ? '<span class="nip">✂️</span>' : ''}${esc(nameOf(id))}${id === myId ? '<small>（あなた）</small>' : ''}${p?.connected === false ? '<small>（切断中）</small>' : ''}</span>
        ${dec ? `<span class="dec">解除${dec.d}${dec.b ? '<em>💣あり</em>' : ''}</span>` : '<span class="dec none">未宣言</span>'}
      </div>
      <div class="cards">
        ${Array.from({ length: size }, (_, i) => {
          const aimed = v.aim?.target === id && v.aim.idx === i;
          return `<button class="card-back ${aimed ? 'aimed' : ''} ${can ? 'can' : ''}" ${can ? `data-act="aim" data-id="${esc(id)}" data-i="${i}"` : 'disabled'} aria-label="${esc(nameOf(id))}のカード${i + 1}"></button>`;
        }).join('')}
        ${cutHere.map((c) => cardFace(c.card, 'cut')).join('')}
      </div>
    </li>`;
  }).join('')}</ul>`;
}

function historyHtml() {
  const v = ui.v;
  if (!v.cuts.length) return '';
  const rounds = [...new Set(v.cuts.map((c) => c.round))];
  return `<section class="card"><h3>切られたカード</h3>
    ${rounds.map((r) => `<div class="hist-round"><div class="label">ラウンド${r}</div><ol class="hist">${v.cuts.filter((c) => c.round === r).map((c) => `
      <li class="${c.card}"><span>${esc(nameOf(c.by))} → ${esc(nameOf(c.from))}</span>${cardFace(c.card, 'sm')}</li>`).join('')}</ol></div>`).join('')}
  </section>`;
}

function playHtml() {
  const v = ui.v;
  const n = v.order.length;
  const holder = v.nippers === myId;
  const aimOk = holder && v.aim;
  const remainCuts = n - v.cutsInRound;
  return `
  <section class="status">
    <div class="defuse">${Array.from({ length: n }, (_, i) => `<span class="dot-d ${i < v.found ? 'on' : ''}">🔧</span>`).join('')}</div>
    <div class="status-text">解除 <b>${v.found}</b>/${n}　ラウンド${v.round}残り ${remainCuts}回</div>
  </section>
  ${holder
    ? `<div class="turn me">✂️ あなたがニッパーを持っています。<br>自分以外のカードを選んで切ってください</div>`
    : `<div class="turn">✂️ <b>${esc(nameOf(v.nippers))}</b> さんがカードを選んでいます${v.aim ? `（${esc(nameOf(v.aim.target))} さんのカードに注目…）` : ''}</div>`}
  ${tableHtml()}
  ${holder ? `<button class="primary danger sticky" data-act="cut" ${aimOk ? '' : 'disabled'}>${aimOk ? `${esc(nameOf(v.aim.target))} さんのカードを切る！` : 'カードを選んでください'}</button>` : ''}
  ${myPanelHtml()}
  ${historyHtml()}
  ${isHost() ? '<button class="ghost small" data-act="abort">ゲームを中断してロビーに戻る</button>' : ''}`;
}

function flashHtml() {
  const f = ui.flash;
  return `<div class="flash ${f.card}">
    <div class="flash-box">
      <div class="flash-who">${esc(nameOf(f.by))} が ${esc(nameOf(f.from))} のカードを切った！</div>
      <div class="flash-card">${cardFace(f.card, 'xl')}</div>
      ${f.newRound ? `<div class="flash-round">ラウンド${f.newRound}へ　カードを配り直します</div>` : ''}
    </div>
  </div>`;
}

function endHtml() {
  const v = ui.v;
  const won = v.myRole && v.myRole === v.winner;
  const reason = { bomb: '爆弾が切られた！', defused: 'すべての解除カードを切った！', timeout: '4ラウンド以内に解除できなかった…' }[v.reason];
  const team = (r) => v.order.filter((id) => v.roles[id] === r);
  const teamHtml = (r) => `<div class="team ${r} ${v.winner === r ? 'win' : ''}"><h3>${ROLE_NAMES[r]}${v.winner === r ? ' 🏆' : ''}</h3>
    <ul>${team(r).map((id) => `<li>${esc(nameOf(id))}${id === myId ? '<small>（あなた）</small>' : ''}</li>`).join('') || '<li class="note">なし</li>'}</ul></div>`;
  return `
  <section class="result ${v.winner}">
    <div class="result-icon">${v.winner === 'B' ? '💥' : '🎉'}</div>
    <h2>${ROLE_NAMES[v.winner]}の勝利！</h2>
    <p>${reason}</p>
    ${v.myRole ? `<p class="you ${won ? 'won' : 'lost'}">${won ? 'あなたの陣営の勝ち！' : 'あなたの陣営の負け…'}</p>` : ''}
  </section>
  <div class="teams">${teamHtml('P')}${teamHtml('B')}</div>
  ${v.extraRoles.length ? `<p class="note center-text">伏せられていた役職カード：${v.extraRoles.map((r) => `<b class="team-${r.toLowerCase()}">${ROLE_NAMES[r]}</b>`).join('・')}</p>` : ''}
  <section class="card"><h3>残っていたカード</h3>
    <ul class="players">${v.order.map((id) => `<li><span class="pname">${esc(nameOf(id))}</span><span class="left-cards">${(v.hands[id] || []).map((c) => cardFace(c, 'sm')).join('') || '<small class="note">なし</small>'}</span></li>`).join('')}</ul>
  </section>
  ${historyHtml()}
  ${isHost()
    ? '<button class="primary" data-act="start">同じメンバーでもう一度</button><button class="ghost" data-act="to-lobby">ロビーに戻る</button>'
    : '<p class="wait">ホストの操作を待っています…</p>'}
  <button class="ghost" data-act="leave-room">退出する</button>`;
}

// ───────── 操作 ─────────
function readName() {
  const el = document.getElementById('in-name');
  const name = (el?.value || '').trim().slice(0, 12);
  if (!name) { toast('ニックネームを入力してください'); el?.focus(); return null; }
  localStorage.setItem(NAME_KEY, name);
  return name;
}

const handlers = {
  create() { const n = readName(); if (n) startHost(n); },
  join() {
    const n = readName(); if (!n) return;
    const code = normalizeCode(document.getElementById('in-code').value);
    if (code.length !== 5) { toast('5文字の部屋コードを入力してください'); return; }
    retries = 0;
    startJoin(code, n);
  },
  rejoin() {
    let last; try { last = JSON.parse(localStorage.getItem(LAST_KEY)); } catch {}
    if (!last) return;
    myId = last.id;
    sessionStorage.setItem('timebomb-id', myId);
    retries = 0;
    startJoin(last.code, last.name);
  },
  rules() { ui.rules = true; render(); },
  'rules-close'(el, e) { if (e.target.closest('[data-stop]') && !e.target.closest('[data-act="rules-close"]')) return; ui.rules = false; render(); },
  leave() { leave(); },
  home() { ui.screen = 'home'; render(); },
  'leave-room'() {
    const msg = isHost() ? 'ホストが退出すると部屋が解散します。退出しますか？' : '退出しますか？';
    if (confirm(msg)) leave();
  },
  async share() {
    const url = shareUrl();
    try {
      if (navigator.share) await navigator.share({ title: 'タイムボム', text: `タイムボムの部屋 ${ui.roomCode} に参加しよう！`, url });
      else { await navigator.clipboard.writeText(url); toast('リンクをコピーしました'); }
    } catch (e) { if (e?.name !== 'AbortError') toast(url); }
  },
  start() { doAct({ type: 'start' }); },
  kick(el) { if (confirm(`${nameOf(el.dataset.id)} さんを除外しますか？`)) doAct({ type: 'kick', id: el.dataset.id }); },
  peek() { ui.peek = !ui.peek; render(); },
  aim(el) {
    const target = el.dataset.id, idx = Number(el.dataset.i);
    const same = ui.v.aim?.target === target && ui.v.aim.idx === idx;
    doAct({ type: 'aim', target: same ? null : target, idx });
  },
  cut() {
    const a = ui.v.aim;
    if (a) doAct({ type: 'cut', target: a.target, idx: a.idx });
  },
  declare(el) { doAct({ type: 'declare', d: Number(el.dataset.d), b: !!ui.v.declares[myId]?.b }); },
  'declare-b'(el) { doAct({ type: 'declare', d: ui.v.declares[myId]?.d ?? 0, b: el.dataset.b === '1' }); },
  abort() { if (confirm('ゲームを中断してロビーに戻りますか？')) doAct({ type: 'lobby' }); },
  'to-lobby'() { doAct({ type: 'lobby' }); },
};

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  handlers[el.dataset.act]?.(el, e);
});
$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'in-code') handlers.join();
});
$app.addEventListener('input', (e) => {
  if (e.target.id === 'in-code') e.target.value = normalizeCode(e.target.value);
});
window.addEventListener('beforeunload', (e) => {
  if (ui.role === 'host' && game) { e.preventDefault(); e.returnValue = ''; }
});

render();
