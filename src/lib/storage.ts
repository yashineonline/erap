import { get, set, del } from "idb-keyval";
import type { BookMeta, ReaderPrefs, ReadingSession } from "./types";

const K = {
  meta: "meta:v1",
  books: "books:v1",                  // BookMeta[]
  bookFile: (id: string) => `bf:${id}`, // Blob
  prefs: (id: string) => `prefs:${id}`,  // ReaderPrefs
  sessions: (id: string) => `sess:${id}`, // ReadingSession[]
  search: (id: string) => `search:${id}`, // { exported, hrefText, updatedAt }
};

export const DEFAULT_PREFS: ReaderPrefs = {
  bg: "#ffffff",
  fg: "#111827",
  font: `ui-serif, Georgia, "Times New Roman", Times, serif`,
  fontSizePct: 110,
  lineHeight: 1.55,
  marginEm: 1.2,
  studyMode: false,
};

export async function isOnboarded(): Promise<boolean> {
  const meta = (await get(K.meta)) ?? {};
  return Boolean(meta.onboarded);
}
export async function setOnboarded() {
  const meta = (await get(K.meta)) ?? {};
  meta.onboarded = true;
  await set(K.meta, meta);
}

export async function loadBooks(): Promise<BookMeta[]> {
  return (await get(K.books)) ?? [];
}
export async function saveBooks(books: BookMeta[]) {
  await set(K.books, books);
}

export async function saveBookFile(id: string, blob: Blob) {
  await set(K.bookFile(id), blob);
}
export async function loadBookFile(id: string): Promise<Blob | null> {
  return (await get(K.bookFile(id))) ?? null;
}

export async function deleteBook(id: string) {
  const books = await loadBooks();
  await saveBooks(books.filter(b => b.id !== id));
  await del(K.bookFile(id));
  await del(K.prefs(id));
  await del(K.sessions(id));
  await del(K.search(id));
}

export async function loadPrefs(bookId: string): Promise<ReaderPrefs> {
  return (await get(K.prefs(bookId))) ?? DEFAULT_PREFS;
}
export async function savePrefs(bookId: string, prefs: ReaderPrefs) {
  await set(K.prefs(bookId), prefs);
}

export async function loadSessions(bookId: string): Promise<ReadingSession[]> {
  return (await get(K.sessions(bookId))) ?? [];
}
export async function saveSessions(bookId: string, s: ReadingSession[]) {
  await set(K.sessions(bookId), s);
}

export async function loadSearchCache(bookId: string): Promise<any | null> {
  return (await get(K.search(bookId))) ?? null;
}
export async function saveSearchCache(bookId: string, data: any) {
  await set(K.search(bookId), data);
}
