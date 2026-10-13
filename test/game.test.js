import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, addPlayer, act, view } from '../src/game.js';

const setup = (n) => {
  const g = createGame('p0', 'P0');
  for (let i = 1; i < n; i++) addPlayer(g, `p${i}`, `P${i}`);
  assert.equal(act(g, 'p0', { type: 'start' }), null);
  return g;
};

test('人数ごとの配布枚数と役職', () => {
  for (const n of [4, 5, 6, 7, 8]) {
    const g = setup(n);
    const all = g.order.flatMap((id) => g.hands[id]);
    assert.equal(all.length, n * 5);
    assert.equal(all.filter((c) => c === 'D').length, n);
    assert.equal(all.filter((c) => c === 'B').length, 1);
    assert.ok(g.order.every((id) => g.hands[id].length === 5));
    assert.equal(g.extraRoles.length, n === 4 || n === 7 ? 1 : 0);
  }
  const g = createGame('h', 'H');
  addPlayer(g, 'a', 'A');
  assert.notEqual(act(g, 'h', { type: 'start' }), null); // 4人未満は開始不可
});

test('他人の役職・手札は見えない', () => {
  const g = setup(5);
  const v = view(g, 'p1');
  assert.equal(v.roles, undefined);
  assert.equal(v.hands, undefined);
  assert.equal(v.myRole, g.roles.p1);
  assert.ok(!JSON.stringify(v).includes(g.roles.p2 === 'B' ? '"p2":"B"' : '"p2":"P"'));
});

test('自分のカードは切れず、切られた人にニッパーが移り、ラウンドで配り直し', () => {
  const g = setup(4);
  const h = g.nippers;
  assert.notEqual(act(g, h, { type: 'cut', target: h, idx: 0 }), null);
  // 爆弾を避けて切り続ける
  let cuts = 0;
  while (g.phase === 'play' && g.round === 1) {
    const me = g.nippers;
    const target = g.order.find((id) => id !== me && g.hands[id].some((c) => c !== 'B'));
    const before = g.nippers;
    act(g, before, { type: 'cut', target, idx: g.hands[target].findIndex((c) => c !== 'B') });
    cuts++;
    if (g.phase === 'play' && g.round === 1) assert.equal(g.nippers, target);
  }
  if (g.phase === 'play') {
    assert.equal(cuts, 4);
    assert.ok(g.order.every((id) => g.hands[id].length === 4));
  }
});

test('爆弾でボマー団、全解除でボム処理班、4ラウンド経過でボマー団', () => {
  let g = setup(4);
  let t = g.order.find((id) => id !== g.nippers && g.hands[id].includes('B'));
  if (!t) { g.hands[g.order.find((id) => id !== g.nippers)][0] = 'B'; t = g.order.find((id) => id !== g.nippers && g.hands[id].includes('B')); }
  act(g, g.nippers, { type: 'cut', target: t, idx: g.hands[t].indexOf('B') });
  assert.equal(g.winner, 'B');

  g = setup(4);
  while (g.phase === 'play') {
    const me = g.nippers;
    const target = g.order.find((id) => id !== me && g.hands[id].includes('D'))
      ?? g.order.find((id) => id !== me && g.hands[id].some((c) => c !== 'B'));
    const idx = g.hands[target].includes('D') ? g.hands[target].indexOf('D') : g.hands[target].findIndex((c) => c !== 'B');
    act(g, me, { type: 'cut', target, idx });
  }
  assert.ok(g.winner === 'P' || g.reason === 'timeout');

  g = setup(4);
  while (g.phase === 'play') {
    const me = g.nippers;
    const target = g.order.find((id) => id !== me && g.hands[id].includes('S'))
      ?? g.order.find((id) => id !== me && g.hands[id].includes('D'));
    act(g, me, { type: 'cut', target, idx: g.hands[target].includes('S') ? g.hands[target].indexOf('S') : g.hands[target].indexOf('D') });
  }
  assert.equal(g.reason, 'timeout');
  assert.equal(g.round, 4);
});
