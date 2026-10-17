import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './style.css';

import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Key } from 'chessground/types';
import { Chess, SQUARES } from 'chess.js';
import { buildTree, findMainline, moveLabel, START_FEN, type MoveNode, type Root } from './lib/tree';
import { Engine, type EngineInfo } from './engine';
import type { Book, Chapter } from './types';

// ---------- Data ----------
const books: Book[] = Object.values(
  import.meta.glob<Book>('../data/*.json', { eager: true, import: 'default' }),
);

interface Section {
  key: string;
  label: string;
  heading: string;
  meta: string;
  summary: string;
  keyPoints: { at?: string; text: string }[];
  root: Root;
}

function sectionsOf(ch: Chapter): Section[] {
  return [
    {
      key: 'intro',
      label: 'Pengenalan',
      heading: `Bab ${ch.number}: ${ch.title}`,
      meta: `Hlm. ${ch.pages[0]}–${ch.pages[1]}`,
      summary: ch.intro.summary,
      keyPoints: ch.intro.keyPoints.map((text) => ({ text })),
      root: buildTree(ch.intro.pgn, ch.intro.startFen).root,
    },
    ...ch.games.map((g) => ({
      key: g.id,
      label: `Game ${g.number}`,
      heading: `${g.white} – ${g.black}`,
      meta: [g.event, g.year, g.result, `hlm. ${g.pages[0]}–${g.pages[1]}`].filter(Boolean).join(' · '),
      summary: g.summary,
      keyPoints: g.keyPoints,
      root: buildTree(g.pgn, g.startFen ?? START_FEN).root,
    })),
  ];
}

// ---------- State ----------
const book = books[0];
let chapter = book.chapters[0];
let sections = sectionsOf(chapter);
let section = sections[0];
let current: MoveNode | null = null; // null = posisi permulaan
let userCounter = 0;
let engineOn = false;
let lastInfo: EngineInfo | null = null;
let tab: 'ringkasan' | 'langkah' = 'ringkasan';

const engine = new Engine();

// ---------- Layout ----------
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="top">
    <div class="brand"><span class="mark">♞</span> Rak Catur</div>
    <div class="book-title"><em>${book.title}</em> <span class="muted">— ${book.author}</span></div>
    <select id="chapter" aria-label="Pilih bab"></select>
  </header>
  <nav class="sections" id="sections"></nav>
  <main class="layout">
    <section class="board-col">
      <div class="board-wrap">
        <div class="evalbar" id="evalbar"><div class="evalfill" id="evalfill"></div></div>
        <div class="board" id="board"></div>
      </div>
      <div class="controls">
        <button data-nav="start" title="Mula (Home)">⏮</button>
        <button data-nav="prev" title="Undur (←)">◀</button>
        <button data-nav="next" title="Maju (→)">▶</button>
        <button data-nav="end" title="Akhir (End)">⏭</button>
        <button id="flip" title="Terbalikkan papan (f)">⇅</button>
        <label class="toggle"><input type="checkbox" id="engine-toggle" /> <span>Stockfish</span></label>
      </div>
      <div class="engine-line" id="engine-line" hidden></div>
      <div class="comment" id="comment"></div>
    </section>
    <aside class="side">
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="ringkasan">Ringkasan</button>
        <button role="tab" data-tab="langkah">Langkah</button>
      </div>
      <div class="panel" id="panel-ringkasan"></div>
      <div class="panel" id="panel-langkah"><div class="moves" id="moves"></div></div>
    </aside>
  </main>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ground: Api = Chessground($('board'), {
  coordinates: true,
  animation: { duration: 180 },
  movable: { free: false, color: 'both', showDests: true, events: { after: onUserMove } },
  draggable: { showGhost: true },
  highlight: { lastMove: true, check: true },
  drawable: { enabled: true },
});

// ---------- Helpers ----------
const FIG: Record<string, string> = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' };
const fig = (san: string) => san.replace(/^[KQRBN]/, (p) => FIG[p]).replace(/=([QRBN])/, (_, p) => '=' + FIG[p]);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function fenOf(node: MoveNode | null) {
  return node ? node.fen : section.root.fen;
}
function childrenOf(node: MoveNode | null) {
  return node ? node.children : section.root.children;
}

function dests(fen: string) {
  const chess = new Chess(fen);
  const map = new Map<Key, Key[]>();
  for (const sq of SQUARES) {
    const ms = chess.moves({ square: sq, verbose: true });
    if (ms.length) map.set(sq as Key, ms.map((m) => m.to as Key));
  }
  return map;
}

function findNode(id: string, nodes: MoveNode[] = section.root.children): MoveNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = findNode(id, n.children);
    if (f) return f;
  }
  return null;
}

// ---------- Navigation ----------
function goto(node: MoveNode | null) {
  current = node;
  render();
}

function nav(dir: 'start' | 'prev' | 'next' | 'end') {
  if (dir === 'start') return goto(null);
  if (dir === 'prev') return goto(current?.parent ?? null);
  if (dir === 'next') {
    const c = childrenOf(current)[0];
    if (c) goto(c);
    return;
  }
  let n = current ?? section.root.children[0] ?? null;
  while (n?.children[0]) n = n.children[0];
  goto(n);
}

