import { fontCss, textBox } from "./fonts";
import { pointsBounds } from "./geo";
import { state } from "./state";
import type { Overlay } from "./types";
import { escapeHtml } from "./util";

export const ARROW_ANGLE = (24 * Math.PI) / 180;
/** Chiều dài đầu mũi tên (pt) theo độ dày nét. */
export const arrowHeadLength = (strokeWidth: number) => Math.max(9, strokeWidth * 4.2);

const safeColor = (value: string, fallback = "#000000") =>
  /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;

const BOX_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export type RenderOptions = {
  selected: boolean;
  interactive: boolean;
};

export function arrowHeadPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  length: number,
): [number, number][] {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  return [
    [x2, y2],
    [x2 - length * Math.cos(angle - ARROW_ANGLE), y2 - length * Math.sin(angle - ARROW_ANGLE)],
    [x2 - length * Math.cos(angle + ARROW_ANGLE), y2 - length * Math.sin(angle + ARROW_ANGLE)],
  ];
}

/** Điểm bắt đầu thân mũi tên được lùi lại để không đè lên đầu mũi tên. */
export function arrowShaftEnd(x1: number, y1: number, x2: number, y2: number, length: number) {
  const distance = Math.hypot(x2 - x1, y2 - y1);
  if (distance < 0.001) {
    return [x2, y2] as const;
  }
  const back = Math.min(length * 0.8, distance);
  return [x2 - ((x2 - x1) / distance) * back, y2 - ((y2 - y1) / distance) * back] as const;
}

