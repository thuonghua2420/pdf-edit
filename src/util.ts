export const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function debounce<T extends (...args: never[]) => void>(fn: T, delay: number) {
  let timer = 0;
  return (...args: Parameters<T>) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

export function rafThrottle<T extends (...args: never[]) => void>(fn: T) {
  let frame = 0;
  let lastArgs: Parameters<T> | null = null;
  return (...args: Parameters<T>) => {
    lastArgs = args;
    if (frame) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = 0;
      const callArgs = lastArgs;
      lastArgs = null;
      if (callArgs) {
        fn(...callArgs);
      }
    });
  };
}

/** "1-3, 5, 8-" -> chỉ số trang (0-based), giữ đúng thứ tự người dùng nhập, bỏ trùng. */
export function parsePageRange(input: string, pageCount: number): number[] | null {
  const text = input.trim();
  if (!text) {
    return null;
  }

  const result: number[] = [];
  const seen = new Set<number>();

  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const match = /^(\d*)(?:-(\d*))?$/.exec(part);
    if (!match || (!match[1] && !match[2])) {
      return null;
    }

    const hasDash = part.includes("-");
    const from = match[1] ? Number(match[1]) : 1;
    const to = hasDash ? (match[2] ? Number(match[2]) : pageCount) : from;
    if (from < 1 || to < 1 || from > pageCount) {
      return null;
    }

    const low = Math.min(from, to);
    const high = Math.min(Math.max(from, to), pageCount);
    const pagesInPart: number[] = [];
    for (let page = low; page <= high; page += 1) {
      pagesInPart.push(page - 1);
    }
    if (from > to) {
      pagesInPart.reverse();
    }
    for (const pageIndex of pagesInPart) {
      if (!seen.has(pageIndex)) {
        seen.add(pageIndex);
        result.push(pageIndex);
      }
    }
  }

  return result.length ? result : null;
}

export function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3
    ? clean.split("").map((part) => part + part).join("")
    : clean.padEnd(6, "0");
  const value = Number.parseInt(full, 16) || 0;
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const stripDiacritics = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");

export function storageGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function storageSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* bộ nhớ đầy hoặc bị chặn — bỏ qua */
  }
}

export const baseName = (fileName: string) => fileName.replace(/\.[^.]+$/, "");
