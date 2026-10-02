import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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

function contentDisposition(fileName) {
  const rawName = String(fileName || "download")
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  const utf8Name = Buffer.from(rawName || "download", "utf8").toString("utf8");
  const asciiName = utf8Name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^\x20-\x7e]/g, "-")
    .replace(/["\\;]/g, "-")
    .slice(0, 180)
    .trim() || "download";
  const encodedName = encodeURIComponent(utf8Name)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

function sendPdf(response, bytes, fileName) {
  response.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": contentDisposition(fileName),
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
  });
  response.end(bytes);
}

function sendBinary(response, bytes, contentTypeValue, fileName) {
  response.writeHead(200, {
    "Content-Type": contentTypeValue,
    "Content-Disposition": contentDisposition(fileName),
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

function sanitizeFileBaseName(name, fallback = "output") {
  const base = path.basename(String(name || fallback)).replace(/\.[^.]+$/, "");
  const clean = base.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").trim();
  return clean || fallback;
}

function sanitizeExtension(name, allowed, fallback) {
  const extension = path.extname(String(name || "")).toLowerCase();
  return allowed.includes(extension) ? extension : fallback;
}

function tempWorkDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(directory, prefix) {
  const resolved = path.resolve(directory);
  const expectedRoot = path.resolve(os.tmpdir());
  if (path.basename(resolved).startsWith(prefix) && resolved.startsWith(expectedRoot)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

function libreOfficeCandidates() {
  return Array.from(new Set([
    process.env.LIBREOFFICE_PATH,
    "soffice",
    "libreoffice",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/libreoffice",
    "/usr/local/bin/libreoffice",
  ].filter(Boolean)));
}

function powershellCandidates() {
  if (process.platform !== "win32") {
    return [];
  }

  const windowsRoot = process.env.SystemRoot || "C:\\Windows";
  return Array.from(new Set([
    "powershell.exe",
    path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ]));
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
    });
    const chunks = [];
    const errorChunks = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Quá thời gian chuyển đổi. Hãy thử file nhỏ hơn."));
    }, options.timeoutMs || 120000);

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errorChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString("utf8");
      const stderr = Buffer.concat(errorChunks).toString("utf8");
      if (code === 0) {
        resolve({ output, stderr });
        return;
      }
      reject(new Error(stderr || output || `Tiến trình chuyển đổi kết thúc với mã lỗi ${code}.`));
    });
  });
}

