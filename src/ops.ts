import { rotateOverlayCW } from "./geo";
import {
  bus,
  commit,
  getPage,
  pageDims,
  pushHistory,
  selectedPageIdsInOrder,
  state,
} from "./state";
import type { Overlay, OverlayType, PageItem, Rot, ToolId } from "./types";
import { clamp, uid } from "./util";

// -------------------------------------------------------------- tool & view

export function setTool(tool: ToolId) {
  if (state.tool === tool) {
    return;
  }
  state.tool = tool;
  if (tool !== "select") {
    state.selected = null;
    bus.emit("selection");
  }
  bus.emit("tool");
}

export function requestReveal(pageId: string, smooth = true) {
  state.reveal = { pageId, smooth };
  bus.emit("reveal");
}

export function setActivePage(pageId: string) {
  if (state.activePageId === pageId) {
    return;
  }
  state.activePageId = pageId;
  bus.emit("active");
}

export function setZoomMode(mode: typeof state.zoomMode, manual?: number) {
  state.zoomMode = mode;
  if (manual !== undefined) {
    state.zoom = clamp(manual, 0.2, 5);
  }
  bus.emit("zoom");
}

export function zoomBy(factor: number) {
  setZoomMode("manual", state.scale * factor);
}

// ------------------------------------------------------------ page selection

export function selectOnlyPage(pageId: string) {
  state.selectedPageIds = pageId ? new Set([pageId]) : new Set();
  state.anchorPageId = pageId;
  state.activePageId = pageId || state.activePageId;
}

export function selectPage(pageId: string, mode: { toggle?: boolean; range?: boolean } = {}) {
  if (!getPage(pageId)) {
    return;
  }

  if (mode.range && state.anchorPageId) {
    const from = state.pages.findIndex((page) => page.id === state.anchorPageId);
    const to = state.pages.findIndex((page) => page.id === pageId);
    if (from !== -1 && to !== -1) {
      const [start, end] = from < to ? [from, to] : [to, from];
      const next = mode.toggle ? new Set(state.selectedPageIds) : new Set<string>();
      for (let index = start; index <= end; index += 1) {
        next.add(state.pages[index].id);
      }
      state.selectedPageIds = next;
      state.activePageId = pageId;
    }
  } else if (mode.toggle) {
    const next = new Set(state.selectedPageIds);
    if (next.has(pageId) && next.size > 1) {
      next.delete(pageId);
    } else {
      next.add(pageId);
    }
    state.selectedPageIds = next;
    state.anchorPageId = pageId;
    state.activePageId = pageId;
  } else {
    selectOnlyPage(pageId);
  }

  bus.emit("selection", "active");
}

export function selectAllPages() {
  state.selectedPageIds = new Set(state.pages.map((page) => page.id));
  bus.emit("selection");
}

/** Chọn trang chẵn/lẻ — tiện khi xoá hoặc xoay hàng loạt. */
export function selectParity(parity: "odd" | "even") {
  state.selectedPageIds = new Set(
    state.pages
      .filter((_, index) => (parity === "odd" ? index % 2 === 0 : index % 2 === 1))
      .map((page) => page.id),
  );
  bus.emit("selection");
}

/** Các trang mà thao tác nên áp dụng: tập đang chọn, hoặc trang đang xem. */
export function targetPageIds() {
  const ids = selectedPageIdsInOrder();
  return ids.length ? ids : state.activePageId ? [state.activePageId] : [];
}

// --------------------------------------------------------------- page edits

export function rotatePages(pageIds: string[], direction: 1 | -1) {
  const pages = pageIds.map(getPage).filter((page): page is PageItem => Boolean(page));
  if (!pages.length) {
    return;
  }
  commit(() => {
    for (const page of pages) {
      page.rotation = ((page.rotation + direction * 90 + 360) % 360) as Rot;
      const turns = direction === 1 ? 1 : 3;
      for (const overlay of page.overlays) {
        for (let turn = 0; turn < turns; turn += 1) {
          rotateOverlayCW(overlay);
        }
      }
    }
  }, "pages");
}

export function deletePages(pageIds: string[]) {
  const ids = new Set(pageIds);
  if (!ids.size) {
    return;
  }
  const firstIndex = state.pages.findIndex((page) => ids.has(page.id));
  commit(() => {
    state.pages = state.pages.filter((page) => !ids.has(page.id));
    const next = state.pages[Math.min(firstIndex, state.pages.length - 1)];
    state.selectedPageIds = next ? new Set([next.id]) : new Set();
    state.anchorPageId = next?.id ?? "";
    state.activePageId = next?.id ?? "";
    if (state.selected && ids.has(state.selected.pageId)) {
      state.selected = null;
    }
  }, "pages", "selection", "active");
}

