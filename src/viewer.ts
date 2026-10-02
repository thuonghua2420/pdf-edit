import { decorOverlays } from "./decor";
import { LINE_HEIGHT, fontEpoch } from "./fonts";
import { moveOverlay, normalizeRect, smoothStroke } from "./geo";
import {
  addOverlay,
  clearSelection,
  makeOverlay,
  selectOverlay,
  setActivePage,
  setTool,
  setZoomMode,
  zoomBy,
} from "./ops";
import { overlayHtml } from "./overlayRender";
import { getTextItems, renderPage, type RenderHandle } from "./pdfEngine";
import {
  beginGesture,
  bus,
  getPage,
  pageDims,
  selectedOverlay,
  state,
} from "./state";
import { openTextEditBubble } from "./textEdit";
import type { Overlay, PageItem, PdfTextItem, ToolId } from "./types";
import { clamp, rafThrottle } from "./util";

const PAD = 36;

type Slot = {
  id: string;
  el: HTMLElement;
  sheet: HTMLElement;
  canvas: HTMLCanvasElement;
  textLayer: HTMLElement;
  searchLayer: HTMLElement;
  decorLayer: HTMLElement;
  overlayLayer: HTMLElement;
  tag: HTMLElement;
  visible: boolean;
  renderKey: string;
  renderTimer: number;
  handle: RenderHandle | null;
  overlayKey: string;
  textKey: string;
  items: PdfTextItem[];
  draft: Overlay | null;
  width: number;
  height: number;
};

const slots = new Map<string, Slot>();
let scroller: HTMLElement;
let list: HTMLElement;
let observer: IntersectionObserver;
let suppressActiveUntil = 0;

type Editing = {
  pageId: string;
  id: string;
  gesture: ReturnType<typeof beginGesture>;
  body: HTMLElement;
};
let editing: Editing | null = null;

const DRAW_TOOLS: ToolId[] = ["highlight", "pen", "rect", "ellipse", "line", "arrow", "cover", "redact"];

// ------------------------------------------------------------------- layout

function computeScale() {
  if (!state.pages.length) {
    return 1;
  }
  if (state.zoomMode === "manual") {
    return state.zoom;
  }
  const availableW = Math.max(scroller.clientWidth - PAD * 2, 120);
  const availableH = Math.max(scroller.clientHeight - PAD * 2, 120);

  if (state.zoomMode === "fit-page") {
    const page = getPage(state.activePageId) ?? state.pages[0];
    const dims = pageDims(page);
    return clamp(Math.min(availableW / dims.w, availableH / dims.h), 0.1, 4);
  }

  const widest = Math.max(...state.pages.map((page) => pageDims(page).w));
  return clamp(availableW / widest, 0.1, 4);
}

function createSlot(page: PageItem): Slot {
  const el = document.createElement("div");
  el.className = "page-slot";
  el.dataset.pageId = page.id;
  el.innerHTML = `
    <div class="page-sheet">
      <canvas class="page-canvas"></canvas>
      <div class="layer text-layer"></div>
      <div class="layer search-layer"></div>
      <div class="layer decor-layer"></div>
      <div class="layer overlay-layer"></div>
    </div>
    <div class="page-tag"></div>`;

  const q = <T extends HTMLElement>(selector: string) => el.querySelector(selector) as T;
  const slot: Slot = {
    id: page.id,
    el,
    sheet: q(".page-sheet"),
    canvas: q<HTMLCanvasElement>(".page-canvas"),
    textLayer: q(".text-layer"),
    searchLayer: q(".search-layer"),
    decorLayer: q(".decor-layer"),
    overlayLayer: q(".overlay-layer"),
    tag: q(".page-tag"),
    visible: false,
    renderKey: "",
    renderTimer: 0,
    handle: null,
    overlayKey: "",
    textKey: "",
    items: [],
    draft: null,
    width: 0,
    height: 0,
  };
  slots.set(page.id, slot);
  observer.observe(el);
  return slot;
}

function removeSlot(slot: Slot) {
  window.clearTimeout(slot.renderTimer);
  slot.handle?.cancel();
  observer.unobserve(slot.el);
  slot.el.remove();
  slots.delete(slot.id);
}

