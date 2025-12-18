import { db, putSession, type ReadingSession, getSessionsByBook } from "../lib/db";

export function newId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export async function startSession(bookId: string): Promise<ReadingSession> {
  const s: ReadingSession = { id: newId(), bookId, startAt: Date.now() };
  await putSession(s);
  return s;
}

export async function endSession(bookId: string, sessionId: string, lastHref?: string) {
    const d = await db();
    const s = (await d.get("sessions", sessionId)) as ReadingSession | undefined;
    if (!s || s.bookId !== bookId) return;
  
    const endAt = Date.now();
    const seconds = Math.max(0, Math.round((endAt - s.startAt) / 1000));
    await putSession({ ...s, endAt, seconds, lastHref: lastHref ?? (s as any).lastHref });
  }
  

// export async function endSession(s: ReadingSession, lastHref?: string) {
//   const endAt = Date.now();
//   const seconds = Math.max(0, Math.round((endAt - s.startAt) / 1000));
//   await putSession({ ...s, endAt, seconds, lastHref });
// }

export async function totals(bookId: string) {
  const sessions = await getSessionsByBook(bookId);
  const totalSeconds = sessions.reduce((acc, x) => acc + (x.seconds ?? 0), 0);
  const totalSessions = sessions.filter((x) => x.endAt).length;
  return { totalSeconds, totalSessions };
}