export function duplicatePages(pageIds: string[]) {
  const ids = new Set(pageIds);
  if (!ids.size) {
    return;
  }
  commit(() => {
    const result: PageItem[] = [];
    const created: string[] = [];
    for (const page of state.pages) {
      result.push(page);
      if (ids.has(page.id)) {
        const copy: PageItem = {
          ...page,
          id: uid(),
          overlays: structuredClone(page.overlays).map((overlay) => ({ ...overlay, id: uid() })),
        };
        created.push(copy.id);
        result.push(copy);
      }
    }
    state.pages = result;
    state.selectedPageIds = new Set(created);
    state.activePageId = created[0] ?? state.activePageId;
    state.anchorPageId = state.activePageId;
  }, "pages", "selection", "active");
}

export function insertBlankPage(afterPageId?: string) {
  const reference = getPage(afterPageId ?? state.activePageId) ?? state.pages.at(-1) ?? null;
  const dims = reference ? pageDims(reference) : { w: 595.28, h: 841.89 };
  const blank: PageItem = {
    id: uid(),
    sourceId: null,
    sourceName: "Trang trắng",
    pageIndex: 0,
    baseW: dims.w,
    baseH: dims.h,
    intrinsicRotate: 0,
    rotation: 0,
    overlays: [],
  };
  commit(() => {
    const index = reference ? state.pages.indexOf(reference) + 1 : state.pages.length;
    state.pages.splice(index, 0, blank);
    selectOnlyPage(blank.id);
  }, "pages", "selection", "active");
  return blank.id;
}

export function reversePages() {
  if (state.pages.length < 2) {
    return;
  }
  commit(() => {
    state.pages.reverse();
  }, "pages");
}

/** Đưa nhóm trang đến vị trí `beforeIndex` (chỉ số trong danh sách sau khi đã bỏ nhóm). */
export function movePages(pageIds: string[], beforeIndex: number) {
  const ids = new Set(pageIds);
  const moving = state.pages.filter((page) => ids.has(page.id));
  if (!moving.length) {
    return;
  }
  const rest = state.pages.filter((page) => !ids.has(page.id));
  const index = clamp(beforeIndex, 0, rest.length);
  const next = [...rest.slice(0, index), ...moving, ...rest.slice(index)];
  if (next.every((page, position) => page === state.pages[position])) {
    return;
  }
  commit(() => {
    state.pages = next;
  }, "pages");
}

export function moveSelectedPages(direction: -1 | 1) {
  const ids = selectedPageIdsInOrder();
  if (!ids.length) {
    return;
  }
  const indexes = ids.map((id) => state.pages.findIndex((page) => page.id === id));
  const first = Math.min(...indexes);
  const last = Math.max(...indexes);
  if ((direction === -1 && first === 0) || (direction === 1 && last === state.pages.length - 1)) {
    return;
  }
  const rest = state.pages.filter((page) => !ids.includes(page.id));
  movePages(ids, direction === -1 ? first - 1 : first + 1 > rest.length ? rest.length : first + 1);
}

// ----------------------------------------------------------------- overlays

export function makeOverlay(type: OverlayType, init: Record<string, unknown>): Overlay {
  return { id: uid(), type, ...state.defaults[type], ...init } as unknown as Overlay;
}

export function addOverlay(pageId: string, overlay: Overlay, options: { select?: boolean } = {}) {
  const page = getPage(pageId);
  if (!page) {
    return;
  }
  commit(() => {
    page.overlays.push(overlay);
    if (options.select !== false) {
      state.selected = { pageId, id: overlay.id };
    }
  }, "pages", "selection");
}

export function selectOverlay(pageId: string, id: string) {
  if (state.selected?.id === id && state.selected.pageId === pageId) {
    return;
  }
  state.selected = { pageId, id };
  state.activePageId = pageId;
  bus.emit("selection", "active");
}

export function clearSelection() {
  if (!state.selected) {
    return;
  }
  state.selected = null;
  bus.emit("selection");
}

let lastCoalesceKey = "";
let lastCoalesceAt = 0;

