import fontkit from "@pdf-lib/fontkit";
import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import { api, type Redaction } from "./api";
import { decorOverlays } from "./decor";
import { LINE_HEIGHT, getReadyFont, loadFont } from "./fonts";
import { arrowHeadLength, arrowHeadPoints, arrowShaftEnd } from "./overlayRender";
import { pageDims, state } from "./state";
import type { Overlay, PageItem, TextOverlay } from "./types";
import { hexToRgb01, stripDiacritics } from "./util";
import { totalRotation } from "./pdfEngine";

type Ctx = {
  doc: PDFDocument;
  fonts: Map<string, PDFFont>;
  fallbackFont: PDFFont | null;
  images: Map<string, PDFImage>;
};

const colorOf = (hex: string) => {
  const [r, g, b] = hexToRgb01(hex);
  return rgb(r, g, b);
};

async function embedTextFont(ctx: Ctx, overlay: TextOverlay) {
  const loaded = await loadFont(overlay.family, overlay.bold, overlay.italic);
  if (loaded) {
    let font = ctx.fonts.get(loaded.key);
    if (!font) {
      font = await ctx.doc.embedFont(loaded.bytes, { subset: true });
      ctx.fonts.set(loaded.key, font);
    }
    return { font, supports: null as Set<number> | null };
  }

  // Không có font Unicode từ máy chủ: dùng Helvetica chuẩn và bỏ dấu những ký tự không mã hoá được.
  ctx.fallbackFont ??= await ctx.doc.embedFont(
    overlay.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica,
  );
  return { font: ctx.fallbackFont, supports: new Set(ctx.fallbackFont.getCharacterSet()) };
}

function sanitizeForFallback(text: string, supports: Set<number>) {
  return Array.from(text)
    .map((char) => {
      if (supports.has(char.codePointAt(0) ?? 0)) {
        return char;
      }
      const plain = stripDiacritics(char);
      return plain && supports.has(plain.codePointAt(0) ?? 0) ? plain : "?";
    })
    .join("");
}

