export type BookProfile = "default" | "quran";

export function detectProfileFromMetadata(metaTitle: string, metaAuthor: string, sampleText: string): BookProfile {
  const t = (metaTitle || "").toLowerCase();
  const a = (metaAuthor || "").toLowerCase();
  const s = (sampleText || "").toLowerCase();

  // Heuristics: you can tighten later
  const looksQuran =
    t.includes("quran") ||
    t.includes("koran") ||
    s.includes("surah") ||
    s.includes("sura") ||
    /(^|\n)\s*\d+\s*[:.]\s*\d+/.test(sampleText) ||   // 2:255 style
    a.includes("translation") && s.includes("allah");

  return looksQuran ? "quran" : "default";
}

export function buildCitation(profile: BookProfile, opts: {
  title: string;
  author?: string;
  chapter?: string;
  href?: string;
  verseHint?: string;
}) {
  if (profile === "quran") {
    const who = opts.author ? `Translated by ${opts.author}` : "Translation";
    const where = opts.verseHint ? `(${opts.verseHint})` : (opts.chapter ? `(${opts.chapter})` : "");
    return `${who}. ${opts.title} ${where}`.trim();
  }

  const author = opts.author ? `${opts.author}. ` : "";
  const chapter = opts.chapter ? ` ${opts.chapter}.` : "";
  return `${author}${opts.title}.${chapter}`.replace(/\s+/g, " ").trim();
}
