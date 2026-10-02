import { addOverlay, makeOverlay } from "./ops";
import { getPage, pageDims, state } from "./state";
import type { ImageAsset } from "./types";
import { uid } from "./util";

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Không đọc được ảnh."));
    image.src = url;
  });
}

/** Đăng ký ảnh vào kho; ảnh không phải PNG/JPG được chuyển sang PNG. */
export async function registerImage(blob: Blob): Promise<ImageAsset> {
  let bytes: Uint8Array;
  let mime: ImageAsset["mime"];

  if (blob.type === "image/png" || blob.type === "image/jpeg") {
    bytes = new Uint8Array(await blob.arrayBuffer());
    mime = blob.type;
  } else {
    const probeUrl = URL.createObjectURL(blob);
    try {
      const image = await loadImage(probeUrl);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || 300;
      canvas.height = image.naturalHeight || 150;
      canvas.getContext("2d")?.drawImage(image, 0, 0);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!png) {
        throw new Error("Không chuyển được ảnh sang PNG.");
      }
      bytes = new Uint8Array(await png.arrayBuffer());
      mime = "image/png";
    } finally {
      URL.revokeObjectURL(probeUrl);
    }
  }

  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const image = await loadImage(url);
  const asset: ImageAsset = {
    id: uid(),
    bytes,
    mime,
    url,
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
  state.images.set(asset.id, asset);
  return asset;
}

/** Đặt ảnh vào giữa trang đang xem. */
export function placeImage(asset: ImageAsset, options: { widthFraction?: number; pageId?: string } = {}) {
  const page = getPage(options.pageId ?? state.activePageId) ?? state.pages[0];
  if (!page) {
    return false;
  }

  const { w: W, h: H } = pageDims(page);
  const aspect = asset.height / asset.width;
  let wPt = W * (options.widthFraction ?? 0.34);
  if (wPt * aspect > H * 0.6) {
    wPt = (H * 0.6) / aspect;
  }
  const hPt = wPt * aspect;

  addOverlay(
    page.id,
    makeOverlay("image", {
      imageId: asset.id,
      wPt,
      aspect,
      angle: 0,
      x: (1 - wPt / W) / 2,
      y: (1 - hPt / H) / 2,
    }),
  );
  return true;
}

export async function placeImageFile(file: File) {
  const asset = await registerImage(file);
  return placeImage(asset);
}

/** Cắt viền trong suốt quanh nét vẽ (dùng cho chữ ký). */
export function trimCanvas(source: HTMLCanvasElement, padding = 6) {
  const context = source.getContext("2d");
  if (!context) {
    return source;
  }
  const { width, height } = source;
  const data = context.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < 0) {
    return source;
  }

  const out = document.createElement("canvas");
  out.width = maxX - minX + 1 + padding * 2;
  out.height = maxY - minY + 1 + padding * 2;
  out.getContext("2d")?.drawImage(source, minX, minY, out.width - padding * 2, out.height - padding * 2, padding, padding, out.width - padding * 2, out.height - padding * 2);
  return out;
}

export const canvasToBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Không tạo được ảnh."))), "image/png"),
  );

export type StampPreset = { label: string; color: string };

export const STAMP_PRESETS: StampPreset[] = [
  { label: "ĐÃ DUYỆT", color: "#16a34a" },
  { label: "ĐÃ KÝ", color: "#2563eb" },
  { label: "BẢN SAO", color: "#475569" },
  { label: "MẬT", color: "#dc2626" },
  { label: "KHẨN", color: "#ea580c" },
  { label: "ĐÃ THANH TOÁN", color: "#0d9488" },
  { label: "TỪ CHỐI", color: "#dc2626" },
  { label: "BẢN NHÁP", color: "#7c3aed" },
];

export function renderStamp(text: string, color: string, withDate: boolean) {
  const scale = 3;
  const fontSize = 34 * scale;
  const padX = 26 * scale;
  const padY = 22 * scale;
  const measure = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
  measure.font = `800 ${fontSize}px "Segoe UI", Arial, sans-serif`;
  const dateText = new Date().toLocaleDateString("vi-VN");
  const dateSize = 15 * scale;
  const textWidth = measure.measureText(text.toUpperCase()).width;
  measure.font = `600 ${dateSize}px "Segoe UI", Arial, sans-serif`;
  const width = Math.ceil(Math.max(textWidth, withDate ? measure.measureText(dateText).width : 0) + padX * 2);
  const height = Math.ceil(fontSize * 1.1 + padY * 2 + (withDate ? dateSize + 10 * scale : 0));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 5 * scale;
  context.beginPath();
  context.roundRect(4 * scale, 4 * scale, width - 8 * scale, height - 8 * scale, 12 * scale);
  context.stroke();
  context.lineWidth = 1.6 * scale;
  context.beginPath();
  context.roundRect(10 * scale, 10 * scale, width - 20 * scale, height - 20 * scale, 8 * scale);
  context.stroke();

  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `800 ${fontSize}px "Segoe UI", Arial, sans-serif`;
  const textY = padY + fontSize * 0.55;
  context.fillText(text.toUpperCase(), width / 2, textY + 2 * scale);
  if (withDate) {
    context.font = `600 ${dateSize}px "Segoe UI", Arial, sans-serif`;
    context.fillText(dateText, width / 2, textY + fontSize / 2 + dateSize / 2 + 6 * scale);
  }
  return canvas;
}
