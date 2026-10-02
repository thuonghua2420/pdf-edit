import { openExportDialog } from "./exportDialog";
import { icon } from "./icons";
import { importFiles } from "./importer";
import {
  deletePages,
  duplicatePages,
  insertBlankPage,
  movePages,
  requestReveal,
  rotatePages,
  selectAllPages,
  selectPage,
  selectParity,
  targetPageIds,
} from "./ops";
import { renderPage } from "./pdfEngine";
import { bus, pageDims, state } from "./state";
import type { PageItem } from "./types";
import { escapeHtml } from "./util";
import { pickFiles } from "./ui";

type Thumb = {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  frame: HTMLElement;
  badge: HTMLElement;
  edits: HTMLElement;
  source: HTMLElement;
  key: string;
  visible: boolean;
  rendering: boolean;
};

const thumbs = new Map<string, Thumb>();
const bitmapCache = new Map<string, HTMLCanvasElement>();
let listEl: HTMLElement;
let stackEl: HTMLElement;
let headerEl: HTMLElement;
let footerEl: HTMLElement;
let dropLine: HTMLElement;
let observer: IntersectionObserver;
let draggingIds: string[] = [];

const THUMB_WIDTH = 176;

function createThumb(page: PageItem): Thumb {
  const el = document.createElement("div");
  el.className = "thumb";
  el.dataset.pageId = page.id;
  el.draggable = true;
  el.tabIndex = 0;
  el.innerHTML = `
    <div class="thumb-source"></div>
    <div class="thumb-frame">
      <canvas></canvas>
      <span class="thumb-badge"></span>
      <span class="thumb-edits"></span>
      <div class="thumb-actions">
        <button data-act="rotate" title="Xoay phải" aria-label="Xoay phải">${icon("rotate-cw", 14)}</button>
        <button data-act="duplicate" title="Nhân bản trang" aria-label="Nhân bản trang">${icon("copy-plus", 14)}</button>
        <button data-act="delete" class="danger" title="Xóa trang" aria-label="Xóa trang">${icon("trash", 14)}</button>
      </div>
    </div>`;
  const q = <T extends HTMLElement>(selector: string) => el.querySelector(selector) as T;
  const thumb: Thumb = {
    el,
    canvas: q<HTMLCanvasElement>("canvas"),
    frame: q(".thumb-frame"),
    badge: q(".thumb-badge"),
    edits: q(".thumb-edits"),
    source: q(".thumb-source"),
    key: "",
    visible: false,
    rendering: false,
  };
  thumbs.set(page.id, thumb);
  observer.observe(el);
  return thumb;
}

function thumbKey(page: PageItem) {
  return `${page.sourceId ?? "blank"}:${page.pageIndex}:${page.rotation}`;
}

async function renderThumb(page: PageItem, thumb: Thumb) {
  const key = thumbKey(page);
  if (thumb.key === key || thumb.rendering) {
    return;
  }

  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const cached = bitmapCache.get(key);
  const paint = (source: HTMLCanvasElement) => {
    thumb.canvas.width = source.width;
    thumb.canvas.height = source.height;
    thumb.canvas.getContext("2d")?.drawImage(source, 0, 0);
    thumb.key = key;
  };

  if (!page.sourceId) {
    thumb.canvas.width = 1;
    thumb.canvas.height = 1;
    thumb.key = key;
    return;
  }
  if (cached) {
    paint(cached);
    return;
  }

  thumb.rendering = true;
  try {
    const offscreen = document.createElement("canvas");
    const dims = pageDims(page);
    await renderPage(page, offscreen, THUMB_WIDTH / dims.w, ratio).promise;
    bitmapCache.set(key, offscreen);
    if (bitmapCache.size > 400) {
      bitmapCache.delete(bitmapCache.keys().next().value as string);
    }
    if (thumbs.get(page.id) === thumb) {
      paint(offscreen);
    }
  } catch {
    /* thumbnail lỗi không ảnh hưởng thao tác chính */
  } finally {
    thumb.rendering = false;
  }

  // Trang có thể đã đổi (xoay/sửa) trong lúc đang vẽ
  const latest = state.pages.find((item) => item.id === page.id);
  if (latest && thumb.visible && thumb.key !== thumbKey(latest)) {
    void renderThumb(latest, thumb);
  }
}

function renderHeader() {
  const sourceCount = new Set(state.pages.map((page) => page.sourceName)).size;
  headerEl.innerHTML = `
    <div>
      <h2>Trang</h2>
      <p>${state.pages.length} trang${sourceCount > 1 ? ` · ${sourceCount} tệp` : ""}</p>
    </div>
    <div class="panel-header-actions">
      <button class="icon-btn" data-act="add-files" data-tip="Thêm tệp vào cuối" aria-label="Thêm tệp">${icon("file-plus-2", 18)}</button>
      <button class="icon-btn" data-act="blank" data-tip="Chèn trang trắng" aria-label="Chèn trang trắng" ${state.pages.length ? "" : "disabled"}>${icon("file-plus", 18)}</button>
    </div>`;
}

