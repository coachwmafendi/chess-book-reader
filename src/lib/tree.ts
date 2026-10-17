// Tukar PGN (dengan variation & komen) kepada pokok move yang sudah divalidate oleh chess.js.
// Digunakan oleh reader (browser) dan skrip validate/ingest (Node).
import { Chess } from 'chess.js';
import { parse } from '@mliebelt/pgn-parser';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface MoveNode {
  id: string;
  ply: number; // 1 = langkah pertama White
  san: string;
  uci: [string, string];
  fen: string; // posisi SELEPAS langkah ini
  comment?: string;
  parent: MoveNode | null;
  children: MoveNode[]; // children[0] = main line, selebihnya = variation
}

export interface Root {
  fen: string;
  comment?: string;
  children: MoveNode[];
}

export interface ValidationError {
  path: string; // contoh: "14...Nxd3 (var dari 13.b4)"
  san: string;
  fen: string;
  message: string;
}

interface PMove {
  notation: { notation: string };
  commentAfter?: string;
  variations: PMove[][];
  turn: 'w' | 'b';
}

let counter = 0;

function label(ply: number, san: string) {
  const n = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${n}.${san}` : `${n}...${san}`;
}

export function moveLabel(node: MoveNode) {
  return label(node.ply, node.san);
}

function plyFromFen(fen: string) {
  const [, turn, , , , full] = fen.split(' ');
  return (Number(full) - 1) * 2 + (turn === 'w' ? 0 : 1);
}

export function buildTree(pgn: string, startFen = START_FEN): { root: Root; errors: ValidationError[] } {
  const header = startFen === START_FEN ? '' : `[FEN "${startFen}"]\n[SetUp "1"]\n\n`;
  const game = parse(header + pgn, { startRule: 'game' }) as unknown as {
    moves: PMove[];
    gameComment?: { comment?: string };
  };
  const errors: ValidationError[] = [];
  const root: Root = { fen: startFen, comment: game.gameComment?.comment?.trim(), children: [] };

  // Tambah satu siri move bermula dari posisi `fen` di bawah `parent`.
  function addLine(moves: PMove[], fen: string, parent: MoveNode | null, attach: MoveNode[], context: string) {
    let curFen = fen;
    let curParent = parent;
    let curAttach = attach;
    for (const m of moves) {
      const san = m.notation.notation;
      const ply = plyFromFen(curFen) + 1;
      // Variation untuk move ini bermula dari posisi SEBELUM move ini.
      const before = curFen;
      const beforeParent = curParent;
      const beforeAttach = curAttach;

      const chess = new Chess(curFen);
      let res;
      try {
        res = chess.move(san);
      } catch {
        res = null;
      }
      if (!res) {
        errors.push({ path: `${label(ply, san)}${context}`, san, fen: curFen, message: 'Langkah tidak sah' });
        return; // hentikan line ini — langkah selepasnya tak boleh dipercayai
      }
      const node: MoveNode = {
        id: `n${++counter}`,
        ply,
        san: res.san,
        uci: [res.from, res.to],
        fen: chess.fen(),
        comment: m.commentAfter?.trim() || undefined,
        parent: curParent,
        children: [],
      };
      curAttach.push(node);

      for (const v of m.variations ?? []) {
        addLine(v, before, beforeParent, beforeAttach, ` (var. dari ${label(ply, san)})`);
      }

      curFen = node.fen;
      curParent = node;
      curAttach = node.children;
    }
  }

  addLine(game.moves, startFen, null, root.children, '');
  return { root, errors };
}

/** Cari node main line ikut label seperti "12...Bxd5" atau "10.Nd5". */
export function findMainline(root: Root, at: string): MoveNode | undefined {
  const clean = (s: string) => s.replace(/[+#!?]/g, '').replace(/\s/g, '');
  let node = root.children[0];
  while (node) {
    if (clean(moveLabel(node)) === clean(at)) return node;
    node = node.children[0];
  }
  return undefined;
}

export function countNodes(root: Root) {
  let n = 0;
  const walk = (xs: MoveNode[]) => xs.forEach((x) => (n++, walk(x.children)));
  walk(root.children);
  return n;
}