function onUserMove(orig: Key, dest: Key) {
  const fen = fenOf(current);
  const existing = childrenOf(current).find((c) => c.uci[0] === orig && c.uci[1] === dest);
  if (existing) return goto(existing);
  const chess = new Chess(fen);
  let res;
  try {
    res = chess.move({ from: orig, to: dest, promotion: 'q' });
  } catch {
    return render();
  }
  const node: MoveNode = {
    id: `u${++userCounter}`,
    ply: (current?.ply ?? plyOfRoot()) + 1,
    san: res.san,
    uci: [orig, dest],
    fen: chess.fen(),
    parent: current,
    children: [],
    comment: undefined,
  };
  childrenOf(current).push(node);
  goto(node);
}

function plyOfRoot() {
  const [, turn, , , , full] = section.root.fen.split(' ');
  return (Number(full) - 1) * 2 + (turn === 'w' ? 0 : 1);
}

// ---------- Render ----------
function renderChapterSelect() {
  const sel = $<HTMLSelectElement>('chapter');
  sel.innerHTML = book.chapters.map((c) => `<option value="${c.id}">Bab ${c.number}: ${esc(c.title)}</option>`).join('');
  sel.value = chapter.id;
}

function renderSections() {
  $('sections').innerHTML = sections
    .map(
      (s) =>
        `<button class="sec ${s === section ? 'active' : ''}" data-sec="${s.key}"><span>${s.label}</span>${
          s.key === 'intro' ? '' : `<small>${esc(s.heading)}</small>`
        }</button>`,
    )
    .join('');
}

function renderSummary() {
  const kps = section.keyPoints
    .map((k, i) => {
      const node = k.at ? findMainline(section.root, k.at) : undefined;
      const active = node && node === current ? 'active' : '';
      return `<li class="kp ${node ? 'linked' : ''} ${active}" ${node ? `data-node="${node.id}"` : ''}>
        ${node ? `<span class="kp-move">${fig(k.at!)}</span>` : `<span class="kp-num">${i + 1}</span>`}
        <span>${esc(k.text)}</span></li>`;
    })
    .join('');
  $('panel-ringkasan').innerHTML = `
    <h2>${esc(section.heading)}</h2>
    <p class="meta">${esc(section.meta)}</p>
    <p class="summary">${esc(section.summary)}</p>
    <h3>Point penting</h3>
    <ol class="kps">${kps}</ol>`;
}

function renderMoves() {
  const line = (nodes: MoveNode[], depth: number): string => {
    // nodes = senarai main line bermula dari nodes[0]; variation ialah adik-beradik nodes[0]
    let html = '';
    let n: MoveNode | undefined = nodes[0];
    let siblings = nodes.slice(1);
    let first = true;
    while (n) {
      const white = n.ply % 2 === 1;
      const num = white ? `${Math.ceil(n.ply / 2)}.` : first ? `${Math.ceil(n.ply / 2)}…` : '';
      html += `<span class="mv ${n === current ? 'cur' : ''} ${n.id.startsWith('u') ? 'user' : ''}" data-node="${n.id}">${
        num ? `<i>${num}</i>` : ''
      }${fig(n.san)}</span>`;
      if (n.comment) html += `<span class="cm">${esc(n.comment)}</span>`;
      for (const v of siblings) html += `<div class="var d${Math.min(depth + 1, 4)}">${line([v], depth + 1)}</div>`;
      first = siblings.length > 0 || !!n.comment;
      siblings = n.children.slice(1);
      n = n.children[0];
    }
    return html;
  };
  const rootComment = section.root.comment ? `<span class="cm">${esc(section.root.comment)}</span>` : '';
  const kids = section.root.children;
  $('moves').innerHTML = rootComment + (kids.length ? line(kids, 0) : '');
  $('moves').querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
}

function renderBoard() {
  const fen = fenOf(current);
  const chess = new Chess(fen);
  ground.set({
    fen,
    turnColor: chess.turn() === 'w' ? 'white' : 'black',
    lastMove: current ? (current.uci as Key[]) : undefined,
    check: chess.inCheck(),
    movable: { dests: dests(fen), color: chess.turn() === 'w' ? 'white' : 'black' },
  });
  drawShapes();
}

function drawShapes() {
  const shapes: { orig: Key; dest?: Key; brush: string }[] = [];
  if (engineOn && lastInfo?.best && lastInfo.fen === fenOf(current)) {
    shapes.push({ orig: lastInfo.best[0] as Key, dest: lastInfo.best[1] as Key, brush: 'blue' });
  }
  // Tunjuk alternatif dari buku (variation) sebagai anak panah hijau
  childrenOf(current)
    .slice(1)
    .forEach((c) => shapes.push({ orig: c.uci[0] as Key, dest: c.uci[1] as Key, brush: 'green' }));
  ground.setAutoShapes(shapes);
}

