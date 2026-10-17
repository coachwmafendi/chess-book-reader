// Ingest buku catur PDF → data/<id>.json, menggunakan Claude (vision) + validasi chess.js.
//
// Langkah 1 — imbas: cari di halaman mana setiap game bermula.
//   npm run ingest -- scan --pdf buku.pdf --from 10 --to 98
// Langkah 2 — extract: proses satu bab (pengenalan + semua game) mengikut peta dari langkah 1.
//   npm run ingest -- chapter --pdf buku.pdf --book modern-tiger --chapter 1 --title "4.f4 – Austrian Style"
//
// Game sahaja, ikut gameIndex dalam data/<id>.json (selari, boleh sambung semula; game sedia ada dilangkau):
//   npm run ingest -- games --pdf buku.pdf --book modern-tiger [--chapter 3] [--concurrency 4]
//
// Ringkasan bab sahaja (pengenalan setiap bab, guna pages + gameIndex dalam data/<id>.json, halaman tercetak):
//   npm run ingest -- intro --pdf buku.pdf --book modern-tiger [--chapter 3] [--force]
//
// Provider LLM: INGEST_PROVIDER=anthropic (default) atau google.
// Anthropic perlu ANTHROPIC_API_KEY / CLAUDE_MODEL. Google perlu GOOGLE_API_KEY / GOOGLE_MODEL.
// Nombor halaman = nombor halaman PDF (bukan nombor yang tercetak dalam buku).

import * as mupdf from 'mupdf';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildTree, findMainline, START_FEN } from '../src/lib/tree';
import type { Book, Chapter, ChapterIntro, Game } from '../src/types';
import { getProvider, type Tool } from './llm';

const provider = getProvider();

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    pdf: { type: 'string' },
    book: { type: 'string', default: 'book' },
    title: { type: 'string' },
    author: { type: 'string' },
    chapter: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    scale: { type: 'string', default: '2' },
    force: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
  },
});

const cmd = positionals[0];
const work = `.ingest/${args.book}`;
mkdirSync(work, { recursive: true });

// ---------- Render halaman (dengan cache) ----------
// MuPDF dipilih kerana banyak buku scan simpan diagram sebagai JBIG2 — pdf.js gagal decode format ini.
let doc: mupdf.Document | null = null;
async function page(n: number, scale = Number(args.scale)): Promise<string> {
  const file = `${work}/p${n}@${scale}.png`;
  if (existsSync(file)) return readFileSync(file).toString('base64');
  doc ??= mupdf.Document.openDocument(readFileSync(args.pdf!), 'application/pdf');
  const pix = doc.loadPage(n - 1).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, true);
  const buf = Buffer.from(pix.asPNG());
  writeFileSync(file, buf);
  return buf.toString('base64');
}

// ---------- Prompt ----------
const SYSTEM = `Anda membaca halaman buku catur yang diimbas (biasanya dua kolum, notation figurine, diagram papan).
Tugas anda: tukar kandungan kepada PGN yang TEPAT.

Peraturan PGN:
- Tukar figurine kepada huruf Inggeris: ♔=K ♕=Q ♖=R ♗=B ♘=N. Castling ditulis O-O / O-O-O.
- Main line ialah langkah tebal (bold) dalam teks. Analisis dalam perenggan biasa ialah variation: letak dalam ( ).
- Variation menggantikan langkah yang ia ikut: "13.b4" sebagai alternatif kepada 13.O-O ditulis "13. O-O ( 13. b4 ... ) 13... Rxd8".
- Buang simbol penilaian (!, ?, !?, ±, +-, N) daripada SAN; sebut maknanya dalam komen jika penting.
- Komen dalam { } — RINGKAS (1–2 ayat), dalam Bahasa Melayu, diparafrasa dengan kata-kata anda sendiri. Jangan salin ayat buku.
- Jika teks merujuk kepada posisi dari langkah sebelumnya (contoh "Black is fine after 11.Bxf5 Bb7"), sambungkan variation pada langkah yang betul.
- Gunakan diagram untuk menyemak posisi. Jika teks dan diagram bercanggah, ikut diagram.

Ringkasan & point penting: Bahasa Melayu, gaya pemain kelab, fokus pada IDEA dan PELAN, bukan senarai langkah.
Istilah catur (pawn, knight, bishop, rook, queen, king, castling, endgame) boleh kekal dalam Bahasa Inggeris.`;