function reconcile() {
  const ids = new Set(state.pages.map((page) => page.id));
  for (const slot of [...slots.values()]) {
    if (!ids.has(slot.id)) {
      removeSlot(slot);
    }
  }

  state.pages.forEach((page, index) => {
    const slot = slots.get(page.id) ?? createSlot(page);
    if (list.children[index] !== slot.el) {
      list.insertBefore(slot.el, list.children[index] ?? null);
    }
    slot.tag.textContent = `${index + 1} / ${state.pages.length}`;
  });

  layout();
}

function layout(keepAnchor = false) {
  const ratio = keepAnchor && scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : null;
  const scale = computeScale();
  state.scale = scale;

  for (const page of state.pages) {
    const slot = slots.get(page.id);
    if (!slot) {
      continue;
    }
    const dims = pageDims(page);
    slot.width = dims.w * scale;
    slot.height = dims.h * scale;
    slot.sheet.style.width = `${slot.width}px`;
    slot.sheet.style.height = `${slot.height}px`;
  }

  if (ratio !== null) {
    scroller.scrollTop = ratio * scroller.scrollHeight;
  }

  for (const slot of slots.values()) {
    if (slot.visible) {
      refreshSlot(slot);
    }
  }
  bus.emit("active");
}

// ------------------------------------------------------------------- render

function renderRatio(slot: Slot) {
  let ratio = Math.min(window.devicePixelRatio || 1, 2);
  const pixels = slot.width * slot.height * ratio * ratio;
  if (pixels > 28_000_000) {
    ratio = Math.sqrt(28_000_000 / (slot.width * slot.height));
  }
  return ratio;
}

function scheduleCanvasRender(slot: Slot) {
  const page = getPage(slot.id);
  if (!page || !slot.visible) {
    return;
  }

  if (!page.sourceId) {
    slot.canvas.style.visibility = "hidden";
    slot.renderKey = "blank";
    return;
  }
  slot.canvas.style.visibility = "";

  const ratio = renderRatio(slot);
  const key = `${page.sourceId}:${page.pageIndex}:${page.rotation}:${slot.width.toFixed(1)}:${ratio.toFixed(2)}`;
  if (key === slot.renderKey) {
    return;
  }

  window.clearTimeout(slot.renderTimer);
  slot.renderTimer = window.setTimeout(async () => {
    slot.handle?.cancel();
    const next = document.createElement("canvas");
    next.className = "page-canvas";
    const handle = renderPage(page, next, slot.width / pageDims(page).w, ratio);
    slot.handle = handle;
    try {
      await handle.promise;
    } catch {
      return;
    }
    if (slot.handle !== handle || !slots.has(slot.id)) {
      return;
    }
    slot.canvas.replaceWith(next);
    slot.canvas = next;
    slot.renderKey = key;
    slot.handle = null;
    void refreshTextLayer(slot);
  }, slot.renderKey ? 80 : 0);
}

function releaseCanvas(slot: Slot) {
  window.clearTimeout(slot.renderTimer);
  slot.handle?.cancel();
  slot.handle = null;
  if (slot.renderKey && slot.renderKey !== "blank") {
    const blank = document.createElement("canvas");
    blank.className = "page-canvas";
    slot.canvas.replaceWith(blank);
    slot.canvas = blank;
  }
  slot.renderKey = "";
  slot.overlayKey = "";
  slot.overlayLayer.innerHTML = "";
  slot.decorLayer.innerHTML = "";
  slot.textLayer.innerHTML = "";
  slot.textKey = "";
}

function refreshSlot(slot: Slot) {
  scheduleCanvasRender(slot);
  renderOverlays(slot);
  void refreshTextLayer(slot);
  renderSearchLayer(slot);
}

function renderOverlays(slot: Slot) {
  const page = getPage(slot.id);
  if (!page || !slot.visible) {
    return;
  }
  if (editing && editing.pageId === slot.id) {
    return;
  }

  const index = state.pages.indexOf(page);
  const decor = decorOverlays(page, index, state.pages.length);
  const selectedId = state.selected?.pageId === page.id ? state.selected.id : "";
  const key = JSON.stringify([
    page.overlays,
    page.rotation,
    selectedId,
    slot.draft,
    decor,
    slot.width,
    fontEpoch(),
    state.tool === "edit-text",
  ]);
  if (key === slot.overlayKey) {
    return;
  }
  slot.overlayKey = key;

  const { width: W, height: H } = slot;
  const scale = state.scale;
  slot.overlayLayer.innerHTML =
    page.overlays
      .map((overlay) => overlayHtml(overlay, W, H, scale, { selected: overlay.id === selectedId, interactive: true }))
      .join("")
    + (slot.draft ? overlayHtml(slot.draft, W, H, scale, { selected: false, interactive: false }) : "");
  slot.decorLayer.innerHTML = decor
    .map((overlay) => overlayHtml(overlay, W, H, scale, { selected: false, interactive: false }))
    .join("");
}

