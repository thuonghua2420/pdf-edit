import { textBox } from "./fonts";
import { pageDims, state } from "./state";
import type { PageItem, PageNumberPosition, TextOverlay } from "./types";

const MARGIN = 28;

export function pageNumberText(format: string, index: number, total: number, startAt: number) {
  return format
    .replaceAll("{n}", String(startAt + index))
    .replaceAll("{total}", String(startAt + total - 1));
}

/** Watermark & số trang được tạo thành overlay chữ "ảo" để hiển thị và xuất PDF dùng chung một logic. */
export function decorOverlays(page: PageItem, index: number, total: number): TextOverlay[] {
  const { w: W, h: H } = pageDims(page);
  const result: TextOverlay[] = [];
  const { watermark, pageNumbers } = state.doc;

  if (watermark.enabled && watermark.text.trim()) {
    const box = textBox(watermark.text, watermark.family, true, false, watermark.size);
    const angle = (watermark.angle * Math.PI) / 180;
    const halfW = box.width / 2;
    const halfH = box.height / 2;
    const cx = W / 2 - (halfW * Math.cos(angle) - halfH * Math.sin(angle));
    const cy = H / 2 - (halfW * Math.sin(angle) + halfH * Math.cos(angle));
    result.push({
      id: `decor-wm-${page.id}`,
      type: "text",
      x: cx / W,
      y: cy / H,
      text: watermark.text,
      size: watermark.size,
      color: watermark.color,
      family: watermark.family,
      bold: true,
      italic: false,
      angle: watermark.angle,
      opacity: watermark.opacity,
    });
  }

  if (pageNumbers.enabled) {
    const text = pageNumberText(pageNumbers.format, index, total, pageNumbers.startAt);
    const box = textBox(text, pageNumbers.family, false, false, pageNumbers.size);
    const position: PageNumberPosition = pageNumbers.position;
    const x = position.endsWith("l")
      ? MARGIN
      : position.endsWith("r")
        ? W - MARGIN - box.width
        : (W - box.width) / 2;
    const y = position.startsWith("t") ? MARGIN - box.height / 2 : H - MARGIN - box.height / 2;
    result.push({
      id: `decor-pn-${page.id}`,
      type: "text",
      x: x / W,
      y: y / H,
      text,
      size: pageNumbers.size,
      color: pageNumbers.color,
      family: pageNumbers.family,
      bold: false,
      italic: false,
      angle: 0,
      opacity: 1,
    });
  }

  return result;
}
