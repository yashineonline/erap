export async function defineWordFallback(term: string): Promise<string | null> {
    const t = term.trim();
    if (!t) return null;
  
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(t)}`);
      if (!res.ok) return null;
      const data = await res.json();
  
      const defs: string[] = [];
      for (const entry of data || []) {
        for (const meaning of entry.meanings || []) {
          for (const d of meaning.definitions || []) {
            if (d.definition) defs.push(d.definition);
          }
        }
      }
      return defs.length ? defs.slice(0, 6).join("\n") : null;
    } catch {
      return null;
    }
  }
  