function refreshAllOverlays() {
  for (const slot of slots.values()) {
    if (slot.visible) {
      renderOverlays(slot);
    }
  }
}

async function refreshTextLayer(slot: Slot) {
  const page = getPage(slot.id);
  if (!page) {
    return;
  }

  if (state.tool !== "edit-text" || !slot.visible || !page.sourceId) {
    if (slot.textKey) {
      slot.textLayer.innerHTML = "";
      slot.textKey = "";
    }
    return;
  }

  const key = `${page.sourceId}:${page.pageIndex}:${page.rotation}`;
  if (slot.textKey === key) {
    return;
  }

  const items = await getTextItems(page);
  if (state.tool !== "edit-text" || !slots.has(slot.id) || !slot.visible) {
    return;
  }
  slot.items = items;
  slot.textKey = key;
  slot.textLayer.innerHTML = items
    .map(
      (item, index) =>
        `<button class="text-hit" data-index="${index}" tabindex="-1" style="left:${item.x * 100}%;top:${item.y * 100}%;width:${item.width * 100}%;height:${item.height * 100}%"></button>`,
    )
    .join("");
}

function renderSearchLayer(slot: Slot) {
  const hits = state.search.open
    ? state.search.hits.map((hit, index) => ({ hit, index })).filter(({ hit }) => hit.pageId === slot.id)
    : [];
  slot.searchLayer.innerHTML = hits
    .map(
      ({ hit, index }) =>
        `<i class="search-hit ${index === state.search.index ? "current" : ""}" style="left:${hit.x * 100}%;top:${hit.y * 100}%;width:${hit.w * 100}%;height:${hit.h * 100}%"></i>`,
    )
    .join("");
}

// ------------------------------------------------------------- active page

const updateActivePage = rafThrottle(() => {
  if (performance.now() < suppressActiveUntil || !state.pages.length) {
    return;
  }
  const line = scroller.scrollTop + scroller.clientHeight * 0.4;
  let chosen = state.pages[0].id;
  for (const page of state.pages) {
    const slot = slots.get(page.id);
    if (!slot) {
      continue;
    }
    if (slot.el.offsetTop + slot.el.offsetHeight >= line) {
      chosen = page.id;
      break;
    }
    chosen = page.id;
  }
  if (chosen !== state.activePageId) {
    state.activePageId = chosen;
    if (state.selectedPageIds.size <= 1) {
      state.selectedPageIds = new Set([chosen]);
      state.anchorPageId = chosen;
    }
    bus.emit("active");
  }
});

export function scrollToPage(pageId: string, smooth = true) {
  const slot = slots.get(pageId);
  if (!slot) {
    return;
  }
  suppressActiveUntil = performance.now() + (smooth ? 700 : 150);
  scroller.scrollTo({ top: slot.el.offsetTop - PAD + 12, behavior: smooth ? "smooth" : "auto" });
}

