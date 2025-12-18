// import type { GlossaryEntry } from "./types";

// function stripHtml(html: string) {
//   const d = document.createElement("div");
//   d.innerHTML = html;
//   return (d.textContent ?? "").trim();
// }

// export function extractInlineFootnotes(doc: Document): Record<string, GlossaryEntry> {
//   const map: Record<string, GlossaryEntry> = {};
//   const container = doc.getElementById("inline-footnotes");
//   if (!container) return map;

//   const notes = Array.from(container.querySelectorAll("div.footnote[id]"));
//   for (const note of notes) {
//     const id = note.getAttribute("id") || "";
//     if (!id.startsWith("fn-")) continue;

//     const key = id.replace(/^fn-/, "");
//     const strong = note.querySelector("span.sr-only strong");
//     const label = (strong?.textContent ?? key).trim();

//     const clone = note.cloneNode(true) as HTMLElement;
//     // remove sr-only paragraph if present
//     const srP = clone.querySelector("span.sr-only")?.closest("p");
//     srP?.remove();

//     const html = clone.innerHTML.trim();
//     const text = stripHtml(html);

//     map[key] = { key, label, html, text };
//   }
//   return map;
// }

import type { GlossaryEntry } from "./types";

function stripHtml(html: string) {
  const d = document.createElement("div");
  d.innerHTML = html;
  return (d.textContent ?? "").trim();
}

export function extractInlineFootnotes(doc: Document): Record<string, GlossaryEntry> {
  const map: Record<string, GlossaryEntry> = {};

  // Match common EPUB footnote patterns (not just #inline-footnotes)
  const nodes = Array.from(doc.querySelectorAll(
    [
      '[id^="fn-"]',
      ".footnote[id]",
      '[role="doc-footnote"][id]',
      '[epub\\:type~="footnote"][id]',
    ].join(",")
  )) as HTMLElement[];

  for (const el of nodes) {
    const id = el.getAttribute("id") || "";
    if (!id) continue;

    // normalize key
    let key = id.startsWith("fn-") ? id.slice(3) : id;
    if (key.startsWith("note-")) key = key.slice(5);

    // label if present
    const strong = el.querySelector("span.sr-only strong");
    const label = (strong?.textContent ?? key).trim();

    // clone and remove sr-only blocks
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".sr-only").forEach(n => n.remove());

    const html = clone.innerHTML.trim();
    const text = stripHtml(html);

    const entry: GlossaryEntry = { key, label, html, text };

    // store multiple keys so lookups succeed for different href styles
    map[key] = entry;
    map[id] = entry;              // e.g. "fn-nafs"
    map[`fn-${key}`] = entry;     // also allow "fn-nafs"
  }

  return map;
}


export function isNoterefAnchor(a: HTMLAnchorElement) {
  const cls = a.classList.contains("noteref");
  const role = a.getAttribute("role") === "doc-noteref";
  const et = (a.getAttribute("epub:type") || "").split(/\s+/).includes("noteref");
  return cls || role || et;
}

export function parseFnHref(href: string): { file: string | null; fnKey: string | null } {
  const [filePart, hashPart] = href.split("#");
  const frag = hashPart ? decodeURIComponent(hashPart) : "";
  if (!frag.startsWith("fn-")) return { file: filePart || null, fnKey: null };
  return { file: filePart || null, fnKey: frag.replace(/^fn-/, "") };
}
