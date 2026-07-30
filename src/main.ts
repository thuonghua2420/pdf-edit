import { createIcons, icons } from "lucide";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFPage,
} from "pdf-lib";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./styles.css";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

type Tool = "select" | "text" | "cover" | "replace";

type OverlayBase = {
  id: string;
  x: number;
  y: number;
};

type TextOverlay = OverlayBase & {
  type: "text";
  text: string;
  size: number;
  color: string;
};

type CoverOverlay = OverlayBase & {
  type: "cover";
  width: number;
  height: number;
  color: string;
};

type Overlay = TextOverlay | CoverOverlay;

type PdfTextItem = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
};

type SourcePdf = {
  id: string;
  fileName: string;
  bytes: ArrayBuffer;
  pdfDoc: pdfjs.PDFDocumentProxy;
};

type PageItem = {
  id: string;
  sourceId: string;
  sourceName: string;
  pageIndex: number;
  width: number;
  height: number;
  overlays: Overlay[];
};

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Không tìm thấy root app.");
}

const app = root;

const state = {
  sources: new Map<string, SourcePdf>(),
  pages: [] as PageItem[],
  selectedPageId: "",
  selectedOverlayId: "",
  selectedTextItemId: "",
  textItemsByPageId: new Map<string, PdfTextItem[]>(),
  tool: "select" as Tool,
  textValue: "Nội dung mới",
  fontSize: 18,
  fontSizeEdited: false,
  color: "#111827",
  coverColor: "#ffffff",
  exportName: "edited.pdf",
  busy: false,
  status: "Thêm một hoặc nhiều file PDF để bắt đầu.",
};

const id = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const roundFontSize = (value: number) =>
  Math.round(clamp(value, 6, 96) * 10) / 10;

const formatFontSize = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

const selectedPage = () =>
  state.pages.find((page) => page.id === state.selectedPageId) ?? null;

const selectedOverlay = () => {
  const page = selectedPage();
  return page?.overlays.find((overlay) => overlay.id === state.selectedOverlayId) ?? null;
};

const selectedTextItem = () => {
  const page = selectedPage();
  return (page ? state.textItemsByPageId.get(page.id) : undefined)?.find(
    (item) => item.id === state.selectedTextItemId,
  ) ?? null;
};

const escapeHtml = (value: string) =>
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

const hexToRgb = (hex: string) => {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((part) => part + part)
          .join("")
      : clean;
  const value = Number.parseInt(full, 16);
  return rgb(
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  );
};

const getPageLabel = (page: PageItem, index: number) =>
  `${index + 1}. ${page.sourceName} - trang ${page.pageIndex + 1}`;