export function scrollToRect(pageId: string, rect: { x: number; y: number; h: number }) {
  const slot = slots.get(pageId);
  if (!slot) {
    return;
  }
  suppressActiveUntil = performance.now() + 500;
  const top = slot.el.offsetTop + (rect.y + rect.h / 2) * slot.height - scroller.clientHeight / 2;
  scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

export const getSheet = (pageId: string) => slots.get(pageId)?.sheet ?? null;
export const getPageCanvas = (pageId: string) => slots.get(pageId)?.canvas ?? null;

// ----------------------------------------------------------- pointer logic

function pointOnSheet(event: PointerEvent, sheet: HTMLElement, clampToPage = true) {
  const bounds = sheet.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width;
  const y = (event.clientY - bounds.top) / bounds.height;
  return clampToPage ? { x: clamp(x, 0, 1), y: clamp(y, 0, 1) } : { x, y };
}

type Drag =
  | { kind: "move"; pageId: string; id: string; original: Overlay; start: { x: number; y: number }; gesture: ReturnType<typeof beginGesture> }
  | { kind: "box"; pageId: string; id: string; original: Overlay; handle: string; gesture: ReturnType<typeof beginGesture> }
  | { kind: "point"; pageId: string; id: string; handle: string; gesture: ReturnType<typeof beginGesture> }
  | { kind: "scale"; pageId: string; id: string; original: Overlay; pivot: { x: number; y: number }; startDistance: number; gesture: ReturnType<typeof beginGesture> }
  | { kind: "draw"; pageId: string; tool: ToolId; start: { x: number; y: number } };

let drag: Drag | null = null;

const flushOverlays = rafThrottle((pageId: string) => {
  const slot = slots.get(pageId);
  if (slot) {
    renderOverlays(slot);
  }
});

function findOverlay(pageId: string, id: string) {
  return getPage(pageId)?.overlays.find((overlay) => overlay.id === id) ?? null;
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) {
    return;
  }
  const target = event.target as HTMLElement;
  const sheet = target.closest<HTMLElement>(".page-sheet");
  const slotEl = sheet?.closest<HTMLElement>(".page-slot");
  const pageId = slotEl?.dataset.pageId;
  const slot = pageId ? slots.get(pageId) : undefined;
  const page = pageId ? getPage(pageId) : null;
  if (!sheet || !slot || !page) {
    return;
  }

  if (editing && !editing.body.contains(target)) {
    finishInlineEdit();
  }
  if (editing) {
    return;
  }

  setActivePage(page.id);
  if (state.selectedPageIds.size <= 1) {
    state.selectedPageIds = new Set([page.id]);
    state.anchorPageId = page.id;
  }

  const handleEl = target.closest<HTMLElement>("[data-handle]");
  const overlayEl = target.closest<HTMLElement>("[data-ov]");
  const point = pointOnSheet(event, sheet);

  // Tay nắm của overlay đang chọn
  if (handleEl && overlayEl && state.selected) {
    const overlay = findOverlay(page.id, overlayEl.dataset.ov ?? "");
    if (overlay) {
      event.preventDefault();
      sheet.setPointerCapture(event.pointerId);
      const handle = handleEl.dataset.handle ?? "";
      const gesture = beginGesture();
      if (handle === "p1" || handle === "p2") {
        drag = { kind: "point", pageId: page.id, id: overlay.id, handle, gesture };
      } else if (handle === "scale") {
        const pivot = { x: (overlay as { x: number }).x, y: (overlay as { y: number }).y };
        const bounds = sheet.getBoundingClientRect();
        const px = event.clientX - bounds.left - pivot.x * bounds.width;
        const py = event.clientY - bounds.top - pivot.y * bounds.height;
        drag = {
          kind: "scale",
          pageId: page.id,
          id: overlay.id,
          original: structuredClone(overlay),
          pivot,
          startDistance: Math.max(Math.hypot(px, py), 8),
          gesture,
        };
      } else {
        drag = { kind: "box", pageId: page.id, id: overlay.id, original: structuredClone(overlay), handle, gesture };
      }
      return;
    }
  }

  if (state.tool === "select") {
    if (overlayEl) {
      const overlay = findOverlay(page.id, overlayEl.dataset.ov ?? "");
      if (overlay) {
        event.preventDefault();
        selectOverlay(page.id, overlay.id);
        sheet.setPointerCapture(event.pointerId);
        drag = {
          kind: "move",
          pageId: page.id,
          id: overlay.id,
          original: structuredClone(overlay),
          start: pointOnSheet(event, sheet, false),
          gesture: beginGesture(),
        };
      }
    } else {
      clearSelection();
    }
    return;
  }

  if (state.tool === "text") {
    event.preventDefault();
    const existing = overlayEl ? findOverlay(page.id, overlayEl.dataset.ov ?? "") : null;
    if (existing?.type === "text") {
      setTool("select");
      selectOverlay(page.id, existing.id);
      startInlineEdit(page.id, existing.id, beginGesture(), false);
      return;
    }
    createTextAt(page, point);
    return;
  }

  if (DRAW_TOOLS.includes(state.tool)) {
    event.preventDefault();
    sheet.setPointerCapture(event.pointerId);
    drag = { kind: "draw", pageId: page.id, tool: state.tool, start: point };

    if (state.tool === "pen") {
      slot.draft = makeOverlay("pen", { points: [point.x, point.y] });
    } else if (state.tool === "line" || state.tool === "arrow") {
      slot.draft = makeOverlay(state.tool, { x1: point.x, y1: point.y, x2: point.x, y2: point.y });
    } else {
      slot.draft = makeOverlay(state.tool as "rect", { x: point.x, y: point.y, w: 0, h: 0 });
    }
    renderOverlays(slot);
  }
}

