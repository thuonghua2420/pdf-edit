import type {
  DocSettings,
  FontInfo,
  ImageAsset,
  Overlay,
  OverlayType,
  PageItem,
  SourcePdf,
  ToolId,
  ZoomMode,
} from "./types";
import { storageGet } from "./util";

export type Topic =
  | "pages"
  | "props"
  | "selection"
  | "active"
  | "tool"
  | "zoom"
  | "doc"
  | "history"
  | "busy"
  | "search"
  | "ui"
  | "reveal";

const listeners = new Map<Topic, Set<() => void>>();

export const bus = {
  on(topics: Topic | Topic[], fn: () => void) {
    for (const topic of Array.isArray(topics) ? topics : [topics]) {
      if (!listeners.has(topic)) {
        listeners.set(topic, new Set());
      }
      listeners.get(topic)?.add(fn);
    }
  },
  emit(...topics: Topic[]) {
    const called = new Set<() => void>();
    for (const topic of topics) {
      for (const fn of listeners.get(topic) ?? []) {
        if (!called.has(fn)) {
          called.add(fn);
          fn();
        }
      }
    }
  },
};

export const defaultDocSettings = (): DocSettings => ({
  watermark: {
    enabled: false,
    text: "BẢN NHÁP",
    family: "arial",
    size: 84,
    color: "#94a3b8",
    opacity: 0.28,
    angle: -35,
  },
  pageNumbers: {
    enabled: false,
    position: "bc",
    format: "{n} / {total}",
    size: 10,
    color: "#475569",
    startAt: 1,
    family: "arial",
  },
});

export type ToolDefaults = Record<string, string | number | boolean>;

const defaultToolOptions = (): Record<OverlayType, ToolDefaults> => ({
  text: { family: "arial", size: 16, color: "#111827", bold: false, italic: false, opacity: 1 },
  highlight: { color: "#fde047", opacity: 0.55 },
  cover: { color: "#ffffff", opacity: 1 },
  redact: { color: "#000000", opacity: 1 },
  pen: { stroke: "#ef4444", strokeWidth: 2.5, opacity: 1 },
  rect: { stroke: "#2563eb", strokeWidth: 2, fill: "", opacity: 1 },
  ellipse: { stroke: "#2563eb", strokeWidth: 2, fill: "", opacity: 1 },
  line: { stroke: "#2563eb", strokeWidth: 2.5, opacity: 1 },
  arrow: { stroke: "#2563eb", strokeWidth: 2.5, opacity: 1 },
  image: { opacity: 1 },
});

