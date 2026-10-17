// Pembalut ringkas untuk Stockfish 17.1 lite (single-thread WASM) dalam Web Worker.
// Single-thread = tak perlu header COOP/COEP, jadi boleh terus host di Cloudflare Pages.
import { Chess } from 'chess.js';

export interface EngineInfo {
  depth: number;
  /** Nilai dari perspektif White, dalam pawn. */
  cp?: number;
  /** Mat dalam N langkah (positif = White mat). */
  mate?: number;
  pv: string[]; // SAN
  best?: [string, string];
  fen: string;
}

export class Engine {
  private worker: Worker | null = null;
  private ready = false;
  private queued: string | null = null;
  private fen = '';
  onInfo: (info: EngineInfo) => void = () => {};

  private boot() {
    this.worker = new Worker('/engine/stockfish.js');
    this.worker.onmessage = (e: MessageEvent<string>) => this.handle(String(e.data));
    this.worker.postMessage('uci');
    this.worker.postMessage('setoption name Hash value 32');
    this.worker.postMessage('isready');
  }

  analyse(fen: string) {
    if (!this.worker) this.boot();
    this.fen = fen;
    if (!this.ready) {
      this.queued = fen;
      return;
    }
    this.worker!.postMessage('stop');
    this.worker!.postMessage(`position fen ${fen}`);
    this.worker!.postMessage('go depth 22');
  }

  stop() {
    this.worker?.postMessage('stop');
  }

  private handle(line: string) {
    if (line === 'readyok') {
      this.ready = true;
      if (this.queued) this.analyse(this.queued);
      this.queued = null;
      return;
    }
    if (!line.startsWith('info') || !line.includes(' pv ')) return;
    const depth = Number(/ depth (\d+)/.exec(line)?.[1] ?? 0);
    const cp = /score cp (-?\d+)/.exec(line)?.[1];
    const mate = /score mate (-?\d+)/.exec(line)?.[1];
    const uci = line.split(' pv ')[1].trim().split(' ');
    const sign = this.fen.split(' ')[1] === 'w' ? 1 : -1;

    const chess = new Chess(this.fen);
    const pv: string[] = [];
    for (const m of uci.slice(0, 10)) {
      try {
        pv.push(chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] }).san);
      } catch {
        break;
      }
    }
    this.onInfo({
      depth,
      cp: cp !== undefined ? (sign * Number(cp)) / 100 : undefined,
      mate: mate !== undefined ? sign * Number(mate) : undefined,
      pv,
      best: uci[0] ? [uci[0].slice(0, 2), uci[0].slice(2, 4)] : undefined,
      fen: this.fen,
    });
  }
}
