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
import { chapterPgn, download, gamePgn, introPgn } from './pgn';
import { parseQuery, searchTree } from './search';
import { allNotes, cardOf, dueCards, isRead, markRead, noteOf, review, setNote } from './userdata';
import type { Book, Chapter } from './types';
import { parseHash, setHash, bookHref, sectionHref } from './router';

// ---------- Data ----------
const books: Book[] = Object.values(
  import.meta.glob<Book>('../data/*.json', { eager: true, import: 'default' }),
);
const findBook = (id: string) => books.find((b) => b.id === id);

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
      label: 'Ringkasan bab',
      heading: `Bab ${ch.number}: ${ch.title}`,
      meta: `Hlm. ${ch.pages[0]}–${ch.pages[1]} · ${ch.gameIndex?.length ?? ch.games.length} game`,
      summary: ch.intro?.summary ?? 'Ringkasan bab ini belum diproses.',
      keyPoints: (ch.intro?.keyPoints ?? []).map((text) => ({ text })),
      root: buildTree(ch.intro?.pgn ?? '', ch.intro?.startFen ?? START_FEN).root,
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

// Pokok dibina sekali per bab; cache kini di-scope dengan book id.
const sectionCache = new Map<string, Section[]>();
function getSections(book: Book, ch: Chapter) {
  const key = `${book.id}/${ch.id}`;
  let s = sectionCache.get(key);
  if (!s) sectionCache.set(key, (s = sectionsOf(ch)));
  return s;
}

// ---------- State ----------
let currentBookId: string | null = null;
let chapter: Chapter | null = null;
let sections: Section[] = [];
let section = sections[0];
let current: MoveNode | null = null; // null = posisi permulaan
let userCounter = 0;
let engineOn = false;
let lastInfo: EngineInfo | null = null;
let tab: 'ringkasan' | 'langkah' = 'ringkasan';
let firstVisit = false;
let editingNote = false;

// Latihan: papan sembunyikan langkah buku dan minta pengguna mainkannya.
const train = {
  on: false,
  side: (localStorage.getItem('rak-catur:side') as 'w' | 'b' | null) ?? 'b',
  mistakes: 0,
  wrongHere: 0,
  msg: '',
  done: false,
  timer: 0,
};

const engine = new Engine();
const currentBook = () => findBook(currentBookId ?? '');