export function overlayHtml(overlay: Overlay, W: number, H: number, scale: number, options: RenderOptions) {
  const classes = `ov ov-${overlay.type} ${options.selected ? "selected" : ""} ${options.interactive ? "" : "ov-static"}`;
  const idAttr = options.interactive ? `data-ov="${overlay.id}"` : "";
  const handleHtml = (names: string[]) =>
    options.selected && options.interactive
      ? names.map((name) => `<i class="handle h-${name}" data-handle="${name}"></i>`).join("")
      : "";

  switch (overlay.type) {
    case "text": {
      const box = textBox(overlay.text, overlay.family, overlay.bold, overlay.italic, overlay.size);
      return `<div class="${classes}" ${idAttr} style="left:${overlay.x * W}px;top:${overlay.y * H}px;font-size:${overlay.size * scale}px;line-height:${box.lineHeight / overlay.size};color:${safeColor(overlay.color)};opacity:${overlay.opacity};${fontCss(overlay.family, overlay.bold, overlay.italic)}transform:rotate(${overlay.angle}deg);">`
        + `<span class="ov-text-body">${escapeHtml(overlay.text) || "&#8203;"}</span>${handleHtml(["scale"])}</div>`;
    }

    case "cover":
    case "redact":
    case "highlight": {
      const background = overlay.type === "redact" ? "#000" : safeColor(overlay.color, "#ffffff");
      const label = overlay.type === "redact" && overlay.w * W > 110 && overlay.h * H > 20
        ? `<span class="ov-label">Che vĩnh viễn</span>`
        : "";
      return `<div class="${classes}" ${idAttr} style="left:${overlay.x * W}px;top:${overlay.y * H}px;width:${overlay.w * W}px;height:${overlay.h * H}px;background:${background};opacity:${overlay.opacity};">${label}${handleHtml(BOX_HANDLES)}</div>`;
    }

    case "rect":
    case "ellipse": {
      const bw = Math.max(overlay.w * W, 1);
      const bh = Math.max(overlay.h * H, 1);
      const sw = overlay.strokeWidth * scale;
      const fill = overlay.fill ? safeColor(overlay.fill) : "none";
      const stroke = safeColor(overlay.stroke);
      const shape = overlay.type === "rect"
        ? (extra: string) => `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(bw - sw, 1)}" height="${Math.max(bh - sw, 1)}" ${extra}/>`
        : (extra: string) => `<ellipse cx="${bw / 2}" cy="${bh / 2}" rx="${Math.max((bw - sw) / 2, 0.5)}" ry="${Math.max((bh - sw) / 2, 0.5)}" ${extra}/>`;
      return `<div class="${classes}" ${idAttr} style="left:${overlay.x * W}px;top:${overlay.y * H}px;width:${bw}px;height:${bh}px;opacity:${overlay.opacity};">`
        + `<svg width="${bw}" height="${bh}" viewBox="0 0 ${bw} ${bh}" overflow="visible">`
        + shape(`fill="${fill}" stroke="${stroke}" stroke-width="${sw}" class="shape-main"`)
        + shape(`fill="none" stroke="transparent" stroke-width="${Math.max(14, sw)}" class="hit"`)
        + `</svg>${handleHtml(BOX_HANDLES)}</div>`;
    }

    case "line":
    case "arrow": {
      const sw = overlay.strokeWidth * scale;
      const pad = Math.max(sw * 3, 14) + (overlay.type === "arrow" ? arrowHeadLength(overlay.strokeWidth) * scale : 0);
      const left = Math.min(overlay.x1, overlay.x2) * W - pad;
      const top = Math.min(overlay.y1, overlay.y2) * H - pad;
      const bw = Math.abs(overlay.x2 - overlay.x1) * W + pad * 2;
      const bh = Math.abs(overlay.y2 - overlay.y1) * H + pad * 2;
      const px1 = overlay.x1 * W - left;
      const py1 = overlay.y1 * H - top;
      const px2 = overlay.x2 * W - left;
      const py2 = overlay.y2 * H - top;
      const stroke = safeColor(overlay.stroke);
      let shaftX = px2;
      let shaftY = py2;
      let head = "";
      if (overlay.type === "arrow") {
        const length = arrowHeadLength(overlay.strokeWidth) * scale;
        [shaftX, shaftY] = arrowShaftEnd(px1, py1, px2, py2, length);
        head = `<polygon points="${arrowHeadPoints(px1, py1, px2, py2, length).map((point) => point.join(",")).join(" ")}" fill="${stroke}" stroke="${stroke}" stroke-width="${sw * 0.4}" stroke-linejoin="round"/>`;
      }
      const handles = options.selected && options.interactive
        ? `<i class="handle h-point" data-handle="p1" style="left:${px1}px;top:${py1}px"></i><i class="handle h-point" data-handle="p2" style="left:${px2}px;top:${py2}px"></i>`
        : "";
      return `<div class="${classes}" ${idAttr} style="left:${left}px;top:${top}px;width:${bw}px;height:${bh}px;opacity:${overlay.opacity};">`
        + `<svg width="${bw}" height="${bh}" viewBox="0 0 ${bw} ${bh}">`
        + `<line x1="${px1}" y1="${py1}" x2="${shaftX}" y2="${shaftY}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" class="shape-main"/>`
        + head
        + `<line x1="${px1}" y1="${py1}" x2="${px2}" y2="${py2}" stroke="transparent" stroke-width="${Math.max(14, sw)}" class="hit"/>`
        + `</svg>${handles}</div>`;
    }

    case "pen": {
      const sw = overlay.strokeWidth * scale;
      const pad = sw + 6;
      const bounds = pointsBounds(overlay.points);
      const left = bounds.minX * W - pad;
      const top = bounds.minY * H - pad;
      const bw = (bounds.maxX - bounds.minX) * W + pad * 2;
      const bh = (bounds.maxY - bounds.minY) * H + pad * 2;
      let path = "";
      for (let index = 0; index < overlay.points.length; index += 2) {
        path += `${index === 0 ? "M" : "L"}${(overlay.points[index] * W - left).toFixed(2)} ${(overlay.points[index + 1] * H - top).toFixed(2)} `;
      }
      if (overlay.points.length === 2) {
        path += `L${(overlay.points[0] * W - left + 0.01).toFixed(2)} ${(overlay.points[1] * H - top).toFixed(2)}`;
      }
      const stroke = safeColor(overlay.stroke);
      return `<div class="${classes}" ${idAttr} style="left:${left}px;top:${top}px;width:${bw}px;height:${bh}px;opacity:${overlay.opacity};">`
        + `<svg width="${bw}" height="${bh}" viewBox="0 0 ${bw} ${bh}">`
        + `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" class="shape-main"/>`
        + `<path d="${path}" fill="none" stroke="transparent" stroke-width="${Math.max(14, sw)}" stroke-linecap="round" stroke-linejoin="round" class="hit"/>`
        + `</svg></div>`;
    }

    case "image": {
      const asset = state.images.get(overlay.imageId);
      const width = overlay.wPt * scale;
      return `<div class="${classes}" ${idAttr} style="left:${overlay.x * W}px;top:${overlay.y * H}px;width:${width}px;height:${width * overlay.aspect}px;opacity:${overlay.opacity};transform:rotate(${overlay.angle}deg);">`
        + (asset ? `<img src="${asset.url}" alt="" draggable="false"/>` : "")
        + `${handleHtml(["scale"])}</div>`;
    }
  }
}
