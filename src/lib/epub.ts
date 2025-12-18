export function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.onerror = reject;
      r.readAsArrayBuffer(blob);
    });
  }
  
  export function safeText(s: any) {
    return String(s ?? "").replace(/\s+/g, " ").trim();
  }
  