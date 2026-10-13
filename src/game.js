// ゲーム進行の状態はホストだけが持つ。各端末には view() で見せてよい情報だけを送る。
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 8;
export const ROUNDS = 4;

// 人数ごとの役職カード [ボム処理班, ボマー団]。人数より多い分は誰にも配られず伏せたまま。
export const ROLE_TABLE = { 4: [3, 2], 5: [3, 2], 6: [4, 2], 7: [5, 3], 8: [5, 3] };

// 導線カード: D=解除, S=安全, B=爆弾
export const CARD_NAMES = { D: '解除', S: '安全', B: '爆弾' };
export const ROLE_NAMES = { P: 'ボム処理班', B: 'ボマー団' };

export function createGame(hostId, hostName) {
  return {
    phase: 'lobby',
    hostId,
    players: [{ id: hostId, name: hostName, connected: true }],
    order: [],
    roles: {}, extraRoles: [],
    hands: {},
    round: 0, cutsInRound: 0, nippers: null,
    found: 0, cuts: [], aim: null, declares: {},
    winner: null, reason: null, gameNo: 0,
  };
}

const player = (g, id) => g.players.find((p) => p.id === id);

export function addPlayer(g, id, name) {
  const p = player(g, id);
  if (p) { p.connected = true; if (name) p.name = name; return null; }
  if (g.phase !== 'lobby') return 'ゲームが進行中のため参加できません';
  if (g.players.length >= MAX_PLAYERS) return '満員です（最大8人）';
  g.players.push({ id, name, connected: true });
  return null;
}

export function setConnected(g, id, on) {
  const p = player(g, id);
  if (p) p.connected = on;
}

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 残っている導線カードをすべて集めて混ぜ、均等に配り直す
function deal(g, rng) {
  const deck = shuffle(g.order.flatMap((id) => g.hands[id] ?? []), rng);
  const n = deck.length / g.order.length;
  g.order.forEach((id, i) => { g.hands[id] = deck.slice(i * n, (i + 1) * n); });
  g.cutsInRound = 0;
  g.declares = {};
  g.aim = null;
}

function start(g, rng) {
  const n = g.players.length;
  g.order = shuffle(g.players.map((p) => p.id), rng);
  const [police, bombers] = ROLE_TABLE[n];
  const roleDeck = shuffle([...Array(police).fill('P'), ...Array(bombers).fill('B')], rng);
  g.roles = Object.fromEntries(g.order.map((id, i) => [id, roleDeck[i]]));
  g.extraRoles = roleDeck.slice(n);
  g.hands = { [g.order[0]]: [...Array(n).fill('D'), 'B', ...Array(4 * n - 1).fill('S')] };
  deal(g, rng);
  g.round = 1;
  g.nippers = g.order[Math.floor(rng() * n)];
  g.found = 0;
  g.cuts = [];
  g.winner = null;
  g.reason = null;
  g.gameNo++;
  g.phase = 'play';
}

function finish(g, winner, reason) {
  g.phase = 'end';
  g.winner = winner;
  g.reason = reason;
  g.aim = null;
}

function cut(g, by, target, idx, rng) {
  const card = g.hands[target].splice(idx, 1)[0];
  g.cuts.push({ round: g.round, by, from: target, card });
  g.nippers = target;
  g.cutsInRound++;
  g.aim = null;
  if (card === 'B') return finish(g, 'B', 'bomb');
  if (card === 'D' && ++g.found === g.order.length) return finish(g, 'P', 'defused');
  const noTarget = g.order.every((id) => id === g.nippers || !g.hands[id].length);
  if (g.cutsInRound >= g.order.length || noTarget) {
    if (g.round >= ROUNDS) return finish(g, 'B', 'timeout');
    g.round++;
    deal(g, rng);
  }
}

// a: { type, ... } を実行。エラー時はメッセージを返す
export function act(g, pid, a, rng = Math.random) {
  const isHost = pid === g.hostId;
  switch (a?.type) {
    case 'start':
      if (!isHost) return 'ホストのみ開始できます';
      if (g.phase !== 'lobby' && g.phase !== 'end') return null;
      if (g.players.length < MIN_PLAYERS) return `${MIN_PLAYERS}人以上で開始できます`;
      start(g, rng);
      return null;
    case 'kick': {
      if (!isHost || a.id === g.hostId) return null;
      if (g.phase === 'play') return 'ゲーム中は除外できません（ロビーに戻してください）';
      g.players = g.players.filter((p) => p.id !== a.id);
      return null;
    }
    case 'lobby':
      if (!isHost) return null;
      g.phase = 'lobby';
      g.aim = null;
      return null;
    case 'aim': {
      if (g.phase !== 'play' || pid !== g.nippers) return null;
      const ok = a.target !== pid && g.hands[a.target] && Number.isInteger(a.idx) && a.idx >= 0 && a.idx < g.hands[a.target].length;
      g.aim = ok ? { target: a.target, idx: a.idx } : null;
      return null;
    }
    case 'cut': {
      if (g.phase !== 'play') return null;
      if (pid !== g.nippers) return 'ニッパーを持っていません';
      if (a.target === pid) return '自分のカードは切れません';
      const hand = g.hands[a.target];
      if (!hand || !Number.isInteger(a.idx) || a.idx < 0 || a.idx >= hand.length) return 'そのカードは選べません';
      cut(g, pid, a.target, a.idx, rng);
      return null;
    }
    case 'declare': {
      if (g.phase !== 'play' || !g.hands[pid]) return null;
      const max = g.hands[pid].length + g.cuts.filter((c) => c.round === g.round && c.from === pid).length;
      const d = Math.max(0, Math.min(max, Number(a.d) || 0));
      g.declares[pid] = { d, b: !!a.b };
      return null;
    }
    default:
      return '不明な操作です';
  }
}

const count = (cards) => cards.reduce((m, c) => (m[c]++, m), { D: 0, S: 0, B: 0 });

// pid の端末に送る情報。他人の役職と手札の中身は終了時まで送らない。
export function view(g, pid) {
  const end = g.phase === 'end';
  const v = {
    phase: g.phase, hostId: g.hostId, gameNo: g.gameNo,
    players: g.players.map((p) => ({ ...p })),
    order: g.order, round: g.round, cutsInRound: g.cutsInRound, nippers: g.nippers,
    found: g.found, cuts: g.cuts, aim: g.aim, declares: g.declares,
    handSizes: Object.fromEntries(Object.entries(g.hands).map(([id, h]) => [id, h.length])),
    winner: g.winner, reason: g.reason,
    myRole: g.roles[pid] ?? null,
    myCards: g.hands[pid] && g.phase !== 'lobby' ? count(g.hands[pid]) : null,
  };
  if (end) {
    v.roles = g.roles;
    v.extraRoles = g.extraRoles;
    v.hands = g.hands;
  }
  return v;
}