async function convertWithMicrosoftWord(inputPath, outputPath, workDir) {
  const scriptPath = path.join(workDir, "convert-word.ps1");
  fs.writeFileSync(scriptPath, `param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"
$word = $null
$document = $null

try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  try { $word.AutomationSecurity = 3 } catch {}
  $document = $word.Documents.Open($InputPath, $false, $true)
  $document.ExportAsFixedFormat($OutputPath, 17)
  if (-not (Test-Path -LiteralPath $OutputPath)) {
    throw "Microsoft Word không tạo file PDF đầu ra."
  }
}
finally {
  if ($null -ne $document) {
    $document.Close()
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
  }
  if ($null -ne $word) {
    $word.Quit()
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`, "utf8");

  let lastError = null;
  for (const command of powershellCandidates()) {
    try {
      if (command.includes(path.sep) && !fs.existsSync(command)) {
        continue;
      }
      await runProcess(command, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-InputPath",
        inputPath,
        "-OutputPath",
        outputPath,
      ], { timeoutMs: 180000 });

      if (!fs.existsSync(outputPath)) {
        throw new Error("Microsoft Word không tạo file PDF đầu ra.");
      }
      return fs.readFileSync(outputPath);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Không thể khởi động Microsoft Word để chuyển đổi.");
}

async function convertWithLibreOffice(inputPath, outputDir, baseName) {
  let lastError = null;
  for (const command of libreOfficeCandidates()) {
    try {
      if ((command.includes(path.sep) || command.includes("/") || command.includes("\\")) && !fs.existsSync(command)) {
        continue;
      }
      await runProcess(command, [
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--convert-to",
        "pdf",
        "--outdir",
        outputDir,
        inputPath,
      ], { timeoutMs: 120000 });

      const expectedOutputPath = path.join(outputDir, `${baseName}.pdf`);
      const fallbackOutputPath = fs.readdirSync(outputDir)
        .map((fileName) => path.join(outputDir, fileName))
        .find((filePath) => filePath.toLowerCase().endsWith(".pdf"));
      const outputPath = fs.existsSync(expectedOutputPath) ? expectedOutputPath : fallbackOutputPath;
      if (!outputPath) {
        throw new Error("LibreOffice không tạo file PDF đầu ra.");
      }

      return fs.readFileSync(outputPath);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Không tìm thấy LibreOffice/soffice.");
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pageIndexesFromRange(range, pageCount) {
  const raw = String(range || "all").trim().toLowerCase();
  if (!raw || raw === "all") {
    return Array.from({ length: pageCount }, (_, index) => index);
  }

  const indexes = new Set();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) {
      continue;
    }

    const rangeMatch = /^(\d+)\s*-\s*(\d+|end)$/.exec(token);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = rangeMatch[2] === "end" ? pageCount : Number(rangeMatch[2]);
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      for (let page = from; page <= to; page += 1) {
        if (page >= 1 && page <= pageCount) {
          indexes.add(page - 1);
        }
      }
      continue;
    }

    const page = Number(token);
    if (Number.isInteger(page) && page >= 1 && page <= pageCount) {
      indexes.add(page - 1);
    }
  }

  return [...indexes].sort((left, right) => left - right);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime();

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
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

function pdfToImages(payload) {
  if (typeof payload.pdfBase64 !== "string" || !payload.pdfBase64) {
    throw new Error("Thiếu file PDF.");
  }

  const input = Buffer.from(payload.pdfBase64, "base64");
  const document = mupdf.Document.openDocument(input, "application/pdf");
  const pageCount = document.countPages();
  const pageIndexes = pageIndexesFromRange(payload.pageRange, pageCount);
  if (!pageIndexes.length) {
    throw new Error("Không có trang PDF hợp lệ để chuyển đổi.");
  }
  if (pageIndexes.length > 80) {
    throw new Error("Tạm thời giới hạn tối đa 80 trang mỗi lần xuất ảnh.");
  }

  const format = String(payload.format || "png").toLowerCase() === "jpg" ? "jpg" : "png";
  const dpi = numberInRange(payload.dpi, 72, 300, 150);
  const quality = Math.round(numberInRange(payload.quality, 40, 100, 90));
  const scale = dpi / 72;
  const baseName = sanitizeFileBaseName(payload.fileName, "pdf-pages");
  const extension = format === "jpg" ? "jpg" : "png";
  const entries = pageIndexes.map((pageIndex) => {
    const page = document.loadPage(pageIndex);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    pixmap.setResolution(dpi, dpi);
    const imageBytes = format === "jpg"
      ? pixmap.asJPEG(quality)
      : pixmap.asPNG();

    return {
      name: `${baseName}-page-${String(pageIndex + 1).padStart(3, "0")}.${extension}`,
      data: Buffer.from(imageBytes),
    };
  });

  return createZip(entries);
}

function docxParagraph(text) {
  const content = xmlEscape(text);
  if (!content) {
    return "<w:p/>";
  }

  return `<w:p><w:r><w:t xml:space="preserve">${content}</w:t></w:r></w:p>`;
}

function docxPageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function createDocxFromPages(pages, title) {
  const paragraphs = [];

  pages.forEach((pageText, pageIndex) => {
    const lines = String(pageText || "").replace(/\r\n?/g, "\n").split("\n");
    lines.forEach((line) => {
      paragraphs.push(docxParagraph(line));
    });
    if (pageIndex < pages.length - 1) {
      paragraphs.push(docxPageBreak());
    }
  });

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.join("\n")}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
      <w:sz w:val="24"/>
    </w:rPr>
  </w:style>
</w:styles>`;
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
  const packageRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:creator>Support PDF</dc:creator>
  <cp:lastModifiedBy>Support PDF</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`;
  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Support PDF</Application>
</Properties>`;

  return createZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypesXml, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(packageRelsXml, "utf8") },
    { name: "docProps/core.xml", data: Buffer.from(coreXml, "utf8") },
    { name: "docProps/app.xml", data: Buffer.from(appXml, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(documentRelsXml, "utf8") },
    { name: "word/styles.xml", data: Buffer.from(stylesXml, "utf8") },
  ]);
}

function docxImageAnchor(page, relationshipId, imageName, imageIndex, breakAfter) {
  const widthEmu = Math.round(page.widthPt * 12700);
  const heightEmu = Math.round(page.heightPt * 12700);
  const pageBreak = breakAfter ? '<w:r><w:br w:type="page"/></w:r>' : "";

  return `<w:p>
  <w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
  <w:r>
    <w:drawing>
      <wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251658240 + imageIndex}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">
        <wp:simplePos x="0" y="0"/>
        <wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>
        <wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>
        <wp:extent cx="${widthEmu}" cy="${heightEmu}"/>
        <wp:effectExtent l="0" t="0" r="0" b="0"/>
        <wp:wrapNone/>
        <wp:docPr id="${imageIndex + 1}" name="PDF page ${imageIndex + 1}"/>
        <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic>
              <pic:nvPicPr>
                <pic:cNvPr id="${imageIndex + 1}" name="${xmlEscape(imageName)}"/>
                <pic:cNvPicPr/>
              </pic:nvPicPr>
              <pic:blipFill>
                <a:blip r:embed="${relationshipId}" cstate="print"/>
                <a:stretch><a:fillRect/></a:stretch>
              </pic:blipFill>
              <pic:spPr>
                <a:xfrm>
                  <a:off x="0" y="0"/>
                  <a:ext cx="${widthEmu}" cy="${heightEmu}"/>
                </a:xfrm>
                <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
              </pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:anchor>
    </w:drawing>
  </w:r>
  ${pageBreak}
</w:p>`;
}

function createDocxFromPageImages(pages, title) {
  const firstPage = pages[0] || { widthPt: 595.28, heightPt: 841.89 };
  const pageWidthTwips = Math.round(firstPage.widthPt * 20);
  const pageHeightTwips = Math.round(firstPage.heightPt * 20);
  const imageParagraphs = pages.map((page, index) => {
    const relationshipId = `rId${index + 3}`;
    const imageName = `page-${String(index + 1).padStart(3, "0")}.png`;
    return docxImageAnchor(page, relationshipId, imageName, index, index < pages.length - 1);
  });
  const imageRelationships = pages.map((_, index) => {
    const relationshipId = `rId${index + 3}`;
    const imageName = `media/page-${String(index + 1).padStart(3, "0")}.png`;
    return `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${imageName}"/>`;
  });

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${imageParagraphs.join("\n")}
    <w:sectPr>
      <w:pgSz w:w="${pageWidthTwips}" w:h="${pageHeightTwips}"/>
      <w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>
  </w:style>