function renderFooter() {
  const count = state.selectedPageIds.size;
  const disabled = state.pages.length ? "" : "disabled";
  footerEl.innerHTML = `
    <div class="thumb-selection">
      <span>${count > 1 ? `Đã chọn <b>${count}</b> trang` : "Chọn nhiều trang: Ctrl / Shift + bấm"}</span>
      <div class="chip-row">
        <button class="chip" data-act="select-all" ${disabled}>Tất cả</button>
        <button class="chip" data-act="select-odd" ${disabled}>Lẻ</button>
        <button class="chip" data-act="select-even" ${disabled}>Chẵn</button>
      </div>
    </div>
    <div class="thumb-toolbar">
      <button class="icon-btn" data-act="rotate-left" data-tip="Xoay trái" ${disabled}>${icon("rotate-ccw", 18)}</button>
      <button class="icon-btn" data-act="rotate-right" data-tip="Xoay phải" ${disabled}>${icon("rotate-cw", 18)}</button>
      <button class="icon-btn" data-act="duplicate" data-tip="Nhân bản" ${disabled}>${icon("copy-plus", 18)}</button>
      <button class="icon-btn" data-act="extract" data-tip="Tách thành PDF riêng" ${disabled}>${icon("scissors", 18)}</button>
      <button class="icon-btn danger" data-act="delete" data-tip="Xóa trang" ${disabled}>${icon("trash", 18)}</button>
    </div>`;
}

function renderList() {
  const ids = new Set(state.pages.map((page) => page.id));
  for (const [id, thumb] of [...thumbs]) {
    if (!ids.has(id)) {
      observer.unobserve(thumb.el);
      thumb.el.remove();
      thumbs.delete(id);
    }
  }

  state.pages.forEach((page, index) => {
    const thumb = thumbs.get(page.id) ?? createThumb(page);
    if (stackEl.children[index] !== thumb.el) {
      stackEl.insertBefore(thumb.el, stackEl.children[index] ?? null);
    }

    const dims = pageDims(page);
    thumb.frame.style.aspectRatio = `${dims.w} / ${dims.h}`;
    thumb.badge.textContent = String(index + 1);
    thumb.edits.innerHTML = page.overlays.length ? `${icon("pencil", 11)} ${page.overlays.length}` : "";
    thumb.edits.style.display = page.overlays.length ? "" : "none";

    const previous = state.pages[index - 1];
    const label = !previous || previous.sourceName !== page.sourceName ? page.sourceName : "";
    thumb.source.textContent = label;
    thumb.source.style.display = label ? "" : "none";
    thumb.source.title = label;

    if (thumb.visible) {
      void renderThumb(page, thumb);
    }
  });

  listEl.classList.toggle("is-empty", !state.pages.length);
  renderHeader();
  renderFooter();
  renderSelection();
}

function renderSelection() {
  for (const [id, thumb] of thumbs) {
    thumb.el.classList.toggle("selected", state.selectedPageIds.has(id));
    thumb.el.classList.toggle("active", id === state.activePageId);
  }
  renderFooter();
}