const gameTool: Tool = {
  name: 'save_game',
  description: 'Simpan satu game yang diextract',
  input_schema: {
    type: 'object',
    required: ['white', 'black', 'result', 'summary', 'keyPoints', 'pgn'],
    properties: {
      white: { type: 'string' },
      black: { type: 'string' },
      event: { type: 'string' },
      year: { type: 'integer' },
      result: { type: 'string', enum: ['1-0', '0-1', '1/2-1/2', '*'] },
      startFen: { type: 'string', description: 'Hanya jika game tidak bermula dari posisi awal' },
      summary: { type: 'string', description: '2–4 ayat' },
      keyPoints: {
        type: 'array',
        description: '4–8 point. "at" mesti label langkah MAIN LINE yang wujud, contoh "12...Bxd5" atau "10.Nd5".',
        items: { type: 'object', required: ['at', 'text'], properties: { at: { type: 'string' }, text: { type: 'string' } } },
      },
      pgn: { type: 'string', description: 'Movetext sahaja (tanpa tag header), dengan variation dan komen' },
    },
  },
};

const introTool: Tool = {
  name: 'save_intro',
  description: 'Simpan pengenalan bab',
  input_schema: {
    type: 'object',
    required: ['startFen', 'summary', 'keyPoints', 'pgn'],
    properties: {
      startFen: { type: 'string', description: 'FEN posisi asas bab (contoh selepas 1.e4 g6 2.d4 Bg7 3.Nc3 d6 4.f4)' },
      summary: { type: 'string' },
      keyPoints: { type: 'array', items: { type: 'string' } },
      pgn: { type: 'string', description: 'Langkah-langkah utama yang dibincangkan, bermula dari startFen' },
    },
  },
};

const scanTool: Tool = {
  name: 'save_map',
  description: 'Senarai game yang bermula dalam halaman ini',
  input_schema: {
    type: 'object',
    required: ['games'],
    properties: {
      games: {
        type: 'array',
        items: {
          type: 'object',
          required: ['number', 'page', 'white', 'black'],
          properties: { number: { type: 'integer' }, page: { type: 'integer' }, white: { type: 'string' }, black: { type: 'string' } },
        },
      },
    },
  },
};

// ---------- Extract + baiki ----------
/** buildTree, tetapi ralat sintaks PGN (contoh kurungan tidak seimbang) dilaporkan sebagai ralat untuk dibaiki. */
function safeBuild(pgn: string, fen: string): ReturnType<typeof buildTree> {
  try {
    return buildTree(pgn, fen);
  } catch (e) {
    const root = buildTree('', fen).root;
    return { root, errors: [{ path: 'PGN', san: '', fen, message: `sintaks PGN rosak: ${(e as Error).message}` }] };
  }
}
async function extractWithRepair<T extends { pgn: string; startFen?: string; keyPoints?: unknown[] }>(
  pages: number[],
  instruction: string,
  tool: Tool,
  defaultFen = START_FEN,
  tag = '',
): Promise<T> {
  const images = await Promise.all(pages.map((p) => page(p)));
  const content = [
    ...images.flatMap((d, i) => [{ type: 'text' as const, text: `Halaman PDF ${pages[i]}:` }, { type: 'image' as const, data: d }]),
    { type: 'text' as const, text: instruction },
  ];

  let result = await provider.complete<T>(SYSTEM, content, tool);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { root, errors } = safeBuild(result.pgn, result.startFen ?? defaultFen);
    // keyPoints intro ialah string biasa (tiada `at`) — hanya semak objek { at, text } dari game.
    const badKps = ((result.keyPoints ?? []) as unknown[]).filter(
      (k): k is { at: string } => typeof k === 'object' && k !== null && typeof (k as { at?: unknown }).at === 'string' && !findMainline(root, (k as { at: string }).at),
    );
    // Game tanpa keputusan biasanya bermaksud main line terpotong sebelum langkah terakhir.
    const unfinished = (result as { result?: string }).result === '*';
    if (!errors.length && !badKps.length && !unfinished) return result;

    const report = [
      ...errors.map((e) => (e.path === 'PGN' ? `- ${e.message}. Semak ( ) dan { } seimbang.` : `- ${e.path}: tidak sah dalam posisi ${e.fen}`)),
      ...badKps.map((k) => `- keyPoint "${k.at}" tiada dalam main line`),
      ...(unfinished ? ['- result "*": main line mungkin terpotong. Teruskan hingga langkah terakhir game dan isi result (1-0, 0-1, 1/2-1/2).'] : []),
    ].join('\n');
    console.log(`   ${tag}⚠ cubaan ${attempt}: ${errors.length} langkah tidak sah, ${badKps.length} keyPoint salah — minta pembetulan`);
    result = await provider.complete<T>(
      SYSTEM,
      [
        ...content,
        { type: 'text' as const, text: `Hasil sebelum ini:\n${JSON.stringify(result)}\n\nMasalah yang dikesan oleh chess.js:\n${report}\n\nBaca semula halaman yang berkaitan dan pulangkan versi yang dibetulkan sepenuhnya.` },
      ],
      tool,
    );
  }
  const { errors } = safeBuild(result.pgn, result.startFen ?? defaultFen);
  if (errors.length) console.log(`   ${tag}✗ masih ada ${errors.length} ralat — line itu akan dipotong dalam reader. Semak manual.`);
  return result;
}

