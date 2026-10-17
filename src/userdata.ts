// Data peribadi pembaca (disimpan dalam localStorage pelayar): progress bacaan, tanda buku & nota, kad latihan.
// Kunci bahagian = "<bookId>/<chapterId>/<sectionKey>", kunci langkah = kunci bahagian + "#" + laluan indeks anak.

export interface Note {
  label: string; // contoh "Bab 2 · Game 17 · 12...Bxd5" — untuk senarai tanpa perlu bina pokok
  note?: string;
  bookmark?: boolean;
  ts: number;
}

export interface Card {
  reps: number;
  ease: number;
  interval: number; // hari
  due: number; // epoch ms
  lastMistakes: number;
}

interface Store {
  read: Record<string, number>; // kunci bahagian → masa dibaca
  notes: Record<string, Note>; // kunci langkah → nota
  cards: Record<string, Card>; // kunci bahagian → kad latihan
}

const KEY = 'rak-catur:user';
const DAY = 86_400_000;

function load(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s) return { read: s.read ?? {}, notes: s.notes ?? {}, cards: s.cards ?? {} };
  } catch {
    /* abaikan */
  }
  return { read: {}, notes: {}, cards: {} };
}

const store = load();
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storan penuh / disekat — abaikan */
  }
};

// ---------- Progress bacaan ----------
export const isRead = (sec: string) => sec in store.read;
export function markRead(sec: string) {
  if (isRead(sec)) return false;
  store.read[sec] = Date.now();
  save();
  return true;
}

// ---------- Tanda buku & nota ----------
export const noteOf = (key: string): Note | undefined => store.notes[key];
export function setNote(key: string, label: string, patch: Partial<Pick<Note, 'note' | 'bookmark'>>) {
  const next: Note = { ...store.notes[key], label, ts: Date.now(), ...patch };
  if (!next.note?.trim() && !next.bookmark) delete store.notes[key];
  else store.notes[key] = next;
  save();
}
export const allNotes = () =>
  Object.entries(store.notes)
    .map(([key, n]) => ({ key, ...n }))
    .sort((a, b) => b.ts - a.ts);

// ---------- Latihan (spaced repetition, SM-2 ringkas) ----------
export const cardOf = (sec: string): Card | undefined => store.cards[sec];

/** Kemas kini kad selepas satu pusingan latihan. Kesilapan menentukan gred. */
export function review(sec: string, mistakes: number): Card {
  const c: Card = store.cards[sec] ?? { reps: 0, ease: 2.5, interval: 0, due: 0, lastMistakes: 0 };
  if (mistakes === 0) {
    c.interval = c.reps === 0 ? 1 : c.reps === 1 ? 3 : Math.round(c.interval * c.ease);
    c.reps++;
    c.ease = Math.min(3, c.ease + 0.1);
  } else if (mistakes <= 2) {
    c.interval = Math.max(1, Math.round(c.interval * 1.2));
    c.ease = Math.max(1.3, c.ease - 0.15);
  } else {
    c.reps = 0;
    c.interval = 1;
    c.ease = Math.max(1.3, c.ease - 0.2);
  }
  c.lastMistakes = mistakes;
  c.due = Date.now() + c.interval * DAY;
  store.cards[sec] = c;
  save();
  return c;
}

export const dueCards = (now = Date.now()) =>
  Object.entries(store.cards)
    .filter(([, c]) => c.due <= now)
    .map(([sec, c]) => ({ sec, ...c }));
