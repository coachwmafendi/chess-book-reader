// Eksport PGN (untuk ChessBase / Lichess Study) dari data buku.
import { START_FEN } from './lib/tree';
import type { Book, Chapter, Game } from './types';

const tag = (k: string, v: string | number) => `[${k} "${String(v).replace(/"/g, "'")}"]`;

function block(tags: [string, string | number | undefined][], fen: string, movetext: string, result: string) {
  const lines = tags.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => tag(k, v!));
  if (fen !== START_FEN) lines.push(tag('FEN', fen), tag('SetUp', '1'));
  return `${lines.join('\n')}\n\n${movetext.trim()} ${result}\n`;
}

export function gamePgn(book: Book, ch: Chapter, g: Game) {
  return block(
    [
      ['Event', g.event ?? '?'],
      ['Site', '?'],
      ['Date', g.year ? `${g.year}.??.??` : '????.??.??'],
      ['Round', '?'],
      ['White', g.white],
      ['Black', g.black],
      ['Result', g.result],
      ['Annotator', book.author],
      ['Source', `${book.title}, Bab ${ch.number}: ${ch.title}, Game ${g.number}`],
    ],
    g.startFen ?? START_FEN,
    `{ ${g.summary.replace(/[{}]/g, '')} } ${g.pgn}`,
    g.result,
  );
}

export function introPgn(book: Book, ch: Chapter) {
  if (!ch.intro) return '';
  const summary = [ch.intro.summary, ...ch.intro.keyPoints.map((k, i) => `${i + 1}. ${k}`)].join(' ').replace(/[{}]/g, '');
  return block(
    [
      ['Event', `${book.title} — Bab ${ch.number}: ${ch.title}`],
      ['White', 'Ringkasan bab'],
      ['Black', ''],
      ['Result', '*'],
      ['Annotator', book.author],
    ],
    ch.intro.startFen,
    `{ ${summary} } ${ch.intro.pgn}`,
    '*',
  );
}

export const chapterPgn = (book: Book, ch: Chapter) =>
  [introPgn(book, ch), ...ch.games.map((g) => gamePgn(book, ch, g))].filter(Boolean).join('\n');

export function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-chess-pgn' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