function onPointerMove(event: PointerEvent) {
  if (!drag) {
    return;
  }
  const sheet = getSheet(drag.pageId);
  const slot = slots.get(drag.pageId);
  if (!sheet || !slot) {
    return;
  }

  if (drag.kind === "draw") {
    const point = pointOnSheet(event, sheet);
    const draft = slot.draft;
    if (!draft) {
      return;
    }
    if (draft.type === "pen") {
      draft.points.push(point.x, point.y);
    } else if (draft.type === "line" || draft.type === "arrow") {
      let { x, y } = point;
      if (event.shiftKey) {
        ({ x, y } = snapAngle(drag.start, point, slot.width, slot.height));
      }
      draft.x2 = x;
      draft.y2 = y;
    } else if ("w" in draft) {
      let end = point;
      if (event.shiftKey && (draft.type === "rect" || draft.type === "ellipse")) {
        const dx = point.x - drag.start.x;
        const dy = point.y - drag.start.y;
        const size = Math.max(Math.abs(dx * slot.width), Math.abs(dy * slot.height));
        end = {
          x: drag.start.x + (Math.sign(dx) || 1) * (size / slot.width),
          y: drag.start.y + (Math.sign(dy) || 1) * (size / slot.height),
        };
      }
      Object.assign(draft, normalizeRect(drag.start.x, drag.start.y, end.x, end.y));
    }
    flushOverlays(slot.id);
    return;
  }

  const overlay = findOverlay(drag.pageId, drag.id);
  if (!overlay) {
    return;
  }

  if (drag.kind === "move") {
    const point = pointOnSheet(event, sheet, false);
    Object.assign(overlay, structuredClone(drag.original));
    moveOverlay(overlay, point.x - drag.start.x, point.y - drag.start.y);
  } else if (drag.kind === "box" && "w" in overlay && "w" in drag.original) {
    const point = pointOnSheet(event, sheet);
    const original = drag.original;
    let x0 = original.x;
    let y0 = original.y;
    let x1 = original.x + original.w;
    let y1 = original.y + original.h;
    if (drag.handle.includes("w")) x0 = point.x;
    if (drag.handle.includes("e")) x1 = point.x;
    if (drag.handle.includes("n")) y0 = point.y;
    if (drag.handle.includes("s")) y1 = point.y;
    Object.assign(overlay, normalizeRect(x0, y0, x1, y1));
  } else if (drag.kind === "point" && (overlay.type === "line" || overlay.type === "arrow")) {
    const point = pointOnSheet(event, sheet);
    const fixed = drag.handle === "p1"
      ? { x: overlay.x2, y: overlay.y2 }
      : { x: overlay.x1, y: overlay.y1 };
    let { x, y } = point;
    if (event.shiftKey) {
      ({ x, y } = snapAngle(fixed, point, slot.width, slot.height));
    }
    if (drag.handle === "p1") {
      overlay.x1 = x;
      overlay.y1 = y;
    } else {
      overlay.x2 = x;
      overlay.y2 = y;
    }
  } else if (drag.kind === "scale") {
    const bounds = sheet.getBoundingClientRect();
    const px = event.clientX - bounds.left - drag.pivot.x * bounds.width;
    const py = event.clientY - bounds.top - drag.pivot.y * bounds.height;
    const factor = Math.max(Math.hypot(px, py), 8) / drag.startDistance;
    if (overlay.type === "text" && drag.original.type === "text") {
      overlay.size = Math.round(clamp(drag.original.size * factor, 4, 400) * 10) / 10;
    } else if (overlay.type === "image" && drag.original.type === "image") {
      overlay.wPt = clamp(drag.original.wPt * factor, 12, 4000);
    }
  }

  flushOverlays(drag.pageId);
  bus.emit("props");
}