// ---------- Commands ----------
async function scan() {
  const from = Number(args.from), to = Number(args.to);
  const found: { number: number; page: number; white: string; black: string }[] = [];
  for (let s = from; s <= to; s += 10) {
    const pages = Array.from({ length: Math.min(10, to - s + 1) }, (_, i) => s + i);
    console.log(`🔎 imbas halaman ${pages[0]}–${pages.at(-1)}`);
    const imgs = await Promise.all(pages.map((p) => page(p, 0.8)));
    const res = await provider.complete<{ games: typeof found }>(
      'Anda mengenal pasti tajuk game dalam buku catur.',
      [
        ...imgs.flatMap((d, i) => [{ type: 'text' as const, text: `Halaman PDF ${pages[i]}:` }, { type: 'image' as const, data: d }]),
        { type: 'text' as const, text: 'Senaraikan setiap tajuk "GAME N" yang muncul, dengan nombor halaman PDF dan nama pemain.' },
      ],
      scanTool,
    );
    found.push(...res.games);
  }
  const map = { from, to, games: found.sort((a, b) => a.page - b.page) };
  writeFileSync(`${work}/map.json`, JSON.stringify(map, null, 2));
  console.log(`✅ ${found.length} game ditemui → ${work}/map.json (semak & betulkan jika perlu)`);
}

async function chapter() {
  const map = JSON.parse(readFileSync(`${work}/map.json`, 'utf8')) as {
    from: number;
    to: number;
    games: { number: number; page: number; white: string; black: string }[];
  };
  const out = `data/${args.book}.json`;
  const book: Book = existsSync(out)
    ? JSON.parse(readFileSync(out, 'utf8'))
    : { id: args.book!, title: args.title ?? args.book!, author: args.author ?? '', chapters: [] };

  const n = Number(args.chapter);
  const offset = book.source?.pageOffset ?? 0;
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  console.log(`📘 Bab ${n}: pengenalan (hlm ${map.from}–${map.games[0].page})`);
  const intro = await extractWithRepair<ChapterIntro>(
    range(map.from, map.games[0].page),
    'Extract PENGENALAN bab sahaja (abaikan game yang bermula di halaman terakhir). Beri ringkasan bab, 4–6 point penting tentang pelan/idea, dan PGN langkah-langkah utama.',
    introTool,
  );

  const games: Game[] = [];
  for (const [i, g] of map.games.entries()) {
    const end = map.games[i + 1]?.page ?? map.to;
    console.log(`♟  Game ${g.number}: ${g.white} – ${g.black} (hlm ${g.page}–${end})`);
    const r = await extractWithRepair<Omit<Game, 'id' | 'number' | 'pages'>>(
      range(g.page, end),
      `Extract Game ${g.number} (${g.white} – ${g.black}) SAHAJA — mula dari tajuk game itu, berhenti sebelum game seterusnya.`,
      gameTool,
    );
    games.push({ id: `ch${n}-g${g.number}`, number: g.number, pages: [g.page - offset, end - offset], ...r });
  }

  // Data simpan halaman tercetak; kekalkan tajuk/halaman/gameIndex sedia ada (dari isi kandungan).
  const prev = book.chapters.find((c) => c.number === n);
  const ch: Chapter = {
    id: `ch${n}`,
    number: n,
    title: args.title ?? prev?.title ?? `Bab ${n}`,
    pages: prev?.pages ?? [map.from - offset, map.to - offset],
    intro,
    games,
    ...(prev?.gameIndex && { gameIndex: prev.gameIndex }),
  };
  book.chapters = [...book.chapters.filter((c) => c.number !== n), ch].sort((a, b) => a.number - b.number);
  writeFileSync(out, JSON.stringify(book, null, 2));
  console.log(`✅ Disimpan ke ${out}. Jalankan "npm run validate" untuk semakan akhir.`);
}