</w:styles>`;
  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:compat>
    <w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>
  </w:compat>
</w:settings>`;
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
  const packageRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  ${imageRelationships.join("\n  ")}
</Relationships>`;
  const now = new Date().toISOString();
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:creator>Support PDF</dc:creator>
  <cp:lastModifiedBy>Support PDF</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Support PDF</Application>
  <Pages>${pages.length}</Pages>
</Properties>`;
  const mediaEntries = pages.map((page, index) => ({
    name: `word/media/page-${String(index + 1).padStart(3, "0")}.png`,
    data: page.pngBytes,
  }));

  return createZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypesXml, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(packageRelsXml, "utf8") },
    { name: "docProps/core.xml", data: Buffer.from(coreXml, "utf8") },
    { name: "docProps/app.xml", data: Buffer.from(appXml, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(documentRelsXml, "utf8") },
    { name: "word/styles.xml", data: Buffer.from(stylesXml, "utf8") },
    { name: "word/settings.xml", data: Buffer.from(settingsXml, "utf8") },
    ...mediaEntries,
  ]);
}

function createFixedLayoutDocx(document, pageIndexes, payload) {
  const dpi = numberInRange(payload.dpi, 96, 220, 150);
  const scale = dpi / 72;
  const pages = pageIndexes.map((pageIndex) => {
    const page = document.loadPage(pageIndex);
    const bounds = page.getBounds();
    const widthPt = bounds[2] - bounds[0];
    const heightPt = bounds[3] - bounds[1];
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    pixmap.setResolution(dpi, dpi);

    return {
      widthPt,
      heightPt,
      pngBytes: Buffer.from(pixmap.asPNG()),
    };
  });

  return createDocxFromPageImages(pages, sanitizeFileBaseName(payload.fileName, "converted"));
}

