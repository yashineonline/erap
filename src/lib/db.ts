import { openDB } from "idb";

export type StoredBook = {
  id: string;
  title: string;
  author?: string;
  addedAt: number;
  blob: Blob;
  coverDataUrl?: string;
  lastLocator?: string; // epub.js CFI
  profile?: "default" | "quran";
};

export type ReaderPrefs = {
  bg: string;
  fg: string;
  font: string;
  fontSize: number;     // percent
  lineHeight: number;   // em
  studyMode: boolean;
};

export type ReadingSession = {
  id: string;
  bookId: string;
  startAt: number;
  endAt?: number;
  seconds?: number;
  lastHref?: string;
};

export type SearchCache = {
  bookId: string;
  exported: any;           // flexsearch export blob
  hrefText: Record<string, string>; // href -> plain text (for snippets)
  updatedAt: number;
};

const DB_NAME = "universal_reader_db";
const DB_VER = 1;

export async function db() {
  return openDB(DB_NAME, DB_VER, {
    upgrade(up) {
      up.createObjectStore("books", { keyPath: "id" });
      up.createObjectStore("prefs", { keyPath: "bookId" });
      up.createObjectStore("sessions", { keyPath: "id" });
      up.createObjectStore("search", { keyPath: "bookId" });
      up.createObjectStore("meta", { keyPath: "key" });
    },
  });
}

export async function getAllBooks(): Promise<StoredBook[]> {
  const d = await db();
  return (await d.getAll("books")) as StoredBook[];
}

export async function putBook(b: StoredBook) {
  const d = await db();
  await d.put("books", b);
}

export async function getBook(bookId: string): Promise<StoredBook | undefined> {
  const d = await db();
  return (await d.get("books", bookId)) as StoredBook | undefined;
}

export async function deleteBook(bookId: string) {
  const d = await db();
  await d.delete("books", bookId);
  await d.delete("prefs", bookId);
  await d.delete("search", bookId);
}

export async function getPrefs(bookId: string): Promise<ReaderPrefs> {
  const d = await db();
  const stored = await d.get("prefs", bookId);
  return (
    stored?.prefs ?? {
      bg: "#ffffff",
      fg: "#111827",
      font: "ui-serif, Georgia, \"Times New Roman\", Times, serif",
      fontSize: 110,
      lineHeight: 1.55,
      studyMode: false,
    }
  );
}

export async function putPrefs(bookId: string, prefs: ReaderPrefs) {
  const d = await db();
  await d.put("prefs", { bookId, prefs });
}

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const d = await db();
  const v = await d.get("meta", key);
  return (v?.value ?? fallback) as T;
}

export async function setMeta<T>(key: string, value: T) {
  const d = await db();
  await d.put("meta", { key, value });
}

export async function putSession(s: ReadingSession) {
  const d = await db();
  await d.put("sessions", s);
}

export async function getSessionsByBook(bookId: string): Promise<ReadingSession[]> {
  const d = await db();
  const all = (await d.getAll("sessions")) as ReadingSession[];
  return all.filter((x) => x.bookId === bookId);
}

export async function putSearchCache(c: SearchCache) {
  const d = await db();
  await d.put("search", c);
}

export async function getSearchCache(bookId: string): Promise<SearchCache | undefined> {
  const d = await db();
  return (await d.get("search", bookId)) as SearchCache | undefined;
}
