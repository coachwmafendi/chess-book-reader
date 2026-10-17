# Rak Catur
Static TS app (Vite, no framework) — chess book reader. Deploy: Cloudflare Pages.
- Data: `data/*.json` (types in `src/types.ts`). Always run `npm run validate` after editing data.
- PGN → tree: `src/lib/tree.ts` (shared by browser + scripts). Board: chessground. Engine: `public/engine/stockfish.*` (SF 17.1 lite single-thread).
- Ingest: `scripts/ingest.ts` + `scripts/llm.ts` (MuPDF render → LLM vision → chess.js repair loop). Default provider Anthropic; set `INGEST_PROVIDER=google` + `GOOGLE_API_KEY` for Gemini. Anthropic uses `ANTHROPIC_API_KEY` / `CLAUDE_MODEL`.
- UI text is Bahasa Melayu.