function keepActiveVisible() {
  const thumb = thumbs.get(state.activePageId);
  if (!thumb) {
    return;
  }
  const listRect = listEl.getBoundingClientRect();
  const rect = thumb.el.getBoundingClientRect();
  if (rect.top < listRect.top + 8 || rect.bottom > listRect.bottom - 8) {
    thumb.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function insertionSlot(clientY: number) {
  let slot = state.pages.length;
  for (let index = 0; index < state.pages.length; index += 1) {
    const thumb = thumbs.get(state.pages[index].id);
    if (!thumb) {
      continue;
    }
    const rect = thumb.el.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      slot = index;
      break;
    }
  }
  return slot;
}

function showDropLine(slot: number) {
  const target = slot < state.pages.length ? thumbs.get(state.pages[slot].id) : null;
  const listRect = listEl.getBoundingClientRect();
  let top: number;
  if (target) {
    top = target.el.getBoundingClientRect().top - listRect.top + listEl.scrollTop - 4;
  } else {
    const last = thumbs.get(state.pages.at(-1)?.id ?? "");
    top = last ? last.el.getBoundingClientRect().bottom - listRect.top + listEl.scrollTop + 2 : 0;
  }
  dropLine.style.top = `${top}px`;
  dropLine.style.display = "block";
}

async function handleAction(action: string) {
  switch (action) {
    case "add-files": {
      const files = await pickFiles(".pdf,.doc,.docx,.rtf,.odt,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg");
      if (files.length) {
        await importFiles(files);
      }
      break;
    }
    case "blank": {
      const id = insertBlankPage();
      requestReveal(id);
      break;
    }
    case "select-all":
      selectAllPages();
      break;
    case "select-odd":
      selectParity("odd");
      break;
    case "select-even":
      selectParity("even");
      break;
    case "rotate-left":
      rotatePages(targetPageIds(), -1);
      break;
    case "rotate-right":
      rotatePages(targetPageIds(), 1);
      break;
    case "duplicate":
      duplicatePages(targetPageIds());
      break;
    case "delete":
      deletePages(targetPageIds());
      if (state.activePageId) {
        requestReveal(state.activePageId, false);
      }
      break;
    case "extract":
      openExportDialog({ scope: "selected" });
      break;
  }
}

export function initThumbs(root: HTMLElement) {
  root.innerHTML = `
    <div class="panel-header" id="thumb-header"></div>
    <div class="thumb-list" id="thumb-list">
      <div class="thumb-stack" id="thumb-stack"></div>
      <div class="drop-line" id="drop-line"></div>
      <div class="thumb-empty">
        ${icon("files", 28)}
        <p>Trang của tài liệu sẽ hiện ở đây</p>
      </div>
    </div>
    <div class="thumb-footer" id="thumb-footer"></div>`;
  headerEl = root.querySelector("#thumb-header") as HTMLElement;
  listEl = root.querySelector("#thumb-list") as HTMLElement;
  stackEl = root.querySelector("#thumb-stack") as HTMLElement;
  footerEl = root.querySelector("#thumb-footer") as HTMLElement;
  dropLine = root.querySelector("#drop-line") as HTMLElement;

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.pageId ?? "";
        const thumb = thumbs.get(id);
        const page = state.pages.find((item) => item.id === id);
        if (!thumb || !page) {
          continue;
        }
        thumb.visible = entry.isIntersecting;
        if (entry.isIntersecting) {
          void renderThumb(page, thumb);
        }
      }
    },
    { root: listEl, rootMargin: "400px 0px" },
  );

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const actionEl = target.closest<HTMLElement>("[data-act]");
    const thumbEl = target.closest<HTMLElement>(".thumb");

    if (actionEl && thumbEl && actionEl.closest(".thumb-actions")) {
      event.stopPropagation();
      const id = thumbEl.dataset.pageId ?? "";
      const act = actionEl.dataset.act;
      if (act === "rotate") rotatePages([id], 1);
      else if (act === "duplicate") duplicatePages([id]);
      else if (act === "delete") deletePages([id]);
      return;
    }

    if (actionEl && !thumbEl) {
      void handleAction(actionEl.dataset.act ?? "");
      return;
    }

    if (thumbEl) {
      const id = thumbEl.dataset.pageId ?? "";
      const modified = event.ctrlKey || event.metaKey || event.shiftKey;
      selectPage(id, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
      if (!modified) {
        requestReveal(id);
      }
      thumbEl.focus({ preventScroll: true });
    }
  });

  root.addEventListener("keydown", (event) => {
    const thumbEl = (event.target as HTMLElement).closest<HTMLElement>(".thumb");
    if (!thumbEl || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) {
      return;
    }
    event.preventDefault();
    const index = state.pages.findIndex((page) => page.id === thumbEl.dataset.pageId);
    const next = state.pages[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      selectPage(next.id, { range: event.shiftKey });
      requestReveal(next.id);
      thumbs.get(next.id)?.el.focus({ preventScroll: true });
    }
  });

  listEl.addEventListener("dragstart", (event) => {
    const thumbEl = (event.target as HTMLElement).closest<HTMLElement>(".thumb");
    if (!thumbEl || !event.dataTransfer) {
      return;
    }
    const id = thumbEl.dataset.pageId ?? "";
    if (!state.selectedPageIds.has(id)) {
      selectPage(id);
    }
    draggingIds = state.pages.filter((page) => state.selectedPageIds.has(page.id)).map((page) => page.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-support-pdf-pages", draggingIds.join(","));
    for (const dragged of draggingIds) {
      thumbs.get(dragged)?.el.classList.add("dragging");
    }
  });

  listEl.addEventListener("dragover", (event) => {
    if (!draggingIds.length) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    showDropLine(insertionSlot(event.clientY));
  });

  listEl.addEventListener("drop", (event) => {
    if (!draggingIds.length) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const slot = insertionSlot(event.clientY);
    const moving = new Set(draggingIds);
    const restIndex = state.pages.slice(0, slot).filter((page) => !moving.has(page.id)).length;
    movePages(draggingIds, restIndex);
  });

  listEl.addEventListener("dragend", () => {
    draggingIds = [];
    dropLine.style.display = "none";
    for (const thumb of thumbs.values()) {
      thumb.el.classList.remove("dragging");
    }
  });

  bus.on("pages", renderList);
  bus.on(["selection", "active"], () => {
    renderSelection();
    keepActiveVisible();
  });

  renderList();
}