/** Sửa thuộc tính overlay; các thay đổi liên tiếp cùng khoá (kéo slider...) gộp thành một bước hoàn tác. */
export function updateOverlay(pageId: string, id: string, patch: Partial<Overlay> & Record<string, unknown>) {
  const page = getPage(pageId);
  const overlay = page?.overlays.find((item) => item.id === id);
  if (!page || !overlay) {
    return;
  }

  const key = `${id}:${Object.keys(patch).sort().join(",")}`;
  const now = performance.now();
  if (key !== lastCoalesceKey || now - lastCoalesceAt > 700) {
    pushHistory();
  }
  lastCoalesceKey = key;
  lastCoalesceAt = now;

  Object.assign(overlay, patch);
  bus.emit("props");
}

export function removeOverlay(pageId: string, id: string) {
  const page = getPage(pageId);
  if (!page) {
    return;
  }
  commit(() => {
    page.overlays = page.overlays.filter((overlay) => overlay.id !== id);
    if (state.selected?.id === id) {
      state.selected = null;
    }
  }, "pages", "selection");
}

export function duplicateOverlay(pageId: string, id: string) {
  const page = getPage(pageId);
  const overlay = page?.overlays.find((item) => item.id === id);
  if (!page || !overlay) {
    return;
  }
  const copy = structuredClone(overlay);
  copy.id = uid();
  shiftOverlay(copy, 0.02, 0.02);
  addOverlay(pageId, copy);
}

function shiftOverlay(overlay: Overlay, dx: number, dy: number) {
  switch (overlay.type) {
    case "line":
    case "arrow":
      overlay.x1 += dx;
      overlay.x2 += dx;
      overlay.y1 += dy;
      overlay.y2 += dy;
      break;
    case "pen":
      overlay.points = overlay.points.map((value, index) => value + (index % 2 === 0 ? dx : dy));
      break;
    default:
      overlay.x += dx;
      overlay.y += dy;
  }
}

export function reorderOverlay(pageId: string, id: string, where: "front" | "back") {
  const page = getPage(pageId);
  const index = page?.overlays.findIndex((overlay) => overlay.id === id) ?? -1;
  if (!page || index === -1) {
    return;
  }
  commit(() => {
    const [overlay] = page.overlays.splice(index, 1);
    if (where === "front") {
      page.overlays.push(overlay);
    } else {
      page.overlays.unshift(overlay);
    }
  }, "pages");
}

let clipboard: Overlay | null = null;

export function copySelectedOverlay() {
  if (!state.selected) {
    return false;
  }
  const page = getPage(state.selected.pageId);
  const overlay = page?.overlays.find((item) => item.id === state.selected?.id);
  if (!overlay) {
    return false;
  }
  clipboard = structuredClone(overlay);
  return true;
}

export function pasteOverlay() {
  if (!clipboard) {
    return false;
  }
  const targetId = state.activePageId || state.pages[0]?.id;
  if (!targetId) {
    return false;
  }
  const copy = structuredClone(clipboard);
  copy.id = uid();
  shiftOverlay(copy, 0.02, 0.02);
  addOverlay(targetId, copy);
  return true;
}

export function removeAllOverlays(pageId: string) {
  const page = getPage(pageId);
  if (!page?.overlays.length) {
    return;
  }
  commit(() => {
    page.overlays = [];
    if (state.selected?.pageId === pageId) {
      state.selected = null;
    }
  }, "pages", "selection");
}

// ----------------------------------------------------------- doc settings

let lastDocKey = "";
let lastDocAt = 0;

/** Sửa cài đặt tài liệu (watermark, số trang); thao tác liên tiếp cùng khoá gộp thành một bước hoàn tác. */
export function updateDoc(key: string, fn: (doc: typeof state.doc) => void) {
  const now = performance.now();
  if (key !== lastDocKey || now - lastDocAt > 700) {
    pushHistory();
  }
  lastDocKey = key;
  lastDocAt = now;
  fn(state.doc);
  bus.emit("props");
}

let lastNudgeAt = 0;

/** Dịch overlay đang chọn bằng phím mũi tên (đơn vị px màn hình). */
export function nudgeSelected(dxPx: number, dyPx: number) {
  if (!state.selected) {
    return false;
  }
  const page = getPage(state.selected.pageId);
  const overlay = page?.overlays.find((item) => item.id === state.selected?.id);
  if (!page || !overlay) {
    return false;
  }
  const now = performance.now();
  if (now - lastNudgeAt > 700) {
    pushHistory();
  }
  lastNudgeAt = now;
  const dims = pageDims(page);
  shiftOverlay(overlay, dxPx / (state.scale * dims.w), dyPx / (state.scale * dims.h));
  bus.emit("props");
  return true;
}
