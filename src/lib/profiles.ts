export type BookProfile = "default" | "quran";

export function detectProfileFromMetadata(metaTitle: string, _metaAuthor: string, _sampleText: string): BookProfile {
  const t = (metaTitle || "").trim().replace(/\s+/g, " ").toLowerCase();
  return t === "the quran" ? "quran" : "default";
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
