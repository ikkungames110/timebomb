import Peer from 'peerjs';

// PeerJS (WebRTC) によるスター型通信。ホスト端末が進行役となり、各プレイヤーと直接つながる。
// シグナリングのみ PeerJS 公開ブローカーを使い、ゲーム中のデータは端末同士で直接やり取りされる。
const PREFIX = 'timebomb-room-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];
if (import.meta.env.VITE_TURN_URL) {
  iceServers.push({
    urls: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USER,
    credential: import.meta.env.VITE_TURN_PASS,
  });
}
const peerOptions = { config: { iceServers } };

export const normalizeCode = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
const randomCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

// ホスト: 部屋コードを発行して複数の接続を待ち受ける
// ev: onCode(code), onMessage(cid, msg), onClose(cid), onError(type)
export function hostRoom(ev) {
  let peer, destroyed = false, opened = false, tries = 0, seq = 0;
  const conns = new Map();
  const start = () => {
    const code = randomCode();
    peer = new Peer(PREFIX + code, peerOptions);
    peer.on('open', () => { if (!opened) { opened = true; ev.onCode(code); } });
    peer.on('connection', (conn) => {
      const cid = ++seq;
      conn.on('open', () => conns.set(cid, conn));
      conn.on('data', (d) => { if (d && typeof d === 'object') ev.onMessage(cid, d); });
      const end = () => { if (conns.delete(cid) && !destroyed) ev.onClose(cid); };
      conn.on('close', end);
      conn.on('error', end);
    });
    peer.on('error', (e) => {
      if (destroyed) return;
      if (!opened && e.type === 'unavailable-id' && tries++ < 5) { peer.destroy(); start(); return; }
      if (!opened) ev.onError(e.type);
      else console.warn('peer error', e.type);
    });
    peer.on('disconnected', () => { if (!destroyed && !peer.destroyed) peer.reconnect(); });
  };
  start();
  return {
    send: (cid, m) => { const c = conns.get(cid); if (c?.open) c.send(m); },
    drop: (cid) => { const c = conns.get(cid); conns.delete(cid); try { c?.close(); } catch {} },
    reconnectSignal: () => { if (!destroyed && peer && !peer.destroyed && peer.disconnected) peer.reconnect(); },
    close: () => { destroyed = true; for (const c of conns.values()) { try { c.close(); } catch {} } peer?.destroy(); },
  };
}

// ゲスト: コードで参加
// ev: onOpen(), onMessage(msg), onClose(), onError(type)
export function joinRoom(code, ev) {
  const peer = new Peer(peerOptions);
  let conn = null, destroyed = false, opened = false, closed = false;
  const fail = (type) => { if (!destroyed && !closed) { closed = true; clearTimeout(timer); ev.onError(type); } };
  const timer = setTimeout(() => { if (!opened) fail('timeout'); }, 15000);
  peer.on('open', () => {
    conn = peer.connect(PREFIX + code, { reliable: true });
    conn.on('open', () => { opened = true; clearTimeout(timer); ev.onOpen(); });
    conn.on('data', (d) => { if (!destroyed && d && typeof d === 'object') ev.onMessage(d); });
    const end = () => { if (!destroyed && !closed && opened) { closed = true; ev.onClose(); } };
    conn.on('close', end);
    conn.on('error', end);
  });
  peer.on('error', (e) => { if (!opened) fail(e.type); else console.warn('peer error', e.type); });
  peer.on('disconnected', () => { if (!destroyed && !peer.destroyed && opened) peer.reconnect(); });
  return {
    send: (m) => { if (conn?.open) conn.send(m); },
    close: () => { destroyed = true; clearTimeout(timer); peer.destroy(); },
  };
}