function pdfToWord(payload) {
  if (typeof payload.pdfBase64 !== "string" || !payload.pdfBase64) {
    throw new Error("Thiếu file PDF.");
  }

  const input = Buffer.from(payload.pdfBase64, "base64");
  const document = mupdf.Document.openDocument(input, "application/pdf");
  const pageCount = document.countPages();
  const pageIndexes = pageIndexesFromRange(payload.pageRange, pageCount);
  if (!pageIndexes.length) {
    throw new Error("Không có trang PDF hợp lệ để chuyển sang Word.");
  }

  if (String(payload.mode || "layout") !== "text") {
    return createFixedLayoutDocx(document, pageIndexes, payload);
  }

  const pages = pageIndexes.map((pageIndex) => {
    const page = document.loadPage(pageIndex);
    return page.toStructuredText().asText().trimEnd();
  });
  const hasText = pages.some((pageText) => pageText.trim());
  if (!hasText) {
    throw new Error("PDF này không có text layer. Cần thêm OCR ở phase sau để chuyển PDF scan sang Word.");
  }

  return createDocxFromPages(pages, sanitizeFileBaseName(payload.fileName, "converted"));
}

async function wordToPdf(payload) {
  if (typeof payload.fileBase64 !== "string" || !payload.fileBase64) {
    throw new Error("Thiếu file Word.");
  }

  const extension = sanitizeExtension(payload.fileName, [".doc", ".docx", ".rtf", ".odt"], ".docx");
  const baseName = sanitizeFileBaseName(payload.fileName, "word-file");
  const workDir = tempWorkDir("support-pdf-word-");
  const outputDir = path.join(workDir, "out");
  fs.mkdirSync(outputDir, { recursive: true });
  const inputPath = path.join(workDir, `${baseName}${extension}`);
  fs.writeFileSync(inputPath, Buffer.from(payload.fileBase64, "base64"));

  try {
    const errors = [];

    if (process.platform === "win32") {
      try {
        return await convertWithMicrosoftWord(
          inputPath,
          path.join(outputDir, `${baseName}.pdf`),
          workDir,
        );
      } catch (error) {
        errors.push(`Microsoft Word: ${error instanceof Error ? error.message : "không hoạt động"}`);
      }
    }

    try {
      return await convertWithLibreOffice(inputPath, outputDir, baseName);
    } catch (error) {
      errors.push(`LibreOffice: ${error instanceof Error ? error.message : "không hoạt động"}`);
    }

    throw new Error(`Không thể chuyển Word sang PDF. ${errors.join(" | ")}`);
  } finally {
    cleanupTempDir(workDir, "support-pdf-word-");
  }
}

const fontCatalog = [
  { id: "arial", label: "Arial", files: { r: "arial.ttf", b: "arialbd.ttf", i: "ariali.ttf", bi: "arialbi.ttf" } },
  { id: "times", label: "Times New Roman", files: { r: "times.ttf", b: "timesbd.ttf", i: "timesi.ttf", bi: "timesbi.ttf" } },
  { id: "courier", label: "Courier New", files: { r: "cour.ttf", b: "courbd.ttf", i: "couri.ttf", bi: "courbi.ttf" } },
  { id: "calibri", label: "Calibri", files: { r: "calibri.ttf", b: "calibrib.ttf", i: "calibrii.ttf", bi: "calibriz.ttf" } },
  { id: "georgia", label: "Georgia", files: { r: "georgia.ttf", b: "georgiab.ttf", i: "georgiai.ttf", bi: "georgiaz.ttf" } },
  { id: "tahoma", label: "Tahoma", files: { r: "tahoma.ttf", b: "tahomabd.ttf" } },
  { id: "verdana", label: "Verdana", files: { r: "verdana.ttf", b: "verdanab.ttf", i: "verdanai.ttf", bi: "verdanaz.ttf" } },
  { id: "segoe", label: "Segoe UI", files: { r: "segoeui.ttf", b: "segoeuib.ttf", i: "segoeuii.ttf", bi: "segoeuiz.ttf" } },
  { id: "dejavu", label: "DejaVu Sans", files: { r: "DejaVuSans.ttf", b: "DejaVuSans-Bold.ttf", i: "DejaVuSans-Oblique.ttf", bi: "DejaVuSans-BoldOblique.ttf" } },
  { id: "script-segoe", label: "Segoe Script", script: true, files: { r: "segoesc.ttf", b: "segoescb.ttf" } },
  { id: "script-ink", label: "Ink Free", script: true, files: { r: "Inkfree.ttf" } },
  { id: "script-brush", label: "Brush Script", script: true, files: { r: "BRUSHSCI.TTF" } },
  { id: "script-lucida", label: "Lucida Handwriting", script: true, files: { r: "LHANDW.TTF" } },
];

