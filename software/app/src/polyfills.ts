// polyfills.ts - the two web globals the phone's JavaScript engine lacks.
//
// Hermes, the engine inside a native build, ships atob/btoa but not
// TextDecoder/TextEncoder (checked against the strings in libhermesvm.so of
// the released APK). three.js's GLB parser calls `new TextDecoder()` before
// it reads a single byte, so without this the twin fails to load on every
// phone while the desktop browser is fine. Imported first, from index.ts.
// UTF-8 only, which is all a glTF header ever contains.
const g = globalThis as any;

if (typeof g.TextDecoder === 'undefined') {
  g.TextDecoder = class TextDecoder {
    readonly encoding = 'utf-8';
    decode(input?: ArrayBufferView | ArrayBuffer): string {
      if (!input) return '';
      const b = input instanceof Uint8Array ? input
        : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      let out = '';
      for (let i = 0; i < b.length;) {
        const c = b[i++];
        if (c < 0x80) { out += String.fromCharCode(c); continue; }
        let cp: number, n: number;
        if (c >= 0xf0) { cp = c & 0x07; n = 3; } else if (c >= 0xe0) { cp = c & 0x0f; n = 2; } else { cp = c & 0x1f; n = 1; }
        for (let k = 0; k < n && i < b.length; k++) cp = (cp << 6) | (b[i++] & 0x3f);
        out += cp > 0xffff ? String.fromCodePoint(cp) : String.fromCharCode(cp);
      }
      return out;
    }
  };
}

if (typeof g.TextEncoder === 'undefined') {
  g.TextEncoder = class TextEncoder {
    readonly encoding = 'utf-8';
    encode(s = ''): Uint8Array {
      const out: number[] = [];
      for (let i = 0; i < s.length; i++) {
        let cp = s.codePointAt(i)!;
        if (cp > 0xffff) i++;
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
      return new Uint8Array(out);
    }
  };
}

export {};
