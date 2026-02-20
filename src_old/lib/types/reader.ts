export type BookMeta = {
    id: string;
    title: string;
    author?: string;
    addedAt: number;
    coverDataUrl?: string;
    lastCfi?: string;
    lastHref?: string;
    lastProgress?: number; // 0..1
  };
  
  export type ReaderSettings = {
    bg: string;         // css color
    fg: string;         // css color
    link: string;       // css color
    fontFamily: string; // css font-family
    fontSizePct: number;
    lineHeight: number;
    marginEm: number;
    highlightColor: string;
  };
  
  export type Bookmark = {
    id: string;
    label: string;
    cfi: string;
    createdAt: number;
  };
  
  export type Annotation = {
    id: string;
    type: "highlight" | "note";
    cfiRange: string;
    color?: string;
    note?: string;
    selectedText?: string;
    createdAt: number;
  };
  