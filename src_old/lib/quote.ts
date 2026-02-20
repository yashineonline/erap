import { buildCitation, type BookProfile } from "./profiles";

export function inferVerseHint(selection: string): string | undefined {
  const m = selection.match(/^\s*(\d{1,3}\s*[:.]\s*\d{1,3})\b/);
  const m1 = m?.[1];
  if (m1) return m1.replace(/\s+/g, "");

  const n = selection.match(/^\s*(\d{1,4})\b/);
  const n1 = n?.[1];
  if (n1) return n1;

  return undefined;
}

function clean(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Quran Sura selection rule (no hardcoded sura list):
 * - use the nearest “enclosing” section name that starts with "Sura"
 * - if the passed `section` isn't "Sura ...", move upward to `chapter`
 * - also handles breadcrumb strings that contain "... Sura ... ..."
 */
function pickSuraLine(section?: string, chapter?: string): string | undefined {
  const s = clean(section);
  const c = clean(chapter);

  if (/^Sura\b/i.test(s)) return s;
  if (/^Sura\b/i.test(c)) return c;

  // if section/chapter are breadcrumb-like, extract a "Sura ..." chunk if present
  for (const v of [s, c]) {
    if (!v) continue;
    const m = v.match(/(Sura\b[^|/>]+)$/i) || v.match(/(Sura\b[^|/>]+)/i);
    if (m?.[1]) return clean(m[1]);
  }

  return undefined;
}

function formatQuranCitation(author: string | undefined, title: string): string {
  const a = clean(author);
  const t = clean(title);
  return a ? `Translated by ${a}. ${t}.` : `${t}.`;
}

export function buildQuoteText(args: {
  profile: BookProfile;
  selectedText: string;
  title: string;
  author?: string;
  chapter?: string;
  section?: string;
}) {
  const selected = clean(args.selectedText);
  const verseHint = inferVerseHint(selected);

  if (args.profile === "quran") {
    // Quran requirements:
    // 1) Sura line between quote and citation (enclosing Sura, not Juz)
    // 2) Citation MUST NOT include Juz/section; only translator + title
    const suraLine = pickSuraLine(args.section, args.chapter);
    const cite = formatQuranCitation(args.author, args.title);

    return suraLine
      ? `“${selected}”\n${suraLine}\n\n— ${cite}`
      : `“${selected}”\n\n— ${cite}`;
  }

  // Non-Quran: keep existing behavior (citation may include section/chapter)
  const cite = buildCitation(args.profile, {
    title: args.title,
    author: args.author,
    section: args.section ?? args.chapter,
    verseHint,
  });

  return `"${selected}"\n\n— ${cite}`;
}
