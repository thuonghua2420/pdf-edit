import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { state } from "./state";
import type { PageItem, PdfTextItem } from "./types";
import { clamp } from "./util";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export const totalRotation = (page: PageItem) => (page.intrinsicRotate + page.rotation) % 360;

export async function openPdfBytes(bytes: ArrayBuffer, password?: string) {
  return pdfjs.getDocument({ data: bytes.slice(0), password }).promise;
}

export function isPasswordError(error: unknown) {
  return error instanceof Error && error.name === "PasswordException";
}

export function wrongPassword(error: unknown) {
  return (error as { code?: number } | null)?.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
}

export type RenderHandle = {
  promise: Promise<void>;
  cancel: () => void;
};

/** Vẽ một trang lên canvas. `scale` = px CSS trên mỗi pt, `ratio` = devicePixelRatio. */
export function renderPage(page: PageItem, canvas: HTMLCanvasElement, scale: number, ratio: number): RenderHandle {
  let cancelled = false;
  let task: pdfjs.RenderTask | null = null;

  const promise = (async () => {
    const source = page.sourceId ? state.sources.get(page.sourceId) : null;
    if (!source) {
      return;
    }

    const pdfPage = await source.pdfDoc.getPage(page.pageIndex + 1);
    if (cancelled) {
      return;
    }

    const viewport = pdfPage.getViewport({ scale: scale * ratio, rotation: totalRotation(page) });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    task = pdfPage.render({ canvasContext: context, viewport });
    try {
      await task.promise;
    } catch (error) {
      if ((error as Error)?.name !== "RenderingCancelledException") {
        throw error;
      }
    }
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
}

const textCache = new Map<string, Promise<PdfTextItem[]>>();

export function getTextItems(page: PageItem): Promise<PdfTextItem[]> {
  if (!page.sourceId) {
    return Promise.resolve([]);
  }

  const key = `${page.sourceId}:${page.pageIndex}:${totalRotation(page)}`;
  const cached = textCache.get(key);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const source = state.sources.get(page.sourceId ?? "");
    if (!source) {
      return [];
    }

    const pdfPage = await source.pdfDoc.getPage(page.pageIndex + 1);
    const viewport = pdfPage.getViewport({ scale: 1, rotation: totalRotation(page) });
    const content = await pdfPage.getTextContent();
    const items: PdfTextItem[] = [];

    for (const raw of content.items) {
      if (!("str" in raw) || !raw.str.trim()) {
        continue;
      }

      const transform = pdfjs.Util.transform(viewport.transform, raw.transform);
      const fontHeight = Math.max(Math.hypot(transform[2], transform[3]), raw.height || 0, 4);
      const angle = Math.atan2(transform[1], transform[0]);
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const vx = Math.sin(angle);
      const vy = -Math.cos(angle);
      const ox = transform[4];
      const oy = transform[5];
      const corners = [
        [ox, oy],
        [ox + ux * raw.width, oy + uy * raw.width],
        [ox + ux * raw.width + vx * fontHeight, oy + uy * raw.width + vy * fontHeight],
        [ox + vx * fontHeight, oy + vy * fontHeight],
      ];
      const minX = clamp(Math.min(...corners.map((corner) => corner[0])), 0, viewport.width);
      const maxX = clamp(Math.max(...corners.map((corner) => corner[0])), 0, viewport.width);
      const minY = clamp(Math.min(...corners.map((corner) => corner[1])), 0, viewport.height);
      const maxY = clamp(Math.max(...corners.map((corner) => corner[1])), 0, viewport.height);

      if (maxX - minX < 1 || maxY - minY < 1) {
        continue;
      }

      items.push({
        text: raw.str,
        x: minX / viewport.width,
        y: minY / viewport.height,
        width: (maxX - minX) / viewport.width,
        height: (maxY - minY) / viewport.height,
        fontSize: clamp(Math.hypot(raw.transform[2], raw.transform[3]), 4, 144),
      });
    }

    return items;
  })();

  textCache.set(key, promise);
  return promise;
}

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;

/** Ước lượng màu nền và màu chữ của một vùng trên canvas đã vẽ. */
export function sampleColors(
  canvas: HTMLCanvasElement,
  rect: { x: number; y: number; width: number; height: number },
) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const fallback = { background: "#ffffff", text: "#111827" };
  if (!context || !canvas.width) {
    return fallback;
  }

  const pad = 2;
  const x0 = clamp(Math.floor(rect.x * canvas.width) - pad, 0, canvas.width - 1);
  const y0 = clamp(Math.floor(rect.y * canvas.height) - pad, 0, canvas.height - 1);
  const x1 = clamp(Math.ceil((rect.x + rect.width) * canvas.width) + pad, x0 + 1, canvas.width);
  const y1 = clamp(Math.ceil((rect.y + rect.height) * canvas.height) + pad, y0 + 1, canvas.height);
  const width = x1 - x0;
  const height = y1 - y0;

  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(x0, y0, width, height).data;
  } catch {
    return fallback;
  }

  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  const addBorder = (px: number, py: number) => {
    const offset = (py * width + px) * 4;
    const key = `${data[offset] >> 4}-${data[offset + 1] >> 4}-${data[offset + 2] >> 4}`;
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += data[offset];
    bucket.g += data[offset + 1];
    bucket.b += data[offset + 2];
    buckets.set(key, bucket);
  };

  for (let x = 0; x < width; x += 1) {
    addBorder(x, 0);
    addBorder(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    addBorder(0, y);
    addBorder(width - 1, y);
  }

  let best = { count: 0, r: 255, g: 255, b: 255 };
  for (const bucket of buckets.values()) {
    if (bucket.count > best.count) {
      best = bucket;
    }
  }
  const bg = best.count
    ? [best.r / best.count, best.g / best.count, best.b / best.count]
    : [255, 255, 255];

  let farthest = 0;
  let text = [17, 24, 39];
  for (let py = pad; py < height - pad; py += 1) {
    for (let px = pad; px < width - pad; px += 1) {
      const offset = (py * width + px) * 4;
      const distance = Math.hypot(data[offset] - bg[0], data[offset + 1] - bg[1], data[offset + 2] - bg[2]);
      if (distance > farthest) {
        farthest = distance;
        text = [data[offset], data[offset + 1], data[offset + 2]];
      }
    }
  }

  return {
    background: toHex(bg[0], bg[1], bg[2]),
    text: farthest > 70 ? toHex(text[0], text[1], text[2]) : fallback.text,
  };
}
