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
  pages: [number, number];
  intro: { startFen: string; summary: string; keyPoints: string[]; pgn: string };
  games: Game[];
}

export interface Book {
  id: string;
  title: string;
  author: string;
  source?: { file: string; pageOffset: number };
  chapters: Chapter[];
}