function snapAngle(
  from: { x: number; y: number },
  to: { x: number; y: number },
  width: number,
  height: number,
) {
  const dx = (to.x - from.x) * width;
  const dy = (to.y - from.y) * height;
  const length = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: from.x + (Math.cos(angle) * length) / width,
    y: from.y + (Math.sin(angle) * length) / height,
  };
}

function onPointerUp(event: PointerEvent) {
  const finished = drag;
  drag = null;
  if (!finished) {
    return;
  }

  const sheet = getSheet(finished.pageId);
  if (sheet?.hasPointerCapture(event.pointerId)) {
    sheet.releasePointerCapture(event.pointerId);
  }

  if (finished.kind !== "draw") {
    if (finished.gesture.end()) {
      bus.emit("pages");
    }
    return;
  }

  const slot = slots.get(finished.pageId);
  const draft = slot?.draft;
  if (!slot || !draft) {
    return;
  }
  slot.draft = null;

  let valid = true;
  if (draft.type === "pen") {
    draft.points = smoothStroke(draft.points, 0.002);
    valid = draft.points.length >= 2;
  } else if (draft.type === "line" || draft.type === "arrow") {
    valid = Math.hypot((draft.x2 - draft.x1) * slot.width, (draft.y2 - draft.y1) * slot.height) > 6;
  } else if ("w" in draft) {
    valid = draft.w * slot.width > 5 && draft.h * slot.height > 5;
  }

  if (!valid) {
    slot.overlayKey = "";
    renderOverlays(slot);
    return;
  }

  const keepSelected = !(draft.type === "pen" || draft.type === "highlight" || draft.type === "cover" || draft.type === "redact");
  addOverlay(finished.pageId, draft, { select: keepSelected });
}

function createTextAt(page: PageItem, point: { x: number; y: number }) {
  const gesture = beginGesture();
  const { h: H } = pageDims(page);
  const size = Number(state.defaults.text.size) || 16;
  const overlay = makeOverlay("text", {
    x: point.x,
    y: Math.max(0, point.y - (size * LINE_HEIGHT * 0.5) / H),
    text: "",
    angle: 0,
  });
  page.overlays.push(overlay);
  state.selected = { pageId: page.id, id: overlay.id };
  setTool("select");
  const slot = slots.get(page.id);
  if (slot) {
    slot.overlayKey = "";
    renderOverlays(slot);
  }
  bus.emit("selection");
  startInlineEdit(page.id, overlay.id, gesture, true);
}

// ----------------------------------------------------------- inline editing

function startInlineEdit(
  pageId: string,
  id: string,
  gesture: ReturnType<typeof beginGesture>,
  selectAll: boolean,
) {
  const slot = slots.get(pageId);
  if (!slot) {
    return;
  }
  slot.overlayKey = "";
  renderOverlays(slot);
  const element = slot.overlayLayer.querySelector<HTMLElement>(`[data-ov="${id}"]`);
  const body = element?.querySelector<HTMLElement>(".ov-text-body");
  if (!element || !body) {
    return;
  }

  element.classList.add("editing");
  body.contentEditable = "plaintext-only";
  if (body.contentEditable !== "plaintext-only") {
    body.contentEditable = "true";
  }
  const overlay = findOverlay(pageId, id);
  if (selectAll && overlay?.type === "text" && !overlay.text) {
    body.textContent = "";
  }
  editing = { pageId, id, gesture, body };
  body.focus();

  const range = document.createRange();
  range.selectNodeContents(body);
  if (!selectAll) {
    range.collapse(false);
  }
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  body.addEventListener("blur", () => finishInlineEdit(), { once: true });
  body.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
      event.preventDefault();
      event.stopPropagation();
      finishInlineEdit();
    }
  });
}

export function finishInlineEdit() {
  const current = editing;
  if (!current) {
    return;
  }
  editing = null;

  const overlay = findOverlay(current.pageId, current.id);
  const page = getPage(current.pageId);
  if (!overlay || overlay.type !== "text" || !page) {
    return;
  }

  const text = (current.body.innerText ?? "").replace(/​/g, "").replace(/\n$/, "");
  if (!text.trim()) {
    page.overlays = page.overlays.filter((item) => item.id !== overlay.id);
    if (state.selected?.id === overlay.id) {
      state.selected = null;
    }
  } else {
    overlay.text = text;
  }

  current.gesture.end();
  const slot = slots.get(current.pageId);
  if (slot) {
    slot.overlayKey = "";
    renderOverlays(slot);
  }
  bus.emit("pages", "selection");
}

