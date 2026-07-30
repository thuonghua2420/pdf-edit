import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mupdf from "mupdf";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.join(projectRoot, "dist");
const port = Number(process.env.PDF_SERVER_PORT || 8787);
const maxBodyBytes = 80 * 1024 * 1024;

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

function sendPdf(response, bytes, fileName) {
  response.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
  });
  response.end(bytes);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(new Error("File PDF quá lớn. Giới hạn hiện tại là 60 MB."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Dữ liệu gửi lên không hợp lệ."));
      }
    });

    request.on("error", reject);
  });
}

function numberInRange(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}

function findFontPath(style = {}) {
  const windowsFonts = process.env.WINDIR
    ? path.join(process.env.WINDIR, "Fonts")
    : "C:\\Windows\\Fonts";
  const serifCandidates = [
    style.bold && style.italic ? path.join(windowsFonts, "timesbi.ttf") : null,
    style.bold ? path.join(windowsFonts, "timesbd.ttf") : null,
    style.italic ? path.join(windowsFonts, "timesi.ttf") : null,
    path.join(windowsFonts, "times.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  ];
  const sansCandidates = [
    style.bold && style.italic ? path.join(windowsFonts, "arialbi.ttf") : null,
    style.bold ? path.join(windowsFonts, "arialbd.ttf") : null,
    style.italic ? path.join(windowsFonts, "ariali.ttf") : null,
    path.join(windowsFonts, "arial.ttf"),
    path.join(windowsFonts, "segoeui.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ];
  const fontCandidates = style.serif === false
    ? [...sansCandidates, ...serifCandidates]
    : [...serifCandidates, ...sansCandidates];
  const candidates = [process.env.PDF_FONT_PATH, ...fontCandidates].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function encodeText(font, text) {
  return Array.from(text)
    .map((character) => {
      const glyph = font.encodeCharacter(character);
      return glyph.toString(16).padStart(4, "0");
    })
    .join("");
}

function parseColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value || "#111827"));
  if (!match) {
    return [0.067, 0.094, 0.153];
  }

  const number = Number.parseInt(match[1], 16);
  return [
    ((number >> 16) & 255) / 255,
    ((number >> 8) & 255) / 255,
    (number & 255) / 255,
  ];
}

function rectFromQuad(quad, bounds) {
  const xValues = [quad[0], quad[2], quad[4], quad[6]];
  const yValues = [quad[1], quad[3], quad[5], quad[7]];
  return [
    Math.max(bounds[0], Math.min(...xValues)),
    Math.max(bounds[1], Math.min(...yValues)),
    Math.min(bounds[2], Math.max(...xValues)),
    Math.min(bounds[3], Math.max(...yValues)),
  ];
}

function rectDistance(left, right) {
  return Math.hypot(
    (left[0] + left[2]) / 2 - (right[0] + right[2]) / 2,
    (left[1] + left[3]) / 2 - (right[1] + right[3]) / 2,
  );
}

function unionRects(rects, bounds) {
  return rects.reduce(
    (accumulator, rect) => [
      Math.min(accumulator[0], rect[0]),
      Math.min(accumulator[1], rect[1]),
      Math.max(accumulator[2], rect[2]),
      Math.max(accumulator[3], rect[3]),
    ],
    [bounds[2], bounds[3], bounds[0], bounds[1]],
  );
}

function median(values) {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function mostCommonBoolean(values, fallback) {
  if (!values.length) {
    return fallback;
  }

  const trueCount = values.filter(Boolean).length;
  return trueCount >= values.length - trueCount;
}

function collectTextChars(page, bounds, pageHeight) {
  const chars = [];

  page.toStructuredText().walk({
    onChar(character, origin, font, size, quad) {
      const rect = rectFromQuad(quad, bounds);
      chars.push({
        character,
        rect,
        size,
        baseline: pageHeight - origin[1],
        style: {
          bold: font.isBold(),
          italic: font.isItalic(),
          serif: font.isSerif(),
        },
      });
    },
  });

  return chars;
}

function rectContainsPoint(rect, point) {
  return point[0] >= rect[0] && point[0] <= rect[2] && point[1] >= rect[1] && point[1] <= rect[3];
}

function summarizeMatchedChars(chars, rect, bounds) {
  const visibleChars = chars.filter((char) => char.character.trim());
  const metricChars = visibleChars.length ? visibleChars : chars;
  const sizes = metricChars.map((char) => char.size).filter(Number.isFinite);
  const baselines = metricChars.map((char) => char.baseline).filter(Number.isFinite);
  const styles = metricChars.map((char) => char.style);

  return {
    rect: chars.length ? unionRects(chars.map((char) => char.rect), bounds) : rect,
    fontSize: median(sizes),
    baseline: median(baselines),
    style: {
      bold: mostCommonBoolean(styles.map((style) => style.bold), false),
      italic: mostCommonBoolean(styles.map((style) => style.italic), false),
      serif: mostCommonBoolean(styles.map((style) => style.serif), true),
    },
  };
}

function summarizeCharsInsideRect(chars, rect, bounds) {
  const paddedRect = [rect[0] - 0.5, rect[1] - 0.5, rect[2] + 0.5, rect[3] + 0.5];
  const matchedChars = chars.filter((char) => {
    const center = [(char.rect[0] + char.rect[2]) / 2, (char.rect[1] + char.rect[3]) / 2];
    return rectContainsPoint(paddedRect, center);
  });

  return summarizeMatchedChars(matchedChars, rect, bounds);
}

function matchStructuredText(chars, originalText, targetRect, bounds) {
  const needles = Array.from(new Set([
    String(originalText || ""),
    String(originalText || "").trim(),
  ])).filter(Boolean);
  const candidates = [];

  for (const needle of needles) {
    const needleChars = Array.from(needle);
    if (!needleChars.length || needleChars.length > chars.length) {
      continue;
    }

    for (let index = 0; index <= chars.length - needleChars.length; index += 1) {
      const matches = needleChars.every(
        (character, offset) => chars[index + offset]?.character === character,
      );

      if (matches) {
        const matchedChars = chars.slice(index, index + needleChars.length);
        candidates.push(summarizeMatchedChars(matchedChars, targetRect, bounds));
      }
    }
  }

  return candidates.sort((left, right) => rectDistance(left.rect, targetRect) - rectDistance(right.rect, targetRect))[0] || null;
}

function findTextMetrics(page, originalText, fallbackRect, bounds, pageHeight) {
  const chars = collectTextChars(page, bounds, pageHeight);
  const structuredMatch = matchStructuredText(chars, originalText, fallbackRect, bounds);

  if (structuredMatch) {
    return structuredMatch;
  }

  if (!originalText?.trim()) {
    return summarizeCharsInsideRect(chars, fallbackRect, bounds);
  }

  const groups = page.search(originalText, 100);
  if (!groups.length) {
    return summarizeCharsInsideRect(chars, fallbackRect, bounds);
  }

  const candidates = groups.map((quads) => {
    const rects = quads.map((quad) => rectFromQuad(quad, bounds));
    const rect = unionRects(rects, bounds);
    const metrics = summarizeCharsInsideRect(chars, rect, bounds);

    return {
      ...metrics,
      rect,
    };
  });

  return candidates.sort((left, right) => {
    return rectDistance(left.rect, fallbackRect) - rectDistance(right.rect, fallbackRect);
  })[0];
}

function uniquePdfResourceName(dictionary, baseName) {
  let index = 0;
  let name = baseName;

  while (!dictionary.get(name).isNull()) {
    index += 1;
    name = `${baseName}${index}`;
  }

  return name;
}

function ensureFontResources(document, pageObject, font) {
  let resources = pageObject.getInheritable("Resources");
  if (resources.isNull()) {
    resources = document.addObject(document.newDictionary());
    pageObject.put("Resources", resources);
  } else if (resources.isIndirect()) {
    resources = resources.resolve();
  }

  let fonts = resources.get("Font");
  if (fonts.isNull()) {
    fonts = document.addObject(document.newDictionary());
    resources.put("Font", fonts);
  } else if (fonts.isIndirect()) {
    fonts = fonts.resolve();
  }

  const fontResource = document.addFont(font);
  const fontName = uniquePdfResourceName(fonts, "SupportPdfReplace");
  fonts.put(fontName, fontResource);

  return fontName;
}

function appendTextContent(document, pageObject, text, font, fontName, rect, pageHeight, fontSize, color, coverColor, baseline) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const [x0, top, x1, bottom] = rect;
  const textBaseline = Number.isFinite(baseline) ? baseline : pageHeight - bottom + fontSize * 0.22;
  const [red, green, blue] = color;
  const commands = [
    "q",
    `${coverColor[0]} ${coverColor[1]} ${coverColor[2]} rg`,
    `${x0} ${pageHeight - bottom} ${x1 - x0} ${bottom - top} re`,
    "f",
    `${red} ${green} ${blue} rg`,
    "BT",
    `/${fontName} ${fontSize} Tf`,
    `${x0} ${textBaseline} Td`,
  ];

  lines.forEach((line, index) => {
    if (index > 0) {
      commands.push(`0 -${fontSize * 1.2} Td`);
    }
    commands.push(`<${encodeText(font, line)}> Tj`);
  });

  commands.push("ET", "Q");
  const stream = document.addStream(commands.join("\n"));
  const oldContents = pageObject.get("Contents");
  const resolvedContents = oldContents.isIndirect() ? oldContents.resolve() : oldContents;

  if (oldContents.isNull()) {
    pageObject.put("Contents", stream);
  } else if (resolvedContents.isArray()) {
    resolvedContents.push(stream);
  } else {
    pageObject.put("Contents", [oldContents, stream]);
  }
}

function editText(payload) {
  if (typeof payload.pdfBase64 !== "string" || !payload.pdfBase64) {
    throw new Error("Thiếu file PDF.");
  }

  const pageIndex = Number(payload.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error("Trang PDF không hợp lệ.");
  }

  const input = Buffer.from(payload.pdfBase64, "base64");
  const document = mupdf.Document.openDocument(input, "application/pdf").asPDF();
  if (!document) {
    throw new Error("File không phải PDF hợp lệ.");
  }
  if (pageIndex >= document.countPages()) {
    throw new Error("Trang PDF không tồn tại.");
  }

  const page = document.loadPage(pageIndex);
  const bounds = page.getBounds();
  const pageWidth = bounds[2] - bounds[0];
  const pageHeight = bounds[3] - bounds[1];
  const inputRect = Array.isArray(payload.rect) ? payload.rect : [];
  const x0 = numberInRange(inputRect[0], 0, 1, 0);
  const y0 = numberInRange(inputRect[1], 0, 1, 0);
  const x1 = numberInRange(inputRect[2], x0, 1, 1);
  const y1 = numberInRange(inputRect[3], y0, 1, 1);
  const paddingX = Math.max(1.5, (x1 - x0) * pageWidth * 0.01);
  const paddingY = Math.max(3.5, (y1 - y0) * pageHeight * 0.2);
  const fallbackRect = [
    Math.max(bounds[0], bounds[0] + x0 * pageWidth - paddingX),
    Math.max(bounds[1], bounds[1] + y0 * pageHeight - paddingY),
    Math.min(bounds[2], bounds[0] + x1 * pageWidth + paddingX),
    Math.min(bounds[3], bounds[1] + y1 * pageHeight + paddingY),
  ];
  const metrics = findTextMetrics(page, String(payload.originalText ?? ""), fallbackRect, bounds, pageHeight);
  const rect = metrics.rect || fallbackRect;
  const replacement = String(payload.text ?? "");
  if (!replacement.trim()) {
    throw new Error("Text thay thế không được để trống.");
  }

  const redaction = page.createAnnotation("Redact");
  redaction.setRect(rect);
  redaction.update();
  redaction.applyRedaction(
    0,
    mupdf.PDFPage.REDACT_IMAGE_NONE,
    mupdf.PDFPage.REDACT_LINE_ART_NONE,
    mupdf.PDFPage.REDACT_TEXT_REMOVE,
  );

  const fontPath = findFontPath(metrics.style);
  const font = fontPath
    ? new mupdf.Font("SupportPdfFont", fontPath)
    : new mupdf.Font("Helvetica");
  const pageObject = page.getObject();
  const fontName = ensureFontResources(document, pageObject, font);
  const measuredFontSize = numberInRange(metrics.fontSize, 4, 144, Math.max(6, Math.min(96, (rect[3] - rect[1]) * 0.9)));
  const fontSize = payload.autoFontSize === false
    ? numberInRange(payload.fontSize, 4, 144, measuredFontSize)
    : measuredFontSize;
  appendTextContent(
    document,
    pageObject,
    replacement,
    font,
    fontName,
    rect,
    pageHeight,
    fontSize,
    parseColor(payload.color),
    parseColor(payload.coverColor || "#ffffff"),
    metrics.baseline,
  );

  return Buffer.from(document.saveToBuffer({ garbage: 0 }).asUint8Array());
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
  }[extension] || "application/octet-stream";
}

function serveStatic(request, response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(staticRoot, requested));
  if (!filePath.startsWith(staticRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.writeHead(200, { "Content-Type": contentType(filePath) });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    });
    response.end();
    return;
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { ok: true, engine: "MuPDF.js" });
    return;
  }

  if (url.pathname === "/api/edit-text" && request.method === "POST") {
    try {
      const payload = await readJson(request);
      const output = editText(payload);
      sendPdf(response, output, "edited-text.pdf");
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Không thể sửa text PDF.",
      });
    }
    return;
  }

  if (request.method === "GET") {
    serveStatic(request, response, url.pathname);
    return;
  }

  sendJson(response, 405, { error: "Method không được hỗ trợ." });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`PDF engine listening on http://127.0.0.1:${port}`);
});
