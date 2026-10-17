export interface KeyPoint {
  at: string; // label main line, contoh "12...Bxd5"
  text: string;
}

export interface Game {
  id: string;
  number: number;
  white: string;
  black: string;
  event?: string;
  year?: number;
  result: string;
  pages: [number, number];
  startFen?: string;
  summary: string;
  keyPoints: KeyPoint[];
  pgn: string;
}

export interface Chapter {
  id: string;
  number: number;
  title: string;
  pages: [number, number]; // nombor halaman tercetak (PDF = tercetak + source.pageOffset)
  intro?: ChapterIntro; // tiada = ringkasan bab belum diproses
  games: Game[];
  gameIndex?: GameRef[]; // senarai penuh game dalam bab (dari "Index of Main Games")
}

export interface ChapterIntro {
  startFen: string;
  summary: string;
  keyPoints: string[];
  pgn: string;
}

export interface GameRef {
  number: number;
  white: string;
  black: string;
  page: number; // halaman tercetak
}

export interface Book {
  id: string;
  title: string;
  author: string;
  year?: number;
  description?: string;
  cover?: string;
  source?: { file: string; pageOffset: number };
  chapters: Chapter[];
}
