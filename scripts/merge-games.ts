// Gabungkan fail game individu (contoh hasil ingest manual oleh Claude Code) ke dalam data/<book>.json.
// Fail: <dir>/**/g<nombor>.json dengan medan Game tanpa id/number/pages (diambil dari gameIndex).
// Guna: npx tsx scripts/merge-games.ts modern-tiger .ingest/cc [--force]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTree, findMainline, START_FEN } from '../src/lib/tree';
import type { Book, Game } from '../src/types';

const [bookId, dir] = process.argv.slice(2);
const force = process.argv.includes('--force');
const out = `data/${bookId}.json`;
const book: Book = JSON.parse(readFileSync(out, 'utf8'));

const files: string[] = [];
const walk = (d: string) =>
  readdirSync(d).forEach((f) => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/^g\d+\.json$/.test(f)) files.push(p);
  });
walk(dir);

let added = 0;
let skipped = 0;
let rejected = 0;
for (const file of files.sort()) {
  const number = Number(file.match(/g(\d+)\.json$/)![1]);
  const ch = book.chapters.find((c) => c.gameIndex?.some((r) => r.number === number));
  if (!ch) {
    console.log(`✗ ${file}: Game ${number} tiada dalam gameIndex`);
    rejected++;
    continue;
  }
  if (ch.games.some((g) => g.number === number) && !force) {
    skipped++;
    continue;
  }
  const g = JSON.parse(readFileSync(file, 'utf8')) as Omit<Game, 'id' | 'number' | 'pages'>;
  const { root, errors } = buildTree(g.pgn, g.startFen ?? START_FEN);
  const badKp = g.keyPoints.filter((k) => !findMainline(root, k.at));
  if (errors.length || badKp.length || g.result === '*') {
    console.log(`✗ ${file}: ${errors.length} ralat, ${badKp.length} keyPoint salah, result ${g.result} — tidak digabung`);
    rejected++;
    continue;
  }
  const refs = ch.gameIndex!;
  const i = refs.findIndex((r) => r.number === number);
  const pages: [number, number] = [refs[i].page, refs[i + 1]?.page ?? ch.pages[1]];
  ch.games = [...ch.games.filter((x) => x.number !== number), { id: `${ch.id}-g${number}`, number, pages, ...g }].sort(
    (a, b) => a.number - b.number,
  );
  added++;
}
writeFileSync(out, JSON.stringify(book, null, 2) + '\n');
console.log(`✅ ${added} digabung, ${skipped} sudah ada (dilangkau), ${rejected} ditolak. Jalankan "npm run validate".`);