async function drawOverlay(ctx: Ctx, pdfPage: PDFPage, page: PageItem, overlay: Overlay) {
  const { w: Wd, h: Hd } = pageDims(page);
  const total = totalRotation(page);
  const crop = pdfPage.getCropBox();
  const baseW = crop.width;
  const baseH = crop.height;

  /** Toạ độ hiển thị (pt, gốc trên-trái) -> toạ độ nền (pt, y hướng xuống, gốc trên-trái của CropBox). */
  const toBaseDown = (dx: number, dy: number): [number, number] => {
    switch (total) {
      case 0:
        return [dx, dy];
      case 90:
        return [dy, baseH - dx];
      case 180:
        return [baseW - dx, baseH - dy];
      default:
        return [baseW - dy, dx];
    }
  };
  /** Toạ độ PDF thật (y hướng lên). */
  const toPdf = (dx: number, dy: number): [number, number] => {
    const [bx, by] = toBaseDown(dx, dy);
    return [crop.x + bx, crop.y + (baseH - by)];
  };

  const opacity = overlay.opacity;

  switch (overlay.type) {
    case "cover":
    case "redact":
    case "highlight": {
      const [ax, ay] = toPdf(overlay.x * Wd, overlay.y * Hd);
      const [bx, by] = toPdf((overlay.x + overlay.w) * Wd, (overlay.y + overlay.h) * Hd);
      pdfPage.drawRectangle({
        x: Math.min(ax, bx),
        y: Math.min(ay, by),
        width: Math.abs(bx - ax),
        height: Math.abs(by - ay),
        color: colorOf(overlay.type === "redact" ? "#000000" : overlay.color),
        opacity: overlay.type === "redact" ? 1 : opacity,
        blendMode: overlay.type === "highlight" ? BlendMode.Multiply : undefined,
      });
      return;
    }

    case "rect": {
      const inset = overlay.strokeWidth / 2;
      const [ax, ay] = toPdf(overlay.x * Wd + inset, overlay.y * Hd + inset);
      const [bx, by] = toPdf((overlay.x + overlay.w) * Wd - inset, (overlay.y + overlay.h) * Hd - inset);
      pdfPage.drawRectangle({
        x: Math.min(ax, bx),
        y: Math.min(ay, by),
        width: Math.abs(bx - ax),
        height: Math.abs(by - ay),
        color: overlay.fill ? colorOf(overlay.fill) : undefined,
        opacity: overlay.fill ? opacity : undefined,
        borderColor: colorOf(overlay.stroke),
        borderWidth: overlay.strokeWidth,
        borderOpacity: opacity,
      });
      return;
    }

    case "ellipse": {
      const [cx, cy] = toPdf((overlay.x + overlay.w / 2) * Wd, (overlay.y + overlay.h / 2) * Hd);
      const rx = Math.max((overlay.w * Wd - overlay.strokeWidth) / 2, 0.5);
      const ry = Math.max((overlay.h * Hd - overlay.strokeWidth) / 2, 0.5);
      const swap = total % 180 !== 0;
      pdfPage.drawEllipse({
        x: cx,
        y: cy,
        xScale: swap ? ry : rx,
        yScale: swap ? rx : ry,
        color: overlay.fill ? colorOf(overlay.fill) : undefined,
        opacity: overlay.fill ? opacity : undefined,
        borderColor: colorOf(overlay.stroke),
        borderWidth: overlay.strokeWidth,
        borderOpacity: opacity,
      });
      return;
    }

    case "line":
    case "arrow": {
      const x1 = overlay.x1 * Wd;
      const y1 = overlay.y1 * Hd;
      const x2 = overlay.x2 * Wd;
      const y2 = overlay.y2 * Hd;
      let endX = x2;
      let endY = y2;
      const headLength = arrowHeadLength(overlay.strokeWidth);
      if (overlay.type === "arrow") {
        [endX, endY] = arrowShaftEnd(x1, y1, x2, y2, headLength);
      }
      const [sx, sy] = toPdf(x1, y1);
      const [ex, ey] = toPdf(endX, endY);
      pdfPage.drawLine({
        start: { x: sx, y: sy },
        end: { x: ex, y: ey },
        thickness: overlay.strokeWidth,
        color: colorOf(overlay.stroke),
        opacity,
        lineCap: LineCapStyle.Round,
      });

      if (overlay.type === "arrow") {
        const head = arrowHeadPoints(x1, y1, x2, y2, headLength).map(([px, py]) => toBaseDown(px, py));
        const path = `M ${head[0][0]} ${head[0][1]} L ${head[1][0]} ${head[1][1]} L ${head[2][0]} ${head[2][1]} Z`;
        pdfPage.drawSvgPath(path, {
          x: crop.x,
          y: crop.y + baseH,
          color: colorOf(overlay.stroke),
          opacity,
          borderColor: colorOf(overlay.stroke),
          borderWidth: overlay.strokeWidth * 0.4,
          borderOpacity: opacity,
        });
      }
      return;
    }

    case "pen": {
      let path = "";
      for (let index = 0; index < overlay.points.length; index += 2) {
        const [bx, by] = toBaseDown(overlay.points[index] * Wd, overlay.points[index + 1] * Hd);
        path += `${index === 0 ? "M" : "L"} ${bx.toFixed(3)} ${by.toFixed(3)} `;
      }
      if (overlay.points.length === 2) {
        const [bx, by] = toBaseDown(overlay.points[0] * Wd + 0.01, overlay.points[1] * Hd);
        path += `L ${bx.toFixed(3)} ${by.toFixed(3)}`;
      }
      pdfPage.drawSvgPath(path, {
        x: crop.x,
        y: crop.y + baseH,
        borderColor: colorOf(overlay.stroke),
        borderWidth: overlay.strokeWidth,
        borderOpacity: opacity,
        borderLineCap: LineCapStyle.Round,
      });
      return;
    }

    case "image": {
      const asset = state.images.get(overlay.imageId);
      if (!asset) {
        return;
      }
      let image = ctx.images.get(asset.id);
      if (!image) {
        image = asset.mime === "image/png"
          ? await ctx.doc.embedPng(asset.bytes)
          : await ctx.doc.embedJpg(asset.bytes);
        ctx.images.set(asset.id, image);
      }

      const widthPt = overlay.wPt;
      const heightPt = overlay.wPt * overlay.aspect;
      const angle = (overlay.angle * Math.PI) / 180;
      const centerX = overlay.x * Wd + (widthPt / 2) * Math.cos(angle) - (heightPt / 2) * Math.sin(angle);
      const centerY = overlay.y * Hd + (widthPt / 2) * Math.sin(angle) + (heightPt / 2) * Math.cos(angle);
      const [cx, cy] = toPdf(centerX, centerY);
      const pdfAngle = (((total - overlay.angle) % 360) + 360) % 360;
      const theta = (pdfAngle * Math.PI) / 180;
      pdfPage.drawImage(image, {
        x: cx + (-widthPt / 2) * Math.cos(theta) - (-heightPt / 2) * Math.sin(theta),
        y: cy + (-widthPt / 2) * Math.sin(theta) + (-heightPt / 2) * Math.cos(theta),
        width: widthPt,
        height: heightPt,
        rotate: degrees(pdfAngle),
        opacity,
      });
      return;
    }

    case "text": {
      if (!overlay.text.trim()) {
        return;
      }
      const { font, supports } = await embedTextFont(ctx, overlay);
      const ready = getReadyFont(overlay.family, overlay.bold, overlay.italic);
      const ascent = (ready?.ascent ?? 0.905) * overlay.size;
      const descent = (ready?.descent ?? 0.212) * overlay.size;
      const lineHeight = overlay.size * LINE_HEIGHT;
      const angle = (overlay.angle * Math.PI) / 180;
      const pdfAngle = (((total - overlay.angle) % 360) + 360) % 360;

      overlay.text.split("\n").forEach((rawLine, index) => {
        const line = supports ? sanitizeForFallback(rawLine, supports) : rawLine;
        if (!line.trim()) {
          return;
        }
        const offset = index * lineHeight + (lineHeight - (ascent + descent)) / 2 + ascent;
        const [px, py] = toPdf(
          overlay.x * Wd - offset * Math.sin(angle),
          overlay.y * Hd + offset * Math.cos(angle),
        );
        pdfPage.drawText(line, {
          x: px,
          y: py,
          size: overlay.size,
          font,
          color: colorOf(overlay.color),
          opacity,
          rotate: degrees(pdfAngle),
        });
      });
    }
  }
}