export function editSelectedText() {
  const selection = selectedOverlay();
  if (selection?.overlay.type === "text") {
    startInlineEdit(selection.page.id, selection.overlay.id, beginGesture(), false);
  }
}

export const isEditingInline = () => editing !== null;

// ---------------------------------------------------------------------- init

export function initViewer(container: HTMLElement) {
  scroller = container;
  list = document.createElement("div");
  list.className = "pages";
  scroller.append(list);

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const slot = slots.get((entry.target as HTMLElement).dataset.pageId ?? "");
        if (!slot) {
          continue;
        }
        slot.visible = entry.isIntersecting;
        if (entry.isIntersecting) {
          refreshSlot(slot);
        } else {
          releaseCanvas(slot);
        }
      }
    },
    { root: scroller, rootMargin: "900px 0px" },
  );

  list.addEventListener("pointerdown", onPointerDown);
  list.addEventListener("pointermove", onPointerMove);
  list.addEventListener("pointerup", onPointerUp);
  list.addEventListener("pointercancel", onPointerUp);

  list.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement;
    const overlayEl = target.closest<HTMLElement>("[data-ov]");
    const pageId = target.closest<HTMLElement>(".page-slot")?.dataset.pageId;
    if (!overlayEl || !pageId || state.tool !== "select") {
      return;
    }
    const overlay = findOverlay(pageId, overlayEl.dataset.ov ?? "");
    if (overlay?.type === "text") {
      selectOverlay(pageId, overlay.id);
      startInlineEdit(pageId, overlay.id, beginGesture(), false);
    }
  });

  list.addEventListener("click", (event) => {
    const hit = (event.target as HTMLElement).closest<HTMLElement>(".text-hit");
    if (!hit || state.tool !== "edit-text") {
      return;
    }
    const slotEl = hit.closest<HTMLElement>(".page-slot");
    const slot = slotEl?.dataset.pageId ? slots.get(slotEl.dataset.pageId) : undefined;
    const item = slot?.items[Number(hit.dataset.index)];
    const page = slot ? getPage(slot.id) : null;
    if (slot && item && page) {
      openTextEditBubble({ page, item, hitEl: hit, canvas: slot.canvas });
    }
  });

  scroller.addEventListener("scroll", () => updateActivePage(), { passive: true });
  scroller.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
      }
    },
    { passive: false },
  );

  const resizeObserver = new ResizeObserver(() => {
    if (state.zoomMode !== "manual") {
      layout();
    }
  });
  resizeObserver.observe(scroller);

  const applyToolClass = () => {
    for (const className of [...scroller.classList]) {
      if (className.startsWith("tool-")) {
        scroller.classList.remove(className);
      }
    }
    scroller.classList.add(`tool-${state.tool}`);
    if (DRAW_TOOLS.includes(state.tool)) {
      scroller.classList.add("tool-draw");
    }
  };

  bus.on("pages", () => {
    if (editing) {
      finishInlineEdit();
    }
    reconcile();
  });
  bus.on("props", () => refreshAllOverlays());
  bus.on("selection", () => refreshAllOverlays());
  bus.on("doc", () => refreshAllOverlays());
  bus.on("ui", () => refreshAllOverlays());
  bus.on("zoom", () => layout(true));
  bus.on("tool", () => {
    applyToolClass();
    for (const slot of slots.values()) {
      slot.textKey = "";
      void refreshTextLayer(slot);
    }
    refreshAllOverlays();
  });
  bus.on("search", () => {
    for (const slot of slots.values()) {
      renderSearchLayer(slot);
    }
  });
  bus.on("reveal", () => {
    if (state.reveal) {
      scrollToPage(state.reveal.pageId, state.reveal.smooth);
    }
  });

  applyToolClass();
  reconcile();
}

export function fitToWidth() {
  setZoomMode("fit-width");
}

export function fitToPage() {
  setZoomMode("fit-page");
}