export type SearchHit = {
  pageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export const state = {
  sources: new Map<string, SourcePdf>(),
  images: new Map<string, ImageAsset>(),
  pages: [] as PageItem[],
  activePageId: "",
  selectedPageIds: new Set<string>(),
  anchorPageId: "",
  selected: null as { pageId: string; id: string } | null,
  tool: "select" as ToolId,
  defaults: defaultToolOptions(),
  zoomMode: "fit-width" as ZoomMode,
  /** Hệ số zoom thủ công: số px CSS trên mỗi pt. */
  zoom: 1.2,
  /** Hệ số thực tế đang hiển thị (do viewer cập nhật). */
  scale: 1,
  fileName: "tai-lieu",
  doc: defaultDocSettings(),
  busy: null as string | null,
  theme: storageGet<"light" | "dark">("pdf.theme", window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  leftOpen: storageGet("pdf.leftOpen", true),
  rightOpen: storageGet("pdf.rightOpen", true),
  fonts: [] as FontInfo[],
  reveal: null as { pageId: string; smooth: boolean } | null,
  search: {
    open: false,
    query: "",
    ignoreDiacritics: true,
    hits: [] as SearchHit[],
    index: -1,
  },
};

// ---------------------------------------------------------------- selectors

export const getPage = (pageId: string) =>
  state.pages.find((page) => page.id === pageId) ?? null;

export const pageNumber = (pageId: string) =>
  state.pages.findIndex((page) => page.id === pageId) + 1;

export const activePage = () => getPage(state.activePageId);

export const selectedPageIdsInOrder = () =>
  state.pages.filter((page) => state.selectedPageIds.has(page.id)).map((page) => page.id);

export function pageDims(page: PageItem) {
  return page.rotation % 180 === 0
    ? { w: page.baseW, h: page.baseH }
    : { w: page.baseH, h: page.baseW };
}

export function selectedOverlay(): { page: PageItem; overlay: Overlay } | null {
  if (!state.selected) {
    return null;
  }
  const page = getPage(state.selected.pageId);
  const overlay = page?.overlays.find((item) => item.id === state.selected?.id);
  return page && overlay ? { page, overlay } : null;
}

export const totalOverlayCount = () =>
  state.pages.reduce((sum, page) => sum + page.overlays.length, 0);

// ------------------------------------------------------------------ history

type Snapshot = {
  pages: PageItem[];
  doc: DocSettings;
  activePageId: string;
  selectedPageIds: string[];
};

const past: Snapshot[] = [];
const future: Snapshot[] = [];
const HISTORY_LIMIT = 120;
let editCount = 0;

const clonePage = (page: PageItem): PageItem => ({
  ...page,
  overlays: structuredClone(page.overlays),
});

function takeSnapshot(): Snapshot {
  return {
    pages: state.pages.map(clonePage),
    doc: structuredClone(state.doc),
    activePageId: state.activePageId,
    selectedPageIds: [...state.selectedPageIds],
  };
}

function signature() {
  return JSON.stringify([
    state.pages.map((page) => [page.id, page.rotation, page.sourceId, page.pageIndex, page.overlays]),
    state.doc,
  ]);
}

function pushSnapshot(snapshot: Snapshot) {
  past.push(snapshot);
  if (past.length > HISTORY_LIMIT) {
    past.shift();
  }
  future.length = 0;
  editCount += 1;
  bus.emit("history");
}

/** Ghi nhớ trạng thái TRƯỚC khi thay đổi. */
export function pushHistory() {
  pushSnapshot(takeSnapshot());
}

/** Dùng cho thao tác kéo/thả: chỉ ghi vào lịch sử nếu dữ liệu thực sự đổi. */
export function beginGesture() {
  const snapshot = takeSnapshot();
  const before = signature();
  return {
    end() {
      if (signature() === before) {
        return false;
      }
      pushSnapshot(snapshot);
      return true;
    },
  };
}

function restore(snapshot: Snapshot) {
  state.pages = snapshot.pages;
  state.doc = snapshot.doc;

  const pageIds = new Set(state.pages.map((page) => page.id));
  state.selectedPageIds = new Set(snapshot.selectedPageIds.filter((id) => pageIds.has(id)));
  state.activePageId = pageIds.has(snapshot.activePageId)
    ? snapshot.activePageId
    : state.pages[0]?.id ?? "";
  if (!state.selectedPageIds.size && state.activePageId) {
    state.selectedPageIds.add(state.activePageId);
  }
  if (state.selected && !selectedOverlay()) {
    state.selected = null;
  }
}

export function undo() {
  const snapshot = past.pop();
  if (!snapshot) {
    return false;
  }
  future.push(takeSnapshot());
  editCount -= 1;
  restore(snapshot);
  bus.emit("pages", "selection", "doc", "history");
  return true;
}

export function redo() {
  const snapshot = future.pop();
  if (!snapshot) {
    return false;
  }
  past.push(takeSnapshot());
  editCount += 1;
  restore(snapshot);
  bus.emit("pages", "selection", "doc", "history");
  return true;
}

export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;
export const editsSinceOpen = () => editCount;

export function clearHistory() {
  past.length = 0;
  future.length = 0;
  editCount = 0;
  bus.emit("history");
}

/** Thay đổi có ghi lịch sử. */
export function commit(fn: () => void, ...topics: Topic[]) {
  pushHistory();
  fn();
  bus.emit(...(topics.length ? topics : (["pages"] as Topic[])));
}
