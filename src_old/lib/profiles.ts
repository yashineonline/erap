export type BookProfile = "default" | "quran";

export function detectProfileFromMetadata(metaTitle: string, _metaAuthor: string, _sampleText: string): BookProfile {
  const t = (metaTitle || "").trim().replace(/\s+/g, " ").toLowerCase();
  return t === "the quran" ? "quran" : "default";
}

export function buildCitation(profile: BookProfile, opts: {
  title: string;
  author?: string;
  chapter?: string;
  section?: string;   // ✅ new
  href?: string;
  verseHint?: string;
}) {
  const title = (opts.title || "").trim().replace(/\s+/g, " ").replace(/[.]\s*$/, "");
  const place = (opts.section ?? opts.chapter)?.trim();
  const verse = opts.verseHint ? ` (${opts.verseHint})` : "";

  if (profile === "quran") {
    const who = opts.author ? `Translated by ${opts.author}` : "Translation";
    // const where = opts.verseHint ? `(${opts.verseHint})` : (opts.chapter ? `(${opts.chapter})` : "");
        // Title. Section. (VerseHint)
    return `${who}. ${title}${place ? `. ${place}` : ""}${verse}.`
      .replace(/\s+/g, " ")
      .trim();
    // return `${who}. ${opts.title} ${where}`.trim();
  }

  const author = opts.author ? `${opts.author}. ` : "";
  // const chapter = opts.chapter ? ` ${opts.chapter}.` : "";
  return `${author}${title}${place ? `. ${place}` : ""}${verse}.`
    .replace(/\s+/g, " ")
    .trim();
  // return `${author}${opts.title}.${chapter}`.replace(/\s+/g, " ").trim();
}
