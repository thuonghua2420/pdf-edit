import fontkit from "@pdf-lib/fontkit";
import { bus, state } from "./state";
import type { FontInfo } from "./types";

export const LINE_HEIGHT = 1.25;

export type LoadedFont = {
  key: string;
  cssName: string;
  bytes: Uint8Array;
  ascent: number;
  descent: number;
  unitsPerEm: number;
  hasBold: boolean;
  hasItalic: boolean;
  measure: (text: string, size: number) => number;
};

const fallbackStacks: Record<string, string> = {
  arial: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
  times: '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace',
  calibri: "Calibri, Carlito, Arial, sans-serif",
  georgia: "Georgia, serif",
  tahoma: "Tahoma, Arial, sans-serif",
  verdana: "Verdana, Geneva, sans-serif",
  segoe: '"Segoe UI", system-ui, sans-serif',
  dejavu: '"DejaVu Sans", Arial, sans-serif',
  "script-segoe": '"Segoe Script", cursive',
  "script-ink": '"Ink Free", cursive',
  "script-brush": '"Brush Script MT", cursive',
  "script-lucida": '"Lucida Handwriting", cursive',
};

export const fontKey = (family: string, bold: boolean, italic: boolean) =>
  `${family}-${bold ? 1 : 0}${italic ? 1 : 0}`;

const cache = new Map<string, Promise<LoadedFont | null>>();
const ready = new Map<string, LoadedFont>();

export async function loadFontList() {
  try {
    const response = await fetch("/api/fonts");
    if (!response.ok) {
      throw new Error("fonts");
    }
    const payload = (await response.json()) as { fonts: FontInfo[] };
    state.fonts = payload.fonts;
  } catch {
    state.fonts = [];
  }
  bus.emit("ui");
}

export const textFonts = () => state.fonts.filter((font) => !font.script);
export const scriptFonts = () => state.fonts.filter((font) => font.script);

export function fontInfo(family: string) {
  return state.fonts.find((font) => font.id === family) ?? null;
}

export function loadFont(family: string, bold: boolean, italic: boolean): Promise<LoadedFont | null> {
  const info = fontInfo(family);
  const useBold = bold && (info ? info.bold : true);
  const useItalic = italic && (info ? info.italic : true);
  const key = fontKey(family, useBold, useItalic);
  const existing = cache.get(key);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    try {
      const response = await fetch(
        `/api/font?family=${encodeURIComponent(family)}&bold=${useBold ? 1 : 0}&italic=${useItalic ? 1 : 0}`,
      );
      if (!response.ok) {
        return null;
      }
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const font = fontkit.create(bytes) as unknown as {
        ascent: number;
        descent: number;
        unitsPerEm: number;
        layout: (text: string) => { advanceWidth: number };
      };
      const cssName = `pdfx-${key}`;

      try {
        const face = new FontFace(cssName, buffer.slice(0));
        await face.load();
        document.fonts.add(face);
      } catch {
        /* vẫn dùng được để xuất PDF dù trình duyệt không nạp được */
      }

      const loaded: LoadedFont = {
        key,
        cssName,
        bytes,
        ascent: font.ascent / font.unitsPerEm,
        descent: Math.abs(font.descent) / font.unitsPerEm,
        unitsPerEm: font.unitsPerEm,
        hasBold: useBold,
        hasItalic: useItalic,
        measure: (text, size) => {
          let widest = 0;
          for (const line of text.split("\n")) {
            widest = Math.max(widest, (font.layout(line).advanceWidth / font.unitsPerEm) * size);
          }
          return widest;
        },
      };
      ready.set(key, loaded);
      bus.emit("props");
      return loaded;
    } catch {
      return null;
    }
  })();

  cache.set(key, promise);
  return promise;
}

/** Tăng mỗi khi có font mới nạp xong — dùng để biết khi nào cần đo/vẽ lại chữ. */
export const fontEpoch = () => ready.size;

export function getReadyFont(family: string, bold: boolean, italic: boolean) {
  const info = fontInfo(family);
  const useBold = bold && (info ? info.bold : true);
  const useItalic = italic && (info ? info.italic : true);
  const found = ready.get(fontKey(family, useBold, useItalic));
  if (!found) {
    void loadFont(family, bold, italic);
  }
  return found ?? null;
}

/** CSS để hiển thị đúng font sẽ được nhúng vào PDF. */
export function fontCss(family: string, bold: boolean, italic: boolean) {
  const stack = fallbackStacks[family] ?? fallbackStacks.arial;
  const loaded = getReadyFont(family, bold, italic);
  if (loaded) {
    return `font-family:"${loaded.cssName}",${stack};font-weight:${bold && !loaded.hasBold ? 700 : 400};font-style:${italic && !loaded.hasItalic ? "italic" : "normal"};`;
  }
  return `font-family:${stack};font-weight:${bold ? 700 : 400};font-style:${italic ? "italic" : "normal"};`;
}

export function textBox(
  text: string,
  family: string,
  bold: boolean,
  italic: boolean,
  size: number,
) {
  const loaded = getReadyFont(family, bold, italic);
  const lines = text.split("\n").length;
  const lineHeight = size * LINE_HEIGHT;
  return {
    width: loaded ? loaded.measure(text, size) : Math.max(...text.split("\n").map((line) => line.length)) * size * 0.55,
    height: lineHeight * lines,
    lineHeight,
    ascent: (loaded?.ascent ?? 0.905) * size,
    descent: (loaded?.descent ?? 0.212) * size,
  };
}

export async function preloadFamily(family: string) {
  await Promise.all([
    loadFont(family, false, false),
    loadFont(family, true, false),
    loadFont(family, false, true),
    loadFont(family, true, true),
  ]);
}
