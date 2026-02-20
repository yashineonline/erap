export type BookProfile = "default" | "quran";

export type BookMeta = {
  id: string;
  title: string;
  author?: string;
  addedAt: number;
  coverDataUrl?: string;
  lastCfi?: string;
  lastHref?: string;
  lastProgress?: number; // 0..1
  profile?: BookProfile;
};

export type TextAlign = "left" | "justify" | "center" | "right";

export type ReaderPrefs = {
  bg: string;
  fg: string;
  font: string;
  fontSizePct: number;  // 80..180
  lineHeight: number;   // 1.2..2.2
  marginEm: number;     // 0.4..2.4
  studyMode: boolean;
  textAlign: TextAlign;
  noterefColor: string;
  noterefUnderline: boolean;
};

export type ReadingSession = {
  id: string;
  bookId: string;
  startAt: number;
  endAt?: number;
  seconds?: number;
};

export type GlossaryEntry = {
  key: string;    // e.g. "nafs"
  label: string;  // e.g. "nafs"
  html: string;   // inner HTML of definition
  text: string;   // plain text
};