function renderComment() {
  const el = $('comment');
  const kp = section.keyPoints.find((k) => k.at && findMainline(section.root, k.at) === current);
  const parts: string[] = [];
  if (current) parts.push(`<div class="cur-move">${fig(moveLabel(current))}${current.id.startsWith('u') ? ' <span class="tag">langkah anda</span>' : ''}</div>`);
  if (kp) parts.push(`<div class="kp-callout"><b>Point penting</b> ${esc(kp.text)}</div>`);
  if (current?.comment) parts.push(`<p>${esc(current.comment)}</p>`);
  const alts = childrenOf(current).slice(1);
  if (alts.length)
    parts.push(
      `<p class="alts">Pilihan lain dalam buku (anak panah hijau): ${alts
        .map((a) => `<span class="mv" data-node="${a.id}">${fig(moveLabel(a))}</span>`)
        .join(' ')}</p>`,
    );
  if (!current && !section.root.comment) parts.push(`<p class="muted">Tekan ▶ atau → untuk mula. Gerakkan buah di papan untuk cuba idea sendiri.</p>`);
  el.innerHTML = parts.join('');
}

function renderEngine() {
  const lineEl = $('engine-line');
  const bar = $('evalbar');
  bar.classList.toggle('on', engineOn);
  lineEl.hidden = !engineOn;
  if (!engineOn) return;
  const fen = fenOf(current);
  if (!lastInfo || lastInfo.fen !== fen) {
    lineEl.innerHTML = `<span class="muted">Menganalisis…</span>`;
    return;
  }
  const { cp, mate, depth, pv } = lastInfo;
  const score = mate !== undefined ? `#${mate}` : `${cp! > 0 ? '+' : ''}${cp!.toFixed(2)}`;
  const pct = mate !== undefined ? (mate > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-0.4 * cp!)) - 1);
  $('evalfill').style.height = `${pct}%`;
  const startPly = (current?.ply ?? plyOfRoot()) + 1;
  const pvText = pv
    .map((s, i) => {
      const ply = startPly + i;
      const n = Math.ceil(ply / 2);
      return (ply % 2 === 1 ? `${n}.` : i === 0 ? `${n}…` : '') + fig(s);
    })
    .join(' ');
  lineEl.innerHTML = `<b>${score}</b> <span class="muted">d${depth}</span> <span class="pv">${pvText}</span>`;
}

function renderTabs() {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('panel-ringkasan').classList.toggle('show', tab === 'ringkasan');
  $('panel-langkah').classList.toggle('show', tab === 'langkah');
}

function render() {
  renderBoard();
  renderMoves();
  renderSummary();
  renderComment();
  renderTabs();
  if (engineOn) engine.analyse(fenOf(current));
  renderEngine();
  saveState();
}

// ---------- Persist (per pelayar) ----------
function saveState() {
  try {
    localStorage.setItem('rak-catur', JSON.stringify({ ch: chapter.id, sec: section.key }));
  } catch {
    /* abaikan */
  }
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem('rak-catur') ?? 'null');
    const ch = book.chapters.find((c) => c.id === s?.ch);
    if (ch) {
      chapter = ch;
      sections = sectionsOf(ch);
      section = sections.find((x) => x.key === s.sec) ?? sections[0];
    }
  } catch {
    /* abaikan */
  }
}

function selectSection(key: string) {
  section = sections.find((s) => s.key === key) ?? sections[0];
  current = null;
  lastInfo = null;
  renderSections();
  render();
}

// ---------- Events ----------
engine.onInfo = (info) => {
  if (info.fen !== fenOf(current)) return;
  lastInfo = info;
  renderEngine();
  drawShapes();
};

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const nodeEl = t.closest<HTMLElement>('[data-node]');
  if (nodeEl) {
    const n = findNode(nodeEl.dataset.node!);
    if (n) goto(n);
    return;
  }
  const navEl = t.closest<HTMLElement>('[data-nav]');
  if (navEl) return nav(navEl.dataset.nav as 'start');
  const secEl = t.closest<HTMLElement>('[data-sec]');
  if (secEl) return selectSection(secEl.dataset.sec!);
  const tabEl = t.closest<HTMLElement>('[data-tab]');
  if (tabEl) {
    tab = tabEl.dataset.tab as typeof tab;
    renderTabs();
  }
});

$('flip').addEventListener('click', () => ground.toggleOrientation());
$<HTMLInputElement>('engine-toggle').addEventListener('change', (e) => {
  engineOn = (e.target as HTMLInputElement).checked;
  if (!engineOn) engine.stop();
  render();
});
$<HTMLSelectElement>('chapter').addEventListener('change', (e) => {
  chapter = book.chapters.find((c) => c.id === (e.target as HTMLSelectElement).value)!;
  sections = sectionsOf(chapter);
  selectSection(sections[0].key);
});

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input, select, textarea')) return;
  const map: Record<string, 'start' | 'prev' | 'next' | 'end'> = {
    ArrowLeft: 'prev',
    ArrowRight: 'next',
    Home: 'start',
    End: 'end',
  };
  if (map[e.key]) {
    e.preventDefault();
    nav(map[e.key]);
  } else if (e.key === 'f') ground.toggleOrientation();
});

// ---------- Boot ----------
loadState();
renderChapterSelect();
renderSections();
render();