async function intros() {
  const out = `data/${args.book}.json`;
  const book: Book = JSON.parse(readFileSync(out, 'utf8'));
  const offset = book.source?.pageOffset ?? 0;
  const only = args.chapter ? Number(args.chapter) : null;
  for (const ch of book.chapters) {
    if (only !== null && ch.number !== only) continue;
    if (ch.intro && !args.force) {
      console.log(`⏭  Bab ${ch.number}: ringkasan sudah ada (guna --force untuk ganti)`);
      continue;
    }
    // Pengenalan = dari halaman pertama bab hingga halaman game pertama (game itu sendiri diabaikan).
    const first = ch.gameIndex?.[0]?.page ?? Math.min(ch.pages[0] + 5, ch.pages[1]);
    const pdfPages = Array.from({ length: first - ch.pages[0] + 1 }, (_, i) => ch.pages[0] + i + offset);
    console.log(`📘 Bab ${ch.number}: ${ch.title} (hlm ${ch.pages[0]}–${first}, PDF ${pdfPages[0]}–${pdfPages.at(-1)})`);
    ch.intro = await extractWithRepair<ChapterIntro>(
      pdfPages,
      `Ini Bab ${ch.number} "${ch.title}". Extract PENGENALAN bab sahaja (abaikan game yang bermula di halaman terakhir). ` +
        'Beri ringkasan bab 3–5 ayat (variation apa, idea utama kedua-dua pihak, pendapat penulis), 4–6 point penting tentang pelan/idea, ' +
        'dan PGN langkah-langkah utama yang dibincangkan bermula dari startFen.',
      introTool,
    );
    writeFileSync(out, JSON.stringify(book, null, 2) + '\n'); // simpan selepas setiap bab
  }
  console.log(`✅ Disimpan ke ${out}. Jalankan "npm run validate".`);
}

async function games() {
  const out = `data/${args.book}.json`;
  const book: Book = JSON.parse(readFileSync(out, 'utf8'));
  const offset = book.source?.pageOffset ?? 0;
  const only = args.chapter ? Number(args.chapter) : null;

  const jobs: { ch: Chapter; ref: NonNullable<Chapter['gameIndex']>[number]; end: number }[] = [];
  for (const ch of book.chapters) {
    if (only !== null && ch.number !== only) continue;
    const refs = ch.gameIndex ?? [];
    refs.forEach((ref, i) => {
      if (ch.games.some((g) => g.number === ref.number)) return;
      // Game berakhir di halaman game seterusnya (inklusif) atau di hujung bab.
      jobs.push({ ch, ref, end: refs[i + 1]?.page ?? ch.pages[1] });
    });
  }
  console.log(`♟  ${jobs.length} game untuk diproses (concurrency ${args.concurrency})`);

  let done = 0;
  let failed = 0;
  let streak = 0; // kegagalan berturut-turut — biasanya kredit habis / API down
  const worker = async () => {
    for (let job = jobs.shift(); job && streak < 3; job = jobs.shift()) {
      const { ch, ref, end } = job;
      const tag = `[G${ref.number}] `;
      const pdfPages = Array.from({ length: end - ref.page + 1 }, (_, i) => ref.page + i + offset);
      console.log(`   ${tag}${ref.white} – ${ref.black} (Bab ${ch.number}, hlm ${ref.page}–${end})`);
      try {
        const r = await extractWithRepair<Omit<Game, 'id' | 'number' | 'pages'>>(
          pdfPages,
          `Extract Game ${ref.number} (${ref.white} – ${ref.black}) SAHAJA — mula dari tajuk "Game ${ref.number}", ` +
            'berhenti sebelum game seterusnya. Main line mesti lengkap hingga langkah terakhir game, dengan result.',
          gameTool,
          START_FEN,
          tag,
        );
        // Satu proses Node = satu penulis; tulis selepas setiap game supaya kerja tidak hilang jika terhenti.
        ch.games = [...ch.games, { id: `${ch.id}-g${ref.number}`, number: ref.number, pages: [ref.page, end] as [number, number], ...r }].sort(
          (a, b) => a.number - b.number,
        );
        writeFileSync(out, JSON.stringify(book, null, 2) + '\n');
        console.log(`   ${tag}✅ (${++done} siap)`);
        streak = 0;
      } catch (e) {
        failed++;
        streak++;
        console.log(`   ${tag}✗ gagal: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
  if (streak >= 3) console.log(`⛔ Dihentikan selepas ${streak} kegagalan berturut-turut. Baki ${jobs.length} game — jalankan semula untuk sambung.`);
  console.log(`✅ ${done} game disimpan, ${failed} gagal. Jalankan "npm run validate".`);
}

if (cmd === 'scan') await scan();
else if (cmd === 'games') await games();
else if (cmd === 'chapter') await chapter();
else if (cmd === 'intro') await intros();
else console.log('Guna: npm run ingest -- scan|chapter|intro|games --pdf <fail> --book <id> ...');