export type BuiltPdf = {
  bytes: Uint8Array;
  redactions: Redaction[];
};

/** Dựng PDF từ các trang (mặc định: tất cả) kèm toàn bộ chỉnh sửa. */
export async function buildPdf(pageIds?: string[]): Promise<BuiltPdf> {
  const pages = pageIds
    ? pageIds.map((id) => state.pages.find((page) => page.id === id)).filter((page): page is PageItem => Boolean(page))
    : state.pages;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(state.fileName);
  doc.setProducer("Support PDF");
  doc.setCreator("Support PDF");

  const ctx: Ctx = { doc, fonts: new Map(), fallbackFont: null, images: new Map() };
  const sourceDocs = new Map<string, PDFDocument>();
  const redactions: Redaction[] = [];

  // Sao chép mỗi nguồn MỘT lần cho tất cả trang cần dùng để tài nguyên dùng chung (font, ảnh) không bị nhân bản.
  const wanted = new Map<string, number[]>();
  for (const page of pages) {
    if (page.sourceId) {
      const list = wanted.get(page.sourceId) ?? [];
      if (!list.includes(page.pageIndex)) {
        list.push(page.pageIndex);
      }
      wanted.set(page.sourceId, list);
    }
  }
  const prepared = new Map<string, PDFPage>();
  for (const [sourceId, indexes] of wanted) {
    const source = state.sources.get(sourceId);
    if (!source) {
      continue;
    }
    const sourceDoc = await PDFDocument.load(source.bytes.slice(0), { updateMetadata: false });
    sourceDocs.set(sourceId, sourceDoc);
    const copies = await doc.copyPages(sourceDoc, indexes);
    indexes.forEach((pageIndex, position) => prepared.set(`${sourceId}:${pageIndex}`, copies[position]));
  }

  for (const [index, page] of pages.entries()) {
    let pdfPage: PDFPage;

    if (!page.sourceId) {
      pdfPage = doc.addPage([page.baseW, page.baseH]);
    } else {
      const key = `${page.sourceId}:${page.pageIndex}`;
      let copied = prepared.get(key);
      if (copied) {
        prepared.delete(key);
      } else {
        // Trang được nhân bản: cần một bản sao riêng để vẽ chỉnh sửa độc lập
        const sourceDoc = sourceDocs.get(page.sourceId);
        if (!sourceDoc) {
          continue;
        }
        [copied] = await doc.copyPages(sourceDoc, [page.pageIndex]);
      }
      pdfPage = doc.addPage(copied);
    }

    pdfPage.setRotation(degrees(totalRotation(page)));

    const drawable = [...page.overlays, ...decorOverlays(page, index, pages.length)];
    for (const overlay of drawable) {
      await drawOverlay(ctx, pdfPage, page, overlay);
      if (overlay.type === "redact") {
        redactions.push({
          pageIndex: index,
          rect: [overlay.x, overlay.y, overlay.x + overlay.w, overlay.y + overlay.h],
        });
      }
    }
  }

  return { bytes: await doc.save(), redactions };
}

export type PdfFinishOptions = {
  optimize?: boolean;
  password?: string;
  restrict?: boolean;
};

/** PDF hoàn chỉnh: gồm cả bước che vĩnh viễn / nén / mật khẩu nếu cần. */
export async function producePdf(pageIds?: string[], options: PdfFinishOptions = {}) {
  const { bytes, redactions } = await buildPdf(pageIds);
  if (!redactions.length && !options.optimize && !options.password) {
    return bytes;
  }

  const output = await api.finalize(bytes, {
    redactions,
    optimize: Boolean(options.optimize),
    password: options.password ?? "",
    restrict: Boolean(options.restrict),
  });
  return new Uint8Array(output);
}
