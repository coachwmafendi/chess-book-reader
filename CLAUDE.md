# Rak Catur
Static TS app (Vite, no framework) — chess book reader. Deploy: Cloudflare Pages.
- Data: `data/*.json` (types in `src/types.ts`). Always run `npm run validate` after editing data.
- PGN → tree: `src/lib/tree.ts` (shared by browser + scripts). Board: chessground. Engine: `public/engine/stockfish.*` (SF 17.1 lite single-thread).
- Ingest: `scripts/ingest.ts` (MuPDF render → Claude vision → chess.js repair loop).
- UI text is Bahasa Melayu.
