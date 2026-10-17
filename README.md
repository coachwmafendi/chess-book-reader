# Rak Catur — pembaca buku catur interaktif (personal)

Ringkasan dan point penting untuk setiap bab/game, papan interaktif dengan variation dari buku, dan analisis Stockfish. 100% TypeScript, dihost sebagai static site di Cloudflare Pages.

```
PDF/EPUB ──► scripts/ingest.ts (laptop) ──► data/<buku>.json ──► Vite build ──► Cloudflare Pages
              MuPDF render halaman            disemak oleh                       (dikunci dengan
              Claude vision → PGN + ringkasan  chess.js                           Cloudflare Access)
```

## Jalankan

```bash
npm install
npm run dev          # http://localhost:5173
npm run validate     # semak semua PGN dalam data/*.json
npm run build        # validate + build ke dist/
```

Kekunci: `←` `→` langkah, `Home`/`End`, `f` terbalikkan papan. Gerakkan buah di papan untuk cuba idea sendiri (ditanda ungu).

## Tambah buku / bab baru

Perlu `ANTHROPIC_API_KEY`. Nombor halaman = halaman **PDF**, bukan nombor yang tercetak.

```bash
# 1. Cari di halaman mana setiap game bermula (render resolusi rendah, murah)
npm run ingest -- scan --pdf ~/Books/modern-tiger.pdf --book modern-tiger --from 10 --to 98

# 2. Semak .ingest/modern-tiger/map.json, betulkan jika perlu, kemudian:
npm run ingest -- chapter --pdf ~/Books/modern-tiger.pdf --book modern-tiger \
  --chapter 1 --title "4.f4 – Austrian Style" --author "Tiger Hillarp Persson"

npm run validate
```

Setiap game dihantar sebagai imej halaman. Jika chess.js jumpa langkah tidak sah, skrip hantar semula ralat itu kepada model (maksimum 2 kali) untuk dibetulkan. Halaman yang dirender di-cache dalam `.ingest/`.

Model lalai `claude-sonnet-5-5`; tukar dengan `CLAUDE_MODEL=...`.

## Deploy ke Cloudflare Pages

```bash
npm run build
npx wrangler pages deploy dist --project-name rak-catur
```

Kemudian kunci laman: **Cloudflare Zero Trust → Access → Applications → Add (Self-hosted)**, letak domain `rak-catur.pages.dev`, policy = email anda sahaja. Percuma sehingga 50 pengguna.

> Kandungan buku berhak cipta — kekalkan laman ini peribadi.

## Struktur

| Fail | Fungsi |
|---|---|
| `data/*.json` | Data buku: bab → pengenalan + game (PGN, ringkasan, keyPoints) |
| `src/lib/tree.ts` | PGN → pokok langkah + validasi (dikongsi reader & skrip) |
| `src/main.ts` | Reader UI (chessground) |
| `src/engine.ts` | Stockfish 17.1 lite, single-thread (tak perlu header COOP/COEP) |
| `public/engine/` | Fail Stockfish WASM (7 MB, di bawah had 25 MB Pages) |
| `scripts/ingest.ts` | PDF → JSON melalui Claude |
| `scripts/validate.ts` | Semakan chess.js |

## Lesen pihak ketiga

chessground, Stockfish (GPL-3) dan MuPDF (AGPL-3) — OK untuk kegunaan peribadi. Jika app ini dibuka kepada umum kelak, semak semula keperluan lesen.

## Seterusnya

- EPUB: diagram dalam buku seperti *How to Win at Chess* juga imej → guna aliran yang sama, render setiap fail bab.
- Simpan progress/nota dalam Cloudflare D1.
- Batch API (diskaun 50%) untuk proses buku penuh sekali gus.