// ---------- Layout ----------
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="top">
    <a class="brand" href="#/" data-goto="#/" data-nav-role="home"><span class="mark">♞</span> Rak Catur</a>
    <div class="book-title" id="book-title"></div>
    <form class="search" id="search-form" role="search">
      <input id="search" type="search" placeholder="Cari langkah (4.f4 a6) atau FEN…" aria-label="Cari" autocomplete="off" />
    </form>
    <select id="chapter" aria-label="Pilih bab" hidden></select>
    <button id="toc-open" class="toc-btn" title="Isi kandungan (t)" hidden>☰ Isi Kandungan</button>
  </header>
  <div class="toc" id="toc" hidden></div>
  <div id="view-library" hidden></div>
  <div id="view-reader" hidden>
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
          <button id="train-toggle" class="train-btn" title="Latihan: mainkan langkah buku (l)">🎯 Latihan</button>
          <button id="train-side" class="side-btn" title="Latih sebagai Putih / Hitam"></button>
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
  </div>
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
const figSpan = (p: string) => `<span class="fig">${FIG[p]}</span>`;
/** SAN atau label langkah ("12...Bxd5", "e8=Q") → HTML dengan figurine. */
const fig = (san: string) => san.replace(/[KQRBN](?=[a-h1-8x+#]|$)/g, figSpan);
// Tukar SAN dalam teks biasa (contoh tajuk "4.f4 Nf6") kepada figurine.
const figText = (s: string) => s.replace(/\b([KQRBN])(x?[a-h][1-8])/g, (_, p, r) => figSpan(p) + r);
const figPlain = (s: string) => s.replace(/\b([KQRBN])(x?[a-h][1-8])/g, (_, p, r) => FIG[p] + r); // untuk <option>
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const uid = (book: Book, ch: Chapter, key: string) => `${book.id}/${ch.id}/${key}`;
const secUid = () => {
  const b = currentBook();
  return b && chapter ? uid(b, chapter, section.key) : '';
};

/** Laluan stabil nod dalam pokok (indeks anak dari akar), contoh "0.0.0.1.0". */
function pathOf(node: MoveNode, root: Root): string {
  const idx: number[] = [];
  for (let n: MoveNode | null = node; n; n = n.parent) idx.unshift((n.parent ? n.parent.children : root.children).indexOf(n));
  return idx.join('.');
}
function nodeAt(root: Root, path: string): MoveNode | null {
  let list = root.children;
  let n: MoveNode | null = null;
  for (const i of path.split('.').map(Number)) {
    n = list[i] ?? null;
    if (!n) return null;
    list = n.children;
  }
  return n;
}
const isUserNode = (n: MoveNode) => {
  for (let x: MoveNode | null = n; x; x = x.parent) if (x.id.startsWith('u')) return true;
  return false;
};
const noteKey = (n: MoveNode) => `${secUid()}#${pathOf(n, section.root)}`;
const isMainline = (n: MoveNode) => {
  for (let x: MoveNode | null = n; x; x = x.parent) if ((x.parent ? x.parent.children : section.root.children)[0] !== x) return false;
  return true;
};

function fenOf(node: MoveNode | null) {
  return node ? node.fen : section.root.fen;
}
function childrenOf(node: MoveNode | null) {
  return node ? node.children : section.root.children;
}
const turnOf = (fen: string) => fen.split(' ')[1] as 'w' | 'b';

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
  editingNote = false;
  // Sampai hujung main line = bahagian ini dikira sudah dibaca.
  if (node && !node.children.length && isMainline(node)) markRead(secUid());
  render();
}

function nav(dir: 'start' | 'prev' | 'next' | 'end') {
  if (train.on) {
    if (dir === 'start') startTraining();
    return; // langkah lain disekat semasa latihan
  }
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
  if (train.on) return trainMove(orig, dest);
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

// ---------- Latihan ----------
function startTraining() {
  clearTimeout(train.timer);
  Object.assign(train, { on: true, mistakes: 0, wrongHere: 0, done: false, msg: '' });
  if (engineOn) toggleEngine(false);
  ground.set({ orientation: train.side === 'w' ? 'white' : 'black' });
  if (!section.root.children.length) {
    train.msg = 'Bahagian ini tiada langkah untuk dilatih.';
    train.done = true;
  }
  current = null;
  render();
  autoReply();
}

function stopTraining() {
  clearTimeout(train.timer);
  train.on = false;
  render();
}

/** Mainkan langkah pihak lawan secara automatik, atau tamatkan latihan di hujung main line. */
function autoReply() {
  if (!train.on || train.done) return;
  const next = childrenOf(current)[0];
  if (!next) return finishTraining();
  if (turnOf(fenOf(current)) === train.side) return;
  train.timer = window.setTimeout(() => {
    current = next;
    render();
    autoReply();
  }, 450);
}

function trainMove(orig: Key, dest: Key) {
  const expected = childrenOf(current)[0];
  if (!expected || train.done) return render();
  if (expected.uci[0] === orig && expected.uci[1] === dest) {
    train.wrongHere = 0;
    train.msg = `✓ ${moveLabel(expected)}`;
    current = expected;
    render();
    return autoReply();
  }
  if (childrenOf(current).some((c) => c.uci[0] === orig && c.uci[1] === dest)) {
    train.msg = 'Itu variation dalam buku. Cari langkah main line.';
    return render();
  }
  train.mistakes++;
  train.wrongHere++;
  if (train.wrongHere >= 2) {
    train.msg = `✗ Jawapan: ${moveLabel(expected)}`;
    train.wrongHere = 0;
    render();
    ground.setAutoShapes([{ orig: expected.uci[0] as Key, dest: expected.uci[1] as Key, brush: 'red' }]);
    train.timer = window.setTimeout(() => {
      current = expected;
      render();
      autoReply();
    }, 1100);
    return;
  }
  train.msg = '✗ Bukan langkah buku. Cuba lagi.';
  render();
}

function finishTraining() {
  train.done = true;
  const card = review(secUid(), train.mistakes);
  markRead(secUid());
  train.msg = `Selesai! ${train.mistakes} kesilapan. Ulang kaji seterusnya dalam ${card.interval} hari.`;
  render();
}

// ---------- Views ----------
function showReader() {
  currentBookId ??= books[0]?.id ?? null;
  const b = currentBook();
  $('book-title').innerHTML = b ? `<em>${esc(b.title)}</em> <span class="muted">— ${esc(b.author)}</span>` : '';
  $('chapter').hidden = false;
  $('toc-open').hidden = false;
  $('view-library').hidden = true;
  $('view-reader').hidden = false;
}

function showLibrary() {
  currentBookId = null;
  chapter = null;
  sections = [];
  $('book-title').innerHTML = '';
  $('chapter').hidden = true;
  $('toc-open').hidden = true;
  $('view-library').hidden = false;
  $('view-reader').hidden = true;
  renderLibrary();
  setHash({ bookId: null });
}

function bookProgressHtml(b: Book) {
  const total = b.chapters.length;
  const read = b.chapters.filter((ch) => isRead(uid(b, ch, 'intro'))).length;
  return `${read}/${total} bab dibaca`;
}

function libraryContinueHtml() {
  const r = loadLastRoute();
  if (!r?.bookId) return '';
  const b = findBook(r.bookId);
  if (!b) return '';
  const ch = b.chapters.find((c) => c.id === r.chId);
  if (!ch) return '';
  const secName = r.secId && r.secId !== 'intro' ? 'Game' : 'Ringkasan bab';
  const line = r.secId && r.secId !== 'intro'
    ? `${secName} dalam Bab ${ch.number}: ${ch.title}`
    : `Bab ${ch.number}: ${ch.title}`;
  const href = sectionHref(b.id, ch.id, r.secId ?? 'intro');
  return `<a class="continue-card" href="${href}" data-goto="${href}">
    <h3>📖 Sambung membaca · ${esc(b.title)}</h3>
    <p>${esc(line)}</p>
  </a>`;
}

function bookCardHtml(b: Book) {
  const href = bookHref(b.id);
  const cover = esc(b.cover || '/covers/default.svg');
  return `<a class="book-card" href="${href}" data-goto="${href}">
    <div class="book-cover-wrap"><img class="book-cover" src="${cover}" alt="" loading="lazy"></div>
    <div class="book-meta">
      <h3>${esc(b.title)}</h3>
      <p class="muted">${esc(b.author)}${b.year ? ` · ${b.year}` : ''}</p>
      <p class="book-progress">${bookProgressHtml(b)}</p>
      ${b.description ? `<p class="book-desc">${esc(b.description)}</p>` : ''}
    </div>
  </a>`;
}

function renderLibrary() {
  $('view-library').innerHTML = `
    <section class="library">
      <h1>Perpustakaan</h1>
      ${libraryContinueHtml()}
      <div class="library-grid">${books.map(bookCardHtml).join('')}</div>
    </section>`;
}

// ---------- Render ----------
function renderChapterSelect() {
  const b = currentBook();
  const sel = $<HTMLSelectElement>('chapter');
  if (!b) return;
  sel.innerHTML = b.chapters.map((c) => `<option value="${c.id}">Bab ${c.number}: ${esc(figPlain(c.title))}</option>`).join('');
  sel.value = chapter!.id;
}

function renderSections() {
  $('sections').innerHTML = sections
    .map(
      (s) =>
        `<button class="sec ${s === section ? 'active' : ''} ${isRead(secUid()) ? 'read' : ''}" data-sec="${s.key}"><span>${s.label}</span>${
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
  const card = cardOf(secUid());
  const b = currentBook()!;
  const exportBtns =
    section.key === 'intro'
      ? `${chapter!.intro ? '<button class="mini" data-act="pgn-section">⬇ PGN ringkasan</button>' : ''}${
          chapter!.games.length ? '<button class="mini" data-act="pgn-chapter">⬇ PGN seluruh bab</button>' : ''
        }`
      : '<button class="mini" data-act="pgn-section">⬇ PGN game</button>';
  $('panel-ringkasan').innerHTML = `
    <h2>${figText(esc(section.heading))}</h2>
    <p class="meta">${esc(section.meta)}${isRead(secUid()) ? ' · <span class="read-tag">✓ dibaca</span>' : ''}${
      card ? ` · latihan: ulang ${new Date(card.due).toLocaleDateString('ms-MY')}` : ''
    }</p>
    <div class="actions">${exportBtns}</div>
    <p class="summary">${esc(section.summary)}</p>
    ${kps ? `<h3>Point penting</h3><ol class="kps">${kps}</ol>` : ''}
    ${section.key === 'intro' ? gameListHtml(b, chapter!) : ''}`;
}

/** Senarai semua game dalam bab; yang sudah diproses boleh diklik. */
function gameListHtml(book: Book, ch: Chapter) {
  const refs = ch.gameIndex ?? ch.games.map((g) => ({ number: g.number, white: g.white, black: g.black, page: g.pages[0] }));
  if (!refs.length) return '';
  const items = refs
    .map((r) => {
      const g = ch.games.find((x) => x.number === r.number);
      const read = g && isRead(uid(book, ch, g.id));
      const href = g ? sectionHref(book.id, ch.id, g.id) : '#';
      const attrs = g ? `class="gl ready ${read ? 'read' : ''}" data-goto="${href}"` : 'class="gl"';
      return `<li ${attrs}><span class="gl-num">${r.number}</span><span class="gl-name">${esc(r.white)} – ${esc(r.black)}</span><span class="gl-page">${
        read ? '✓ ' : ''
      }${r.page}</span></li>`;
    })
    .join('');
  return `<h3>Game dalam bab ini</h3><ol class="games">${items}</ol>`;
}

/** Cari label paparan untuk kunci bahagian "<book>/<ch>/<key>". */
function describeSec(sec: string) {
  const [bookId, chId, key] = sec.split('/');
  const b = findBook(bookId);
  if (!b) return null;
  const ch = b.chapters.find((c) => c.id === chId);
  if (!ch) return null;
  const g = ch.games.find((x) => x.id === key);
  return { book: b, ch, key, text: g ? `Bab ${ch.number} · Game ${g.number}: ${g.white} – ${g.black}` : `Bab ${ch.number} · Ringkasan bab` };
}

function overlay(title: string, sub: string, body: string) {
  $('toc').innerHTML = `
    <div class="toc-card" role="dialog" aria-label="${esc(title)}">
      <div class="toc-head">
        <div><h2>${title}</h2><p class="muted">${sub}</p></div>
        <button class="toc-close" id="toc-close" title="Tutup (Esc)">✕</button>
      </div>
      ${body}
    </div>`;
  $('toc').hidden = false;
}

function renderToc() {
  const b = currentBook()!;
  const rows = b.chapters
    .map((c) => {
      const total = c.gameIndex?.length ?? c.games.length;
      const avail = [uid(b, c, 'intro'), ...c.games.map((g) => uid(b, c, g.id))];
      const read = avail.filter(isRead).length;
      const status = [
        c.intro ? '<span class="badge ok">Ringkasan</span>' : '<span class="badge">Ringkasan belum</span>',
        `<span class="badge ${c.games.length ? 'ok' : ''}">${c.games.length}/${total} game</span>`,
        `<span class="badge ${read === avail.length ? 'done' : read ? 'part' : ''}">Dibaca ${read}/${avail.length}</span>`,
      ].join('');
      const href = sectionHref(b.id, c.id, 'intro');
      return `<li class="toc-ch ${c.id === chapter!.id ? 'active' : ''}">
        <button class="toc-row" data-goto="${href}">
          <span class="toc-num">${c.number}</span>
          <span class="toc-title">${figText(esc(c.title))}</span>
          <span class="toc-page">${c.pages[0]}</span>
        </button>
        <div class="toc-status">${status}</div>
      </li>`;
    })
    .join('');

  const due = dueCards()
    .map((d) => ({ ...d, info: describeSec(d.sec) }))
    .filter((d) => d.info);
  const dueHtml = due.length
    ? `<h3 class="toc-sub">🎯 Latihan hari ini (${due.length})</h3><ul class="toc-mini">${due
        .map((d) => {
          const href = sectionHref(d.info!.book.id, d.info!.ch.id, d.info!.key, undefined, true);
          return `<li><button data-goto="${href}">${esc(d.info!.text)}</button></li>`;
        })
        .join('')}</ul>`
    : '';

  const notes = allNotes();
  const notesHtml = notes.length
    ? `<h3 class="toc-sub">★ Tanda buku &amp; nota (${notes.length})</h3><ul class="toc-mini">${notes
        .slice(0, 50)
        .map((n) => {
          const [sec, path] = n.key.split('#');
          const info = describeSec(sec);
          if (!info) return '';
          const href = sectionHref(info.book.id, info.ch.id, info.key, path || undefined);
          return `<li><button data-goto="${href}">${n.bookmark ? '★ ' : ''}${fig(esc(n.label))}${
            n.note ? `<span class="muted"> — ${esc(n.note.slice(0, 80))}</span>` : ''
          }</button></li>`;
        })
        .join('')}</ul>`
    : '';

  const allSecs = b.chapters.flatMap((c) => [c.intro ? 1 : 0, c.games.length]).reduce((a, x) => a + x, 0);
  const readAll = b.chapters.flatMap((c) => [uid(b, c, 'intro'), ...c.games.map((g) => uid(b, c, g.id))]).filter(isRead).length;
  overlay(
    'Isi Kandungan',
    `<em>${esc(b.title)}</em> — ${esc(b.author)} · dibaca ${readAll}/${allSecs}`,
    `${dueHtml}${notesHtml}<h3 class="toc-sub">Bab</h3><ol class="toc-list">${rows}</ol>`,
  );
}

function showToc(on: boolean) {
  if (on) renderToc();
  else $('toc').hidden = true;
}

function runSearch(text: string, scopeBook: Book | null = currentBook()) {
  const q = parseQuery(text);
  if (!q) return;
  const results: string[] = [];
  let count = 0;
  const source = scopeBook ? [scopeBook] : books;
  for (const b of source) {
    for (const ch of b.chapters) {
      for (const s of getSections(b, ch)) {
        for (const hit of searchTree(s.root, q)) {
          if (++count > 300) break;
          const path = hit.node ? pathOf(hit.node, s.root) : '';
          // Konteks: 4 langkah terakhir sehingga nod yang ditemui
          const ctx: string[] = [];
          for (let n = hit.node; n && ctx.length < 6; n = n.parent) ctx.unshift(n.ply % 2 === 1 || ctx.length === 5 || !n.parent ? moveLabel(n) : n.san);
          if (ctx[0] && !/^\d/.test(ctx[0])) ctx[0] = moveLabel(hit.node!); // urutan bermula dengan langkah Black
          const href = sectionHref(b.id, ch.id, s.key, path || undefined);
          results.push(`<li><button data-goto="${href}">
            <span class="sr-where">${b.title === (currentBook()?.title ?? '') ? '' : esc(b.title) + ' · '}Bab ${ch.number} · ${esc(s.label)}${s.key === 'intro' ? '' : ` · ${esc(s.heading)}`}</span>
            <span class="sr-line">${ctx.length ? fig(ctx.join(' ')) : 'Posisi permulaan'} <span class="badge ${hit.mainline ? 'ok' : ''}">${
              hit.mainline ? 'main line' : 'variation'
            }</span></span></button></li>`);
        }
      }
    }
  }
  overlay(
    'Hasil carian',
    `“${esc(text)}” — ${count > 300 ? '300+' : count} padanan${q.kind === 'fen' ? ' (ikut posisi)' : ''}`,
    results.length
      ? `<ul class="toc-mini search-results">${results.join('')}</ul>`
      : `<p class="muted">Tiada padanan. Contoh: <code>4.f4 a6</code>, <code>Nf6 e5</code>, atau FEN penuh.</p>`,
  );
}

function openSection(bookId: string, chId: string, secId = 'intro', path?: string, startTrain = false) {
  const b = findBook(bookId);
  if (!b) return showLibrary();
  currentBookId = b.id;
  chapter = b.chapters.find((c) => c.id === chId) ?? b.chapters[0];
  sections = getSections(b, chapter);
  showReader();
  selectSection(secId);
  if (startTrain) return startTraining();
  if (path) {
    const n = nodeAt(section.root, path);
    if (n) {
      tab = 'langkah';
      goto(n);
    }
  }
}

function renderMoves() {
  if (train.on) {
    $('moves').innerHTML = '<p class="muted">Senarai langkah disembunyikan semasa latihan.</p>';
    return;
  }
  const line = (nodes: MoveNode[], depth: number): string => {
    // nodes = senarai main line bermula dari nodes[0]; variation ialah adik-beradik nodes[0]
    let html = '';
    let n: MoveNode | undefined = nodes[0];
    let siblings = nodes.slice(1);
    let first = true;
    while (n) {
      const white = n.ply % 2 === 1;
      const num = white ? `${Math.ceil(n.ply / 2)}.` : first ? `${Math.ceil(n.ply / 2)}…` : '';
      const user = n.id.startsWith('u');
      const nt = user ? undefined : noteOf(noteKey(n));
      html += `<span class="mv ${n === current ? 'cur' : ''} ${user ? 'user' : ''} ${nt ? (nt.bookmark ? 'marked' : 'noted') : ''}" data-node="${n.id}">${
        num ? `<i>${num}</i>` : ''
      }${fig(n.san)}</span>`;
      if (n.comment) html += `<span class="cm">${esc(n.comment)}</span>`;
      if (nt?.note) html += `<span class="cm mine">✎ ${esc(nt.note)}</span>`;
      for (const v of siblings) html += `<div class="var d${Math.min(depth + 1, 4)}">${line([v], depth + 1)}</div>`;
      first = siblings.length > 0 || !!n.comment || !!nt?.note;
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
  const turn = chess.turn() === 'w' ? 'white' : 'black';
  // Semasa latihan, hanya pihak yang dilatih boleh gerak, dan hanya pada gilirannya.
  const canMove = !train.on || (!train.done && turnOf(fen) === train.side);
  ground.set({
    fen,
    turnColor: turn,
    lastMove: current ? (current.uci as Key[]) : undefined,
    check: chess.inCheck(),
    movable: { dests: canMove ? dests(fen) : new Map(), color: turn },
  });
  drawShapes();
}

function drawShapes() {
  const shapes: { orig: Key; dest?: Key; brush: string }[] = [];
  if (!train.on) {
    if (engineOn && lastInfo?.best && lastInfo.fen === fenOf(current)) {
      shapes.push({ orig: lastInfo.best[0] as Key, dest: lastInfo.best[1] as Key, brush: 'blue' });
    }
    // Tunjuk alternatif dari buku (variation) sebagai anak panah hijau
    childrenOf(current)
      .slice(1)
      .forEach((c) => shapes.push({ orig: c.uci[0] as Key, dest: c.uci[1] as Key, brush: 'green' }));
  }
  ground.setAutoShapes(shapes);
}

function renderComment() {
  const el = $('comment');
  const parts: string[] = [];
  if (train.on) {
    const toMove = turnOf(fenOf(current)) === train.side && !train.done;
    parts.push(`<div class="train-box ${train.done ? 'done' : ''}">
      <b>🎯 Latihan — ${train.side === 'w' ? 'Putih' : 'Hitam'}</b>
      <span>${esc(train.msg || (toMove ? 'Giliran anda: mainkan langkah buku.' : 'Menunggu langkah lawan…'))}</span>
      <span class="muted">Kesilapan: ${train.mistakes}</span>
      <div class="actions">
        <button class="mini" data-act="train-restart">↺ Ulang</button>
        <button class="mini" data-act="train-stop">Keluar latihan</button>
      </div>
    </div>`);
    if (current?.comment) parts.push(`<p>${esc(current.comment)}</p>`);
    el.innerHTML = parts.join('');
    return;
  }
  const kp = section.keyPoints.find((k) => k.at && findMainline(section.root, k.at) === current);
  if (current) {
    const own = isUserNode(current);
    const nt = own ? undefined : noteOf(noteKey(current));
    parts.push(`<div class="cur-move">${fig(moveLabel(current))}${own ? ' <span class="tag">langkah anda</span>' : ''}${
      own
        ? ''
        : `<span class="note-btns">
            <button class="mini ${nt?.bookmark ? 'on' : ''}" data-act="bookmark" title="Tanda buku">${nt?.bookmark ? '★' : '☆'} Tanda</button>
            <button class="mini ${nt?.note ? 'on' : ''}" data-act="note" title="Nota peribadi">✎ Nota</button>
          </span>`
    }</div>`);
    if (!own && (editingNote || nt?.note))
      parts.push(`<textarea id="note-input" class="note-input" rows="2" placeholder="Nota anda untuk langkah ini…">${esc(nt?.note ?? '')}</textarea>`);
  }
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
  if (editingNote) $<HTMLTextAreaElement>('note-input')?.focus();
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

function renderTrainButtons() {
  const due = dueCards().length;
  $('train-toggle').classList.toggle('on', train.on);
  $('train-toggle').innerHTML = `🎯 ${train.on ? 'Keluar latihan' : 'Latihan'}${due && !train.on ? ` <span class="count">${due}</span>` : ''}`;
  $('train-side').innerHTML = train.side === 'w' ? `${figSpan('K')} Putih` : '<span class="fig">♚</span> Hitam';
  $('engine-toggle').toggleAttribute('disabled', train.on);
}

function render() {
  if (!currentBookId || !chapter) return showLibrary();
  renderBoard();
  renderMoves();
  renderSummary();
  renderComment();
  renderTabs();
  renderTrainButtons();
  if (engineOn) engine.analyse(fenOf(current));
  renderEngine();
  saveState();
}

// ---------- Persist (per pelayar) ----------
function saveState() {
  try {
    if (!currentBookId || !chapter || !section) return;
    const payload = { bookId: currentBookId, chId: chapter.id, secId: section.key };
    localStorage.setItem('rak-catur:route', JSON.stringify(payload));
    setHash(payload);
  } catch {
    /* abaikan */
  }
}

interface StoredRoute { bookId: string; chId: string; secId: string; path?: string }

function loadLastRoute(): StoredRoute | null {
  try {
    return JSON.parse(localStorage.getItem('rak-catur:route') ?? 'null');
  } catch {
    return null;
  }
}

function startupRoute(): ReturnType<typeof parseHash> {
  if (location.hash) return parseHash();
  const saved = loadLastRoute();
  if (saved?.bookId) return { ...saved, path: saved.path ?? null, train: false };
  // Migration daripada localStorage lama satu-buku.
  try {
    const legacy = JSON.parse(localStorage.getItem('rak-catur') ?? 'null');
    if (legacy?.ch && books.length) {
      return { bookId: books[0].id, chId: legacy.ch, secId: legacy.sec ?? 'intro', path: null, train: false };
    }
  } catch { /* abaikan */ }
  firstVisit = true;
  return { bookId: null, chId: null, secId: null, path: null, train: false };
}

function applyRoute(route = parseHash()) {
  if (!route.bookId) return showLibrary();
  openSection(route.bookId, route.chId ?? 'ch1', route.secId ?? 'intro', route.path ?? undefined, route.train);
}

function selectSection(key: string) {
  clearTimeout(train.timer);
  train.on = false;
  section = sections.find((s) => s.key === key) ?? sections[0];
  current = null;
  lastInfo = null;
  editingNote = false;
  // Ringkasan bab tanpa langkah dikira dibaca bila dibuka.
  if (section.key === 'intro' && !section.root.children.length) markRead(secUid());
  renderSections();
  render();
}

function toggleEngine(on: boolean) {
  engineOn = on;
  $<HTMLInputElement>('engine-toggle').checked = on;
  if (!on) engine.stop();
}

// ---------- Events ----------
engine.onInfo = (info) => {
  if (info.fen !== fenOf(current)) return;
  lastInfo = info;
  renderEngine();
  drawShapes();
};

function act(name: string) {
  const b = currentBook();
  if (!b || !chapter) return;
  switch (name) {
    case 'pgn-section': {
      const g = chapter.games.find((x) => x.id === section.key);
      const text = g ? gamePgn(b, chapter, g) : introPgn(b, chapter);
      return download(`${b.id}-${g ? `game-${g.number}` : `bab-${chapter.number}-ringkasan`}.pgn`, text);
    }
    case 'pgn-chapter':
      return download(`${b.id}-bab-${chapter.number}.pgn`, chapterPgn(b, chapter));
    case 'bookmark': {
      if (!current) return;
      const nt = noteOf(noteKey(current));
      setNote(noteKey(current), `Bab ${chapter.number} · ${section.label} · ${moveLabel(current)}`, { bookmark: !nt?.bookmark });
      return render();
    }
    case 'note':
      editingNote = true;
      return renderComment();
    case 'train-restart':
      return startTraining();
    case 'train-stop':
      return stopTraining();
  }
}

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const actEl = t.closest<HTMLElement>('[data-act]');
  if (actEl) return act(actEl.dataset.act!);
  const gotoEl = t.closest<HTMLElement>('[data-goto]');
  if (gotoEl) {
    e.preventDefault();
    const route = parseHash(gotoEl.dataset.goto!);
    if (!route.bookId) return showLibrary();
    return openSection(route.bookId, route.chId ?? 'ch1', route.secId ?? 'intro', route.path ?? undefined, route.train || !!gotoEl.dataset.train);
  }
  const nodeEl = t.closest<HTMLElement>('[data-node]');
  if (nodeEl) {
    if (train.on) return;
    const n = findNode(nodeEl.dataset.node!);
    if (n) goto(n);
    return;
  }
  const navEl = t.closest<HTMLElement>('[data-nav]');
  if (navEl) return nav(navEl.dataset.nav as 'start');
  if (t.closest('#toc-open')) return showToc(true);
  if (t.closest('#toc-close') || t.id === 'toc') return showToc(false);
  if (t.closest('#train-toggle')) return train.on ? stopTraining() : startTraining();
  if (t.closest('#train-side')) {
    train.side = train.side === 'w' ? 'b' : 'w';
    localStorage.setItem('rak-catur:side', train.side);
    return train.on ? startTraining() : renderTrainButtons();
  }
  const secEl = t.closest<HTMLElement>('[data-sec]');
  if (secEl) return selectSection(secEl.dataset.sec!);
  const tabEl = t.closest<HTMLElement>('[data-tab]');
  if (tabEl) {
    tab = tabEl.dataset.tab as typeof tab;
    renderTabs();
  }
});

// Nota disimpan semasa menaip; senarai langkah dikemas kini bila kotak ditinggalkan.
document.addEventListener('input', (e) => {
  const t = e.target as HTMLElement;
  if (t.id !== 'note-input' || !current) return;
  setNote(noteKey(current), `Bab ${chapter!.number} · ${section.label} · ${moveLabel(current)}`, { note: (t as HTMLTextAreaElement).value });
});
document.addEventListener('focusout', (e) => {
  if ((e.target as HTMLElement).id !== 'note-input') return;
  editingNote = false;
  renderMoves();
});

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch($<HTMLInputElement>('search').value);
});

$('flip').addEventListener('click', () => ground.toggleOrientation());
$<HTMLInputElement>('engine-toggle').addEventListener('change', (e) => {
  toggleEngine((e.target as HTMLInputElement).checked);
  render();
});
$<HTMLSelectElement>('chapter').addEventListener('change', (e) => {
  const b = currentBook();
  if (!b) return;
  chapter = b.chapters.find((c) => c.id === (e.target as HTMLSelectElement).value)!;
  sections = getSections(b, chapter);
  selectSection(sections[0].key);
});

document.addEventListener('keydown', (e) => {
  if (!currentBookId) return; // pintasan pembaca tak aktif di perpustakaan
  if ((e.target as HTMLElement).matches('input, select, textarea')) {
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
    return;
  }
  if (e.key === 'Escape' && !$('toc').hidden) return showToc(false);
  if (e.key === 't') return showToc($('toc').hidden === true);
  if (e.key === '/') {
    e.preventDefault();
    return $('search').focus();
  }
  if (e.key === 'l') return train.on ? stopTraining() : startTraining();
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

window.addEventListener('hashchange', () => applyRoute(parseHash()));

// ---------- Boot ----------
const bootRoute = startupRoute();
applyRoute(bootRoute);
if (firstVisit && currentBookId) showToc(true);
