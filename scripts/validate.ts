// Semak setiap PGN dalam fail buku: semua langkah sah, dan semua keyPoint menunjuk ke langkah main line yang wujud.
// Guna: npx tsx scripts/validate.ts data/modern-tiger.json
import { readFileSync } from 'node:fs';
import { buildTree, countNodes, findMainline, START_FEN } from '../src/lib/tree';
import type { Book } from '../src/types';

let failed = 0;
for (const file of process.argv.slice(2)) {
  const book: Book = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`\n📖 ${book.title}`);
  for (const ch of book.chapters) {
    const sections = [
      { name: `Bab ${ch.number} (pengenalan)`, pgn: ch.intro.pgn, fen: ch.intro.startFen, kps: [] as { at: string }[] },
      ...ch.games.map((g) => ({ name: `Game ${g.number}: ${g.white} – ${g.black}`, pgn: g.pgn, fen: g.startFen ?? START_FEN, kps: g.keyPoints })),
    ];
    for (const s of sections) {
      const { root, errors } = buildTree(s.pgn, s.fen);
      const kpMissing = s.kps.filter((k) => !findMainline(root, k.at));
      const ok = errors.length === 0 && kpMissing.length === 0;
      console.log(`  ${ok ? '✅' : '❌'} ${s.name} — ${countNodes(root)} langkah`);
      for (const e of errors) console.log(`     ✗ ${e.path}: ${e.message}\n       FEN: ${e.fen}`);
      for (const k of kpMissing) console.log(`     ✗ keyPoint "${k.at}" tiada dalam main line`);
      if (!ok) failed++;
    }
  }
}
if (failed) {
  console.log(`\n${failed} bahagian gagal.`);
  process.exit(1);
}
console.log('\nSemua sah.');
