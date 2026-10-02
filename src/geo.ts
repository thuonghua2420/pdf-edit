import type { Overlay } from "./types";

/** Xoay overlay 90° theo chiều kim đồng hồ cùng với trang (toạ độ chuẩn hoá). */
export function rotateOverlayCW(overlay: Overlay) {
  const map = (x: number, y: number): [number, number] => [1 - y, x];

  switch (overlay.type) {
    case "text":
    case "image": {
      [overlay.x, overlay.y] = map(overlay.x, overlay.y);
      overlay.angle = (overlay.angle + 90) % 360;
      break;
    }
    case "cover":
    case "redact":
    case "highlight":
    case "rect":
    case "ellipse": {
      const { x, y, w, h } = overlay;
      overlay.x = 1 - (y + h);
      overlay.y = x;
      overlay.w = h;
      overlay.h = w;
      break;
    }
    case "line":
    case "arrow": {
      [overlay.x1, overlay.y1] = map(overlay.x1, overlay.y1);
      [overlay.x2, overlay.y2] = map(overlay.x2, overlay.y2);
      break;
    }
    case "pen": {
      for (let index = 0; index < overlay.points.length; index += 2) {
        const [x, y] = map(overlay.points[index], overlay.points[index + 1]);
        overlay.points[index] = x;
        overlay.points[index + 1] = y;
      }
      break;
    }
  }
}

export function moveOverlay(overlay: Overlay, dx: number, dy: number) {
  switch (overlay.type) {
    case "line":
    case "arrow":
      overlay.x1 += dx;
      overlay.x2 += dx;
      overlay.y1 += dy;
      overlay.y2 += dy;
      break;
    case "pen":
      for (let index = 0; index < overlay.points.length; index += 2) {
        overlay.points[index] += dx;
        overlay.points[index + 1] += dy;
      }
      break;
    default:
      overlay.x += dx;
      overlay.y += dy;
  }
}

/** Hộp bao (chuẩn hoá) của overlay dạng đường/nét; null với loại không cần. */
export function pointsBounds(points: number[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < points.length; index += 2) {
    minX = Math.min(minX, points[index]);
    maxX = Math.max(maxX, points[index]);
    minY = Math.min(minY, points[index + 1]);
    maxY = Math.max(maxY, points[index + 1]);
  }
  return { minX, minY, maxX, maxY };
}

export function normalizeRect(x0: number, y0: number, x1: number, y1: number) {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

/** Làm mượt nét vẽ tay bằng thuật toán Chaikin (1 lượt) sau khi lọc điểm gần nhau. */
export function smoothStroke(points: number[], minDistance: number) {
  const filtered: number[] = [];
  for (let index = 0; index < points.length; index += 2) {
    const x = points[index];
    const y = points[index + 1];
    const lastX = filtered[filtered.length - 2];
    const lastY = filtered[filtered.length - 1];
    if (
      filtered.length === 0
      || Math.hypot(x - lastX, y - lastY) >= minDistance
      || index === points.length - 2
    ) {
      filtered.push(x, y);
    }
  }

  if (filtered.length < 6) {
    return filtered;
  }

  const result: number[] = [filtered[0], filtered[1]];
  for (let index = 0; index < filtered.length - 2; index += 2) {
    const x0 = filtered[index];
    const y0 = filtered[index + 1];
    const x1 = filtered[index + 2];
    const y1 = filtered[index + 3];
    result.push(x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25);
    result.push(x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75);
  }
  result.push(filtered[filtered.length - 2], filtered[filtered.length - 1]);
  return result;
}