function fontDirectories() {
  const windowsFonts = process.env.WINDIR
    ? path.join(process.env.WINDIR, "Fonts")
    : "C:\\Windows\\Fonts";
  return [
    process.env.PDF_FONT_DIR,
    windowsFonts,
    path.join(os.homedir(), "AppData", "Local", "Microsoft", "Windows", "Fonts"),
    "/usr/share/fonts/truetype/dejavu",
    "/System/Library/Fonts/Supplemental",
    "/Library/Fonts",
  ].filter(Boolean);
}

function resolveFontFile(fileName) {
  if (!fileName) {
    return null;
  }
  for (const directory of fontDirectories()) {
    const candidate = path.join(directory, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveFont(familyId, bold, italic) {
  const family = fontCatalog.find((entry) => entry.id === familyId);
  if (!family) {
    return null;
  }
  const order = bold && italic
    ? ["bi", "b", "i", "r"]
    : bold ? ["b", "r"] : italic ? ["i", "r"] : ["r"];
  for (const key of order) {
    const found = resolveFontFile(family.files[key]);
    if (found) {
      return found;
    }
  }
  return null;
}

function listFonts() {
  return fontCatalog
    .filter((family) => resolveFontFile(family.files.r))
    .map((family) => ({
      id: family.id,
      label: family.label,
      script: Boolean(family.script),
      bold: Boolean(family.files.b && resolveFontFile(family.files.b)),
      italic: Boolean(family.files.i && resolveFontFile(family.files.i)),
    }));
}

function openPdf(payload, password) {
  if (typeof payload.pdfBase64 !== "string" || !payload.pdfBase64) {
    throw new Error("Thiếu file PDF.");
  }
  const input = Buffer.from(payload.pdfBase64, "base64");
  const document = mupdf.Document.openDocument(input, "application/pdf");
  if (document.needsPassword()) {
    if (!password) {
      const error = new Error("PDF này được bảo vệ bằng mật khẩu.");
      error.code = "PASSWORD_REQUIRED";
      throw error;
    }
    if (!document.authenticatePassword(String(password))) {
      const error = new Error("Mật khẩu không đúng.");
      error.code = "PASSWORD_WRONG";
      throw error;
    }
  }
  const pdf = document.asPDF();
  if (!pdf) {
    throw new Error("File không phải PDF hợp lệ.");
  }
  return pdf;
}

function unlockPdf(payload) {
  const document = openPdf(payload, payload.password);
  return Buffer.from(document.saveToBuffer("garbage=1,compress,encrypt=none").asUint8Array());
}

// Hoàn tất PDF: che vùng nhạy cảm (xóa thật nội dung bên dưới), tối ưu dung lượng, đặt mật khẩu.
function finalizePdf(payload) {
  const document = openPdf(payload);
  const redactions = Array.isArray(payload.redactions) ? payload.redactions : [];
  const pageCount = document.countPages();
  const byPage = new Map();

  for (const item of redactions) {
    const pageIndex = Number(item?.pageIndex);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount || !Array.isArray(item.rect)) {
      continue;
    }
    if (!byPage.has(pageIndex)) {
      byPage.set(pageIndex, []);
    }
    byPage.get(pageIndex).push(item.rect);
  }

  for (const [pageIndex, rects] of byPage) {
    const page = document.loadPage(pageIndex);
    const bounds = page.getBounds();
    const pageWidth = bounds[2] - bounds[0];
    const pageHeight = bounds[3] - bounds[1];

    for (const rawRect of rects) {
      const x0 = numberInRange(rawRect[0], 0, 1, 0);
      const y0 = numberInRange(rawRect[1], 0, 1, 0);
      const x1 = numberInRange(rawRect[2], x0, 1, 1);
      const y1 = numberInRange(rawRect[3], y0, 1, 1);
      const annotation = page.createAnnotation("Redact");
      annotation.setRect([
        bounds[0] + x0 * pageWidth,
        bounds[1] + y0 * pageHeight,
        bounds[0] + x1 * pageWidth,
        bounds[1] + y1 * pageHeight,
      ]);
      annotation.update();
    }

    page.applyRedactions(
      true,
      mupdf.PDFPage.REDACT_IMAGE_PIXELS,
      mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED,
      mupdf.PDFPage.REDACT_TEXT_REMOVE,
    );
  }

  const options = [];
  if (payload.optimize) {
    options.push("garbage=4", "compress", "compress-images", "compress-fonts");
  } else if (byPage.size) {
    options.push("garbage=1", "compress");
  } else {
    options.push("garbage=0");
  }

  const password = String(payload.password || "");
  if (password) {
    options.push(
      "encrypt=aes-256",
      `user-password=${password.replace(/,/g, "")}`,
      `owner-password=${password.replace(/,/g, "")}`,
      `permissions=${payload.restrict ? 2564 : -1}`,
    );
  }

  return Buffer.from(document.saveToBuffer(options.join(",")).asUint8Array());
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
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

  if (url.pathname === "/api/fonts" && request.method === "GET") {
    sendJson(response, 200, { fonts: listFonts() });
    return;
  }

  if (url.pathname === "/api/font" && request.method === "GET") {
    const fontFile = resolveFont(
      url.searchParams.get("family") || "arial",
      url.searchParams.get("bold") === "1",
      url.searchParams.get("italic") === "1",
    );
    if (!fontFile) {
      sendJson(response, 404, { error: "Không tìm thấy font." });
      return;
    }
    const bytes = fs.readFileSync(fontFile);
    response.writeHead(200, {
      "Content-Type": "font/ttf",
      "Content-Length": bytes.length,
      "Cache-Control": "public, max-age=86400",
    });
    response.end(bytes);
    return;
  }

  if (url.pathname === "/api/finalize" && request.method === "POST") {
    try {
      const payload = await readJson(request);
      sendPdf(response, finalizePdf(payload), "output.pdf");
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Không thể hoàn tất PDF.",
      });
    }
    return;
  }

  if (url.pathname === "/api/unlock" && request.method === "POST") {
    try {
      const payload = await readJson(request);
      sendPdf(response, unlockPdf(payload), "unlocked.pdf");
    } catch (error) {
      sendJson(response, error?.code ? 401 : 400, {
        code: error?.code,
        error: error instanceof Error ? error.message : "Không thể mở khóa PDF.",
      });
    }
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

  if (url.pathname === "/api/pdf-to-images" && request.method === "POST") {
    try {
      const payload = await readJson(request);
      const output = pdfToImages(payload);
      const fileName = `${sanitizeFileBaseName(payload.fileName, "pdf-pages")}-images.zip`;
      sendBinary(response, output, "application/zip", fileName);
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Không thể chuyển PDF sang hình ảnh.",
      });
    }
    return;
  }

  if (url.pathname === "/api/pdf-to-word" && request.method === "POST") {
    try {
      const payload = await readJson(request);
      const output = pdfToWord(payload);
      const fileName = `${sanitizeFileBaseName(payload.fileName, "converted")}.docx`;
      sendBinary(
        response,
        output,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName,
      );
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Không thể chuyển PDF sang Word.",
      });
    }
    return;
  }

  if (url.pathname === "/api/word-to-pdf" && request.method === "POST") {
    try {
      const payload = await readJson(request);
      const output = await wordToPdf(payload);
      const fileName = `${sanitizeFileBaseName(payload.fileName, "word-file")}.pdf`;
      sendPdf(response, output, fileName);
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Không thể chuyển Word sang PDF.",
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
