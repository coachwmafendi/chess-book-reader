// Carian dalam pokok langkah: ikut FEN (posisi) atau ikut urutan langkah seperti "4.f4 a6" atau "Nf6 e5".
import type { MoveNode, Root } from './lib/tree';

export type Query =
  | { kind: 'fen'; key: string }
  | { kind: 'moves'; sans: string[]; startPly?: number };

const FIG_TO_LETTER: Record<string, string> = { '♔': 'K', '♕': 'Q', '♖': 'R', '♗': 'B', '♘': 'N', '♚': 'K', '♛': 'Q', '♜': 'R', '♝': 'B', '♞': 'N' };

/** Kunci posisi: susunan buah + giliran (abaikan castling/en passant/kiraan langkah). */
export const fenKey = (fen: string) => fen.split(' ').slice(0, 2).join(' ');

const normSan = (s: string) =>
  s
    .replace(/[♔♕♖♗♘♚♛♜♝♞]/g, (c) => FIG_TO_LETTER[c])
    .replace(/0-0-0/g, 'O-O-O')
    .replace(/0-0/g, 'O-O')
    .replace(/[+#!?]/g, '');

export function parseQuery(q: string): Query | null {
  const text = q.trim();
  if (!text) return null;
  if (text.includes('/')) return { kind: 'fen', key: fenKey(text) };
  let startPly: number | undefined;
  const sans: string[] = [];
  for (const tok of text.split(/\s+/)) {
    // "4.f4", "4...a6", "4…a6", "4." atau "f4"
    const m = tok.match(/^(\d+)(\.{3}|…|\.)?(.*)$/);
    let san = tok;
    if (m) {
      if (sans.length === 0 && startPly === undefined) {
        const n = Number(m[1]);
        startPly = m[2] === '...' || m[2] === '…' ? n * 2 : n * 2 - 1;
      }
      san = m[3];
    }
    if (san) sans.push(normSan(san));
  }
  return sans.length ? { kind: 'moves', sans, startPly } : null;
}

/** Pulangkan semua nod yang sepadan. Untuk carian langkah, nod = langkah terakhir dalam urutan. */
export function searchTree(root: Root, q: Query): { node: MoveNode | null; mainline: boolean }[] {
  const out: { node: MoveNode | null; mainline: boolean }[] = [];
  if (q.kind === 'fen' && fenKey(root.fen) === q.key) out.push({ node: null, mainline: true });
  const walk = (nodes: MoveNode[], mainline: boolean) =>
    nodes.forEach((n, i) => {
      const ml = mainline && i === 0;
      if (matches(n, q)) out.push({ node: n, mainline: ml });
      walk(n.children, ml);
    });
  walk(root.children, true);
  return out;
}

function matches(node: MoveNode, q: Query) {
  if (q.kind === 'fen') return fenKey(node.fen) === q.key;
  let n: MoveNode | null = node;
  for (let i = q.sans.length - 1; i >= 0; i--) {
    if (!n || normSan(n.san) !== q.sans[i]) return false;
    if (i === 0 && q.startPly !== undefined && n.ply !== q.startPly) return false;
    n = n.parent;
  }
  return true;
}