function render() {
  const page = selectedPage();
  const overlay = selectedOverlay();
  const textItem = selectedTextItem();
  const fileCount = state.sources.size;
  const pageCount = state.pages.length;

  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Support PDF</p>
          <h1>Chỉnh sửa và xuất PDF</h1>
        </div>
        <div class="top-actions">
          <label class="icon-button primary" title="Thêm PDF">
            <i data-lucide="file-plus-2"></i>
            <input id="file-input" type="file" accept="application/pdf,.pdf" multiple />
          </label>
          <button class="icon-button" id="export" title="Xuất PDF" ${pageCount ? "" : "disabled"}>
            <i data-lucide="download"></i>
          </button>
        </div>
      </header>

      <section class="workspace">
        <aside class="sidebar">
          <div class="panel-header">
            <div>
              <h2>Tệp & trang</h2>
              <p>${fileCount} file, ${pageCount} trang</p>
            </div>
            <button class="icon-button small" id="clear-all" title="Làm mới" ${pageCount ? "" : "disabled"}>
              <i data-lucide="rotate-ccw"></i>
            </button>
          </div>

          <div class="page-list" id="page-list">
            ${
              pageCount
                ? state.pages
                    .map(
                      (item, index) => `
                        <button class="page-row ${item.id === state.selectedPageId ? "active" : ""}" data-page-id="${item.id}">
                          <span class="page-number">${index + 1}</span>
                          <span>
                            <strong>${escapeHtml(item.sourceName)}</strong>
                            <small>Trang gốc ${item.pageIndex + 1} · ${item.overlays.length} lớp sửa</small>
                          </span>
                        </button>
                      `,
                    )
                    .join("")
                : `<div class="empty">
                    <i data-lucide="file-up"></i>
                    <p>Kéo thả hoặc chọn file PDF.</p>
                  </div>`
            }
          </div>

          <div class="merge-box">
            <button id="merge-all" class="wide-button accent" ${fileCount ? "" : "disabled"}>
              <i data-lucide="files"></i>
              Merge toàn bộ PDF
            </button>
            <p>Ghép nguyên tất cả trang theo thứ tự file đã thêm.</p>
          </div>

          <div class="sidebar-actions">
            <button id="move-up" class="tool-button" ${page ? "" : "disabled"} title="Đưa trang lên">
              <i data-lucide="arrow-up"></i>
            </button>
            <button id="move-down" class="tool-button" ${page ? "" : "disabled"} title="Đưa trang xuống">
              <i data-lucide="arrow-down"></i>
            </button>
            <button id="delete-page" class="tool-button danger" ${page ? "" : "disabled"} title="Xóa trang">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </aside>

        <section class="stage-wrap">
          <div class="drop-zone" id="drop-zone">
            <div class="stage-toolbar">
              <div class="segmented" role="tablist" aria-label="Công cụ">
                ${toolButton("select", "mouse-pointer-2", "Chọn")}
                ${toolButton("text", "type", "Thêm chữ")}
                ${toolButton("cover", "square", "Che nội dung")}
                ${toolButton("replace", "text-cursor-input", "Sửa text gốc")}
              </div>
              <p class="status ${state.busy ? "busy" : ""}">${escapeHtml(state.status)}</p>
            </div>

            <div class="document-frame">
              ${
                page
                  ? `<div class="canvas-shell" id="canvas-shell">
                      <canvas id="pdf-canvas"></canvas>
                      <div class="text-hit-layer" id="text-hit-layer">
                        ${
                          state.tool === "replace"
                            ? (state.textItemsByPageId.get(page.id) ?? [])
                                .map((item) => textHitMarkup(item))
                                .join("")
                            : ""
                        }
                      </div>
                      <div class="overlay-layer" id="overlay-layer">
                        ${page.overlays.map((item) => overlayMarkup(item)).join("")}
                      </div>
                    </div>`
                  : `<div class="empty-stage">
                      <i data-lucide="files"></i>
                      <h2>Chọn PDF để thao tác</h2>
                    </div>`
              }
            </div>
          </div>
        </section>

        <aside class="inspector">
          <div class="panel-header">
            <div>
              <h2>Chỉnh sửa</h2>
              <p>${page ? escapeHtml(getPageLabel(page, state.pages.indexOf(page))) : "Chưa chọn trang"}</p>
            </div>
          </div>

          <label class="field">
            <span>Tên file xuất</span>
            <input id="export-name" value="${escapeHtml(state.exportName)}" />
          </label>

          <div class="divider"></div>

          <label class="field">
            <span>Nội dung chữ</span>
            <textarea id="text-value" rows="3">${escapeHtml(state.textValue)}</textarea>
          </label>

          <div class="field-grid">
            <label class="field">
              <span>Cỡ chữ</span>
              <input id="font-size" type="number" min="6" max="96" step="0.1" value="${formatFontSize(state.fontSize)}" />
            </label>
            <label class="field">
              <span>Màu chữ</span>
              <input id="text-color" type="color" value="${state.color}" />
            </label>
          </div>

          <label class="field">
            <span>Màu che</span>
            <input id="cover-color" type="color" value="${state.coverColor}" />
          </label>

          ${
            textItem
              ? `<div class="selected-text-box">
                  <span>Text gốc đang chọn</span>
                  <strong>${escapeHtml(textItem.text.slice(0, 90))}</strong>
                </div>
                <button id="replace-text" class="wide-button accent" ${state.busy ? "disabled" : ""}>
                  <i data-lucide="text-cursor-input"></i>
                  Lưu thay text gốc
                </button>`
              : ""
          }

          <div class="divider"></div>

          <div class="overlay-list">
            <h3>Lớp sửa trên trang</h3>
            ${
              page?.overlays.length
                ? page.overlays
                    .map(
                      (item, index) => `
                        <button class="overlay-row ${item.id === state.selectedOverlayId ? "active" : ""}" data-overlay-id="${item.id}">
                          <i data-lucide="${item.type === "text" ? "type" : "square"}"></i>
                          <span>${index + 1}. ${item.type === "text" ? escapeHtml(item.text.slice(0, 32)) : "Vùng che"}</span>
                        </button>
                      `,
                    )
                    .join("")
                : `<p class="muted">Chọn công cụ rồi bấm/drag trên trang.</p>`
            }
          </div>

          <button id="delete-overlay" class="wide-button danger" ${overlay ? "" : "disabled"}>
            <i data-lucide="x"></i>
            Xóa lớp đang chọn
          </button>
        </aside>
      </section>
    </main>
  `;

  bindEvents();
  createIcons({ icons });
  void renderSelectedPdfPage();
}

function toolButton(tool: Tool, icon: string, label: string) {
  return `
    <button class="segment ${state.tool === tool ? "active" : ""}" data-tool="${tool}" title="${label}">
      <i data-lucide="${icon}"></i>
    </button>
  `;
}

function overlayMarkup(overlay: Overlay) {
  const selected = overlay.id === state.selectedOverlayId ? "selected" : "";
  const style =
    overlay.type === "text"
      ? `left:${overlay.x * 100}%;top:${overlay.y * 100}%;font-size:${overlay.size}px;color:${overlay.color};`
      : `left:${overlay.x * 100}%;top:${overlay.y * 100}%;width:${overlay.width * 100}%;height:${overlay.height * 100}%;background:${overlay.color};`;

  return `
    <button class="pdf-overlay ${overlay.type} ${selected}" data-overlay-id="${overlay.id}" style="${style}" title="Chọn lớp sửa">
      ${overlay.type === "text" ? escapeHtml(overlay.text) : ""}
    </button>
  `;
}

function textHitMarkup(item: PdfTextItem) {
  const selected = item.id === state.selectedTextItemId ? "selected" : "";
  return `
    <button class="text-hit ${selected}" data-text-item-id="${item.id}" style="left:${item.x * 100}%;top:${item.y * 100}%;width:${item.width * 100}%;height:${item.height * 100}%;" title="Chọn text gốc">
      ${escapeHtml(item.text)}
    </button>
  `;
}

function bindEvents() {
  document.querySelector<HTMLInputElement>("#file-input")?.addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    void importFiles(input.files);
    input.value = "";
  });

  document.querySelector<HTMLButtonElement>("#export")?.addEventListener("click", () => {
    void exportPdf();
  });

  document.querySelector<HTMLButtonElement>("#merge-all")?.addEventListener("click", () => {
    void mergeAllPdfs();
  });

  document.querySelector<HTMLButtonElement>("#clear-all")?.addEventListener("click", () => {
    state.sources.clear();
    state.pages = [];
    state.selectedPageId = "";
    state.selectedOverlayId = "";
    state.selectedTextItemId = "";
    state.textItemsByPageId.clear();
    state.status = "Đã làm mới. Thêm PDF để bắt đầu lại.";
    render();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-page-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedPageId = button.dataset.pageId ?? "";
      state.selectedOverlayId = "";
      state.selectedTextItemId = "";
      state.status = "Đã chọn trang.";
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tool = (button.dataset.tool as Tool) ?? "select";
      state.status =
        state.tool === "text"
          ? "Bấm lên trang để thêm chữ."
          : state.tool === "cover"
            ? "Kéo trên trang để tạo vùng che."
            : state.tool === "replace"
              ? "Bấm vào text trên trang để chọn text gốc."
              : "Chọn lớp sửa để xóa hoặc tiếp tục xem trang.";
      render();
    });
  });

  document.querySelector<HTMLInputElement>("#export-name")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    state.exportName = input.value.trim() || "edited.pdf";
  });

  document.querySelector<HTMLTextAreaElement>("#text-value")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLTextAreaElement;
    state.textValue = input.value;
  });

  document.querySelector<HTMLInputElement>("#font-size")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    state.fontSize = roundFontSize(Number(input.value) || 18);
    state.fontSizeEdited = true;
  });

  document.querySelector<HTMLInputElement>("#text-color")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    state.color = input.value;
  });

  document.querySelector<HTMLInputElement>("#cover-color")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    state.coverColor = input.value;
  });

  document.querySelector<HTMLButtonElement>("#delete-page")?.addEventListener("click", () => {
    deleteSelectedPage();
  });

  document.querySelector<HTMLButtonElement>("#move-up")?.addEventListener("click", () => {
    moveSelectedPage(-1);
  });

  document.querySelector<HTMLButtonElement>("#move-down")?.addEventListener("click", () => {
    moveSelectedPage(1);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-overlay-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.selectedOverlayId = button.dataset.overlayId ?? "";
      state.tool = "select";
      state.status = "Đã chọn lớp sửa.";
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#delete-overlay")?.addEventListener("click", () => {
    deleteSelectedOverlay();
  });

  document.querySelector<HTMLButtonElement>("#replace-text")?.addEventListener("click", () => {
    void replaceSelectedText();
  });

  bindTextHitEvents();

  const dropZone = document.querySelector<HTMLDivElement>("#drop-zone");
  dropZone?.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
  dropZone?.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragging");
  });
  dropZone?.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    void importFiles(event.dataTransfer?.files ?? null);
  });

  bindCanvasInteractions();
}

function bindTextHitEvents() {
  document.querySelectorAll<HTMLButtonElement>("[data-text-item-id]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const item = (state.textItemsByPageId.get(selectedPage()?.id ?? "") ?? []).find(
        (candidate) => candidate.id === button.dataset.textItemId,
      );
      if (!item) {
        return;
      }
      state.selectedTextItemId = item.id;
      state.selectedOverlayId = "";
      state.textValue = item.text;
      state.fontSize = roundFontSize(item.fontSize);
      state.fontSizeEdited = false;
      state.tool = "replace";
      state.status = "Đã chọn text gốc. Sửa nội dung rồi bấm lưu.";
      render();
    });
  });
}

function bindCanvasInteractions() {
  const shell = document.querySelector<HTMLDivElement>("#canvas-shell");
  if (!shell) {
    return;
  }

  let dragStart: { x: number; y: number } | null = null;
  let preview: HTMLDivElement | null = null;

  shell.addEventListener("pointerdown", (event) => {
    const page = selectedPage();
    if (!page) {
      return;
    }

    if (state.tool === "replace") {
      return;
    }

    const point = getNormalizedPoint(event, shell);

    if (state.tool === "text") {
      page.overlays.push({
        id: id(),
        type: "text",
        text: state.textValue || "Nội dung mới",
        size: state.fontSize,
        color: state.color,
        x: point.x,
        y: point.y,
      });
      state.status = "Đã thêm chữ vào trang.";
      render();
      return;
    }

    if (state.tool === "cover") {
      shell.setPointerCapture(event.pointerId);
      dragStart = point;
      preview = document.createElement("div");
      preview.className = "drag-preview";
      preview.style.background = state.coverColor;
      shell.append(preview);
      updateDragPreview(preview, dragStart, point);
    }
  });

  shell.addEventListener("pointermove", (event) => {
    if (!dragStart || !preview) {
      return;
    }
    updateDragPreview(preview, dragStart, getNormalizedPoint(event, shell));
  });

  shell.addEventListener("pointerup", (event) => {
    const page = selectedPage();
    if (!page || !dragStart) {
      return;
    }

    const end = getNormalizedPoint(event, shell);
    const rect = normalizedRect(dragStart, end);
    preview?.remove();
    preview = null;
    dragStart = null;

    if (rect.width < 0.01 || rect.height < 0.01) {
      return;
    }

    page.overlays.push({
      id: id(),
      type: "cover",
      color: state.coverColor,
      ...rect,
    });
    state.status = "Đã thêm vùng che nội dung.";
    render();
  });
}

function getNormalizedPoint(event: PointerEvent, element: HTMLElement) {
  const bounds = element.getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
  };
}

function normalizedRect(start: { x: number; y: number }, end: { x: number; y: number }) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function updateDragPreview(
  preview: HTMLDivElement,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const rect = normalizedRect(start, end);
  preview.style.left = `${rect.x * 100}%`;
  preview.style.top = `${rect.y * 100}%`;
  preview.style.width = `${rect.width * 100}%`;
  preview.style.height = `${rect.height * 100}%`;
}

async function importFiles(fileList: FileList | null) {
  const files = [...(fileList ?? [])].filter(
    (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
  );

  if (!files.length) {
    state.status = "Chưa có file PDF hợp lệ.";
    render();
    return;
  }

  state.busy = true;
  state.status = "Đang đọc PDF...";
  render();

  try {
    for (const file of files) {
      const bytes = await file.arrayBuffer();
      const pdfDoc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
      const sourceId = id();

      state.sources.set(sourceId, {
        id: sourceId,
        fileName: file.name,
        bytes,
        pdfDoc,
      });

      for (let index = 0; index < pdfDoc.numPages; index += 1) {
        const pdfPage = await pdfDoc.getPage(index + 1);
        const viewport = pdfPage.getViewport({ scale: 1 });

        state.pages.push({
          id: id(),
          sourceId,
          sourceName: file.name,
          pageIndex: index,
          width: viewport.width,
          height: viewport.height,
          overlays: [],
        });
      }
    }

    state.selectedPageId ||= state.pages[0]?.id ?? "";
    state.exportName = suggestExportName(files[0]?.name ?? state.exportName);
    state.status = `Đã thêm ${files.length} file PDF.`;
  } catch (error) {
    state.status = error instanceof Error ? error.message : "Không thể đọc PDF.";
  } finally {
    state.busy = false;
    render();
  }
}

function suggestExportName(name: string) {
  const base = name.replace(/\.pdf$/i, "");
  return `${base || "edited"}-edited.pdf`;
}

async function renderSelectedPdfPage() {
  const page = selectedPage();
  const canvas = document.querySelector<HTMLCanvasElement>("#pdf-canvas");
  const shell = document.querySelector<HTMLDivElement>("#canvas-shell");
  const source = page ? state.sources.get(page.sourceId) : null;

  if (!page || !canvas || !shell || !source) {
    return;
  }

  const pdfPage = await source.pdfDoc.getPage(page.pageIndex + 1);
  const baseViewport = pdfPage.getViewport({ scale: 1 });
  const maxWidth = Math.min(shell.parentElement?.clientWidth ?? 900, 980);
  const maxHeight = Math.min(window.innerHeight - 190, 1200);
  const scale = Math.min(maxWidth / baseViewport.width, maxHeight / baseViewport.height, 1.6);
  const viewport = pdfPage.getViewport({ scale });
  const pixelRatio = window.devicePixelRatio || 1;
  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  canvas.width = Math.floor(viewport.width * pixelRatio);
  canvas.height = Math.floor(viewport.height * pixelRatio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  shell.style.width = `${viewport.width}px`;
  shell.style.height = `${viewport.height}px`;

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, viewport.width, viewport.height);
  await pdfPage.render({ canvasContext: context, viewport }).promise;

  const textContent = await pdfPage.getTextContent();
  const textItems: PdfTextItem[] = [];

  for (const rawItem of textContent.items) {
    if (!("str" in rawItem) || !rawItem.str.trim()) {
      continue;
    }

    const item = rawItem as {
      str: string;
      transform: number[];
      width: number;
      height: number;
    };
    const transform = pdfjs.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.max(Math.hypot(transform[2], transform[3]), item.height * scale);
    const left = clamp(transform[4], 0, viewport.width);
    const top = clamp(transform[5] - fontHeight, 0, viewport.height);
    const width = clamp(item.width * scale, 8, viewport.width - left);
    const height = clamp(fontHeight, 10, viewport.height - top);

    if (width <= 0 || height <= 0) {
      continue;
    }

    textItems.push({
      id: `${page.id}-text-${textItems.length}`,
      text: item.str,
      x: left / viewport.width,
      y: top / viewport.height,
      width: width / viewport.width,
      height: height / viewport.height,
      fontSize: clamp(fontHeight / scale, 6, 144),
    });
  }

  state.textItemsByPageId.set(page.id, textItems);
  const hitLayer = document.querySelector<HTMLDivElement>("#text-hit-layer");
  if (hitLayer) {
    hitLayer.innerHTML = state.tool === "replace" ? textItems.map(textHitMarkup).join("") : "";
    bindTextHitEvents();
  }
}

function deleteSelectedPage() {
  const index = state.pages.findIndex((page) => page.id === state.selectedPageId);
  if (index === -1) {
    return;
  }

  state.pages.splice(index, 1);
  state.selectedPageId = state.pages[Math.min(index, state.pages.length - 1)]?.id ?? "";
  state.selectedOverlayId = "";
  state.status = "Đã xóa trang khỏi file xuất.";
  render();
}

function moveSelectedPage(direction: -1 | 1) {
  const index = state.pages.findIndex((page) => page.id === state.selectedPageId);
  const target = index + direction;

  if (index < 0 || target < 0 || target >= state.pages.length) {
    return;
  }

  const [page] = state.pages.splice(index, 1);
  state.pages.splice(target, 0, page);
  state.status = "Đã đổi thứ tự trang.";
  render();
}

function deleteSelectedOverlay() {
  const page = selectedPage();
  if (!page) {
    return;
  }

  page.overlays = page.overlays.filter((overlay) => overlay.id !== state.selectedOverlayId);
  state.selectedOverlayId = "";
  state.status = "Đã xóa lớp sửa.";
  render();
}

async function replaceSelectedText() {
  const page = selectedPage();
  const source = page ? state.sources.get(page.sourceId) : null;
  const textItem = selectedTextItem();

  if (!page || !source || !textItem) {
    state.status = "Hãy chọn một text gốc trên trang trước.";
    render();
    return;
  }

  if (!state.textValue.trim()) {
    state.status = "Text thay thế không được để trống.";
    render();
    return;
  }

  state.busy = true;
  state.status = "MuPDF đang thay text gốc...";
  render();

  try {
    const response = await fetch("/api/edit-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pdfBase64: arrayBufferToBase64(source.bytes),
        pageIndex: page.pageIndex,
        rect: [textItem.x, textItem.y, textItem.x + textItem.width, textItem.y + textItem.height],
        originalText: textItem.text,
        text: state.textValue,
        fontSize: state.fontSizeEdited ? state.fontSize : undefined,
        autoFontSize: !state.fontSizeEdited,
        color: state.color,
        coverColor: state.coverColor,
      }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(errorPayload?.error || "Không thể sửa text PDF.");
    }

    const outputBytes = await response.arrayBuffer();
    await source.pdfDoc.destroy();
    source.bytes = outputBytes;
    source.pdfDoc = await pdfjs.getDocument({ data: outputBytes.slice(0) }).promise;
    state.textItemsByPageId.delete(page.id);
    state.selectedTextItemId = "";
    state.status = "Đã sửa text gốc. Bấm Xuất PDF để tải bản hoàn chỉnh.";
  } catch (error) {
    state.status = error instanceof Error ? error.message : "Không thể sửa text PDF.";
  } finally {
    state.busy = false;
    render();
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

async function exportPdf() {
  if (!state.pages.length) {
    return;
  }

  state.busy = true;
  state.status = "Đang xuất PDF...";
  render();

  try {
    const outputDoc = await PDFDocument.create();
    const sourceDocs = new Map<string, PDFDocument>();
    const font = await outputDoc.embedFont(StandardFonts.Helvetica);

    for (const pageItem of state.pages) {
      const source = state.sources.get(pageItem.sourceId);
      if (!source) {
        continue;
      }

      let sourceDoc = sourceDocs.get(source.id);
      if (!sourceDoc) {
        sourceDoc = await PDFDocument.load(source.bytes.slice(0));
        sourceDocs.set(source.id, sourceDoc);
      }

      const [copiedPage] = await outputDoc.copyPages(sourceDoc, [pageItem.pageIndex]);
      outputDoc.addPage(copiedPage);
      drawOverlays(copiedPage, pageItem, font);
    }

    const outputBytes = await outputDoc.save();
    downloadPdf(outputBytes, state.exportName);
    state.status = "Đã xuất PDF.";
  } catch (error) {
    state.status = error instanceof Error ? error.message : "Không thể xuất PDF.";
  } finally {
    state.busy = false;
    render();
  }
}

async function mergeAllPdfs() {
  if (!state.sources.size) {
    return;
  }

  state.busy = true;
  state.status = "Đang merge toàn bộ file PDF...";
  render();

  try {
    const outputDoc = await PDFDocument.create();

    for (const source of state.sources.values()) {
      const sourceDoc = await PDFDocument.load(source.bytes.slice(0));
      const copiedPages = await outputDoc.copyPages(sourceDoc, sourceDoc.getPageIndices());
      copiedPages.forEach((page) => outputDoc.addPage(page));
    }

    const outputBytes = await outputDoc.save();
    downloadPdf(outputBytes, "merged-all.pdf");
    state.status = "Đã merge toàn bộ PDF thành một file.";
  } catch (error) {
    state.status = error instanceof Error ? error.message : "Không thể merge PDF.";
  } finally {
    state.busy = false;
    render();
  }
}

function downloadPdf(outputBytes: Uint8Array, fileName: string) {
  const outputBuffer = outputBytes.buffer.slice(
    outputBytes.byteOffset,
    outputBytes.byteOffset + outputBytes.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([outputBuffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName.toLowerCase().endsWith(".pdf") ? fileName : `${fileName}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
}

function drawOverlays(page: PDFPage, pageItem: PageItem, font: Awaited<ReturnType<PDFDocument["embedFont"]>>) {
  const { width, height } = page.getSize();

  for (const overlay of pageItem.overlays) {
    if (overlay.type === "cover") {
      page.drawRectangle({
        x: overlay.x * width,
        y: height - (overlay.y + overlay.height) * height,
        width: overlay.width * width,
        height: overlay.height * height,
        color: hexToRgb(overlay.color),
      });
      continue;
    }

    page.drawText(overlay.text, {
      x: overlay.x * width,
      y: height - overlay.y * height - overlay.size,
      size: overlay.size,
      font,
      color: hexToRgb(overlay.color),
      lineHeight: overlay.size * 1.2,
      maxWidth: width - overlay.x * width - 24,
    });
  }
}

window.addEventListener("resize", () => {
  void renderSelectedPdfPage();
});

render();
