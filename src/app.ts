import { openExportDialog } from "./exportDialog";
import { loadFontList } from "./fonts";
import { closeDocument, importFiles, isSupportedFile } from "./importer";
import { initInspector } from "./inspector";
import { icon, type IconName } from "./icons";
import { openSignatureDialog, openStampDialog } from "./insertDialogs";
import {
  requestReveal,
  setActivePage,
  setTool,
  setZoomMode,
  zoomBy,
} from "./ops";
import { initSearch, openSearch } from "./search";
import { chooseImageToInsert, initShortcuts, openShortcutsDialog } from "./shortcuts";
import {
  bus,
  canRedo,
  canUndo,
  editsSinceOpen,
  redo,
  state,
  undo,
} from "./state";
import { initThumbs } from "./thumbs";
import type { ToolId } from "./types";
import { confirmDialog, openPopover, pickFiles, toast } from "./ui";
import { storageSet } from "./util";
import { initViewer } from "./viewer";

type ToolDef = { id: ToolId; icon: IconName; label: string; key: string };

const TOOL_DEFS: Record<string, ToolDef> = {
  select: { id: "select", icon: "pointer", label: "Chọn", key: "V" },
  text: { id: "text", icon: "type", label: "Chữ", key: "T" },
  "edit-text": { id: "edit-text", icon: "edit-text", label: "Sửa gốc", key: "E" },
  highlight: { id: "highlight", icon: "highlighter", label: "Tô sáng", key: "H" },
  pen: { id: "pen", icon: "pencil", label: "Bút vẽ", key: "P" },
  rect: { id: "rect", icon: "square", label: "Chữ nhật", key: "R" },
  ellipse: { id: "ellipse", icon: "circle", label: "Elip", key: "O" },
  line: { id: "line", icon: "minus", label: "Đường thẳng", key: "L" },
  arrow: { id: "arrow", icon: "arrow-up-right", label: "Mũi tên", key: "A" },
  cover: { id: "cover", icon: "square", label: "Che", key: "W" },
  redact: { id: "redact", icon: "eye-off", label: "Xóa thật", key: "X" },
};

const SHAPE_TOOLS: ToolId[] = ["rect", "ellipse", "line", "arrow"];
let lastShape: ToolId = "rect";

const LOGO = `<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="9" fill="url(#lg)"/><defs><linearGradient id="lg" x1="0" y1="0" x2="32" y2="32"><stop stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><path d="M10 7h8l5 5v13a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" fill="#fff" fill-opacity=".95"/><path d="M18 7v5h5" fill="none" stroke="#6366f1" stroke-width="1.6" stroke-linejoin="round"/><path d="M12.5 17.5h7M12.5 21h4.5" stroke="#6366f1" stroke-width="1.7" stroke-linecap="round"/></svg>`;

const ACCEPT = ".pdf,.doc,.docx,.rtf,.odt,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";

async function addFiles() {
  const files = await pickFiles(ACCEPT, true);
  if (files.length) {
    await importFiles(files);
  }
}

function toolButton(tool: ToolDef) {
  return `
    <button class="rail-btn ${state.tool === tool.id ? "on" : ""}" data-tool="${tool.id}" data-tip="${tool.label} (${tool.key})" aria-label="${tool.label}" aria-pressed="${state.tool === tool.id}" ${state.pages.length || tool.id === "select" ? "" : "disabled"}>
      ${icon(tool.icon, 21)}
      <span>${tool.label}</span>
    </button>`;
}

function renderRail(rail: HTMLElement) {
  const shapeDef = TOOL_DEFS[lastShape];
  const shapeActive = SHAPE_TOOLS.includes(state.tool);
  const disabled = state.pages.length ? "" : "disabled";
  rail.innerHTML = `
    ${toolButton(TOOL_DEFS.select)}
    <div class="rail-sep"></div>
    ${toolButton(TOOL_DEFS.text)}
    ${toolButton(TOOL_DEFS["edit-text"])}
    ${toolButton(TOOL_DEFS.highlight)}
    ${toolButton(TOOL_DEFS.pen)}
    <div class="rail-group">
      <button class="rail-btn ${shapeActive ? "on" : ""}" data-tool="${lastShape}" data-tip="Hình vẽ: ${shapeDef.label} (${shapeDef.key})" aria-label="Hình vẽ" ${disabled}>
        ${icon(shapeDef.icon, 21)}
        <span>Hình vẽ</span>
      </button>
      <button class="rail-caret" data-flyout="shapes" aria-label="Chọn loại hình" ${disabled}>${icon("chevron-right", 12)}</button>
    </div>
    <div class="rail-sep"></div>
    ${toolButton(TOOL_DEFS.cover)}
    ${toolButton(TOOL_DEFS.redact)}
    <div class="rail-sep"></div>
    <button class="rail-btn" data-insert data-tip="Chèn ảnh, chữ ký, con dấu" aria-label="Chèn" ${disabled}>
      ${icon("image", 21)}
      <span>Chèn</span>
    </button>`;
}

function openInsertMenu(anchor: HTMLElement) {
  const popover = openPopover(
    anchor,
    `
    <div class="menu">
      <button class="menu-item" data-insert-kind="image">${icon("image", 18)}<span><b>Ảnh</b><small>PNG, JPG, WebP… <kbd>I</kbd></small></span></button>
      <button class="menu-item" data-insert-kind="signature">${icon("signature", 18)}<span><b>Chữ ký</b><small>Vẽ tay hoặc gõ tên <kbd>S</kbd></small></span></button>
      <button class="menu-item" data-insert-kind="stamp">${icon("stamp", 18)}<span><b>Con dấu</b><small>Đã duyệt, Mật, Bản sao…</small></span></button>
    </div>`,
  );
  popover.el.addEventListener("click", (event) => {
    const kind = (event.target as HTMLElement).closest<HTMLElement>("[data-insert-kind]")?.dataset.insertKind;
    if (!kind) {
      return;
    }
    popover.close();
    if (kind === "image") void chooseImageToInsert();
    else if (kind === "signature") openSignatureDialog();
    else openStampDialog();
  });
}

function openShapeMenu(anchor: HTMLElement) {
  const popover = openPopover(
    anchor,
    `<div class="menu">${SHAPE_TOOLS.map((id) => {
      const def = TOOL_DEFS[id];
      return `<button class="menu-item compact ${state.tool === id ? "on" : ""}" data-shape="${id}">${icon(def.icon, 18)}<span><b>${def.label}</b></span><kbd>${def.key}</kbd></button>`;
    }).join("")}</div>`,
  );
  popover.el.addEventListener("click", (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-shape]")?.dataset.shape as ToolId | undefined;
    if (id) {
      lastShape = id;
      setTool(id);
      popover.close();
    }
  });
}

function zoomPercent() {
  return `${Math.round(state.scale * 75)}%`;
}

const narrowScreen = () => window.innerWidth <= 1020;

export function bootstrap(root: HTMLElement) {
  document.documentElement.dataset.theme = state.theme;
  if (narrowScreen()) {
    // Màn hình hẹp: hai bảng bên phủ lên vùng xem, nên mặc định thu gọn.
    state.leftOpen = false;
    state.rightOpen = false;
  }

  root.innerHTML = `
    <div class="app" id="app-shell">
      <header class="topbar">
        <div class="brand">${LOGO}<span class="brand-name">Support PDF</span></div>
        <div class="doc-title" id="doc-title"></div>
        <div class="topbar-group" id="tb-history"></div>
        <div class="spacer"></div>
        <div class="topbar-group" id="tb-view"></div>
        <div class="topbar-group" id="tb-actions"></div>
      </header>

      <div class="workspace">
        <nav class="rail" id="rail" aria-label="Công cụ"></nav>
        <aside class="panel panel-left" id="thumbs" aria-label="Trang"></aside>
        <main class="stage" id="stage">
          <div class="viewer-scroll" id="viewer"></div>
          <div class="float-nav" id="float-nav"></div>
          <div class="welcome" id="welcome"></div>
          <div class="busy-overlay" id="busy" hidden></div>
          <div class="drop-overlay" id="drop-overlay" hidden>
            <div>${icon("upload", 40)}<strong>Thả tệp vào đây</strong><span>PDF, Word hoặc ảnh sẽ được thêm vào cuối tài liệu</span></div>
          </div>
        </main>
        <aside class="panel panel-right" id="inspector" aria-label="Thuộc tính"></aside>
      </div>
    </div>`;

  const shell = root.querySelector("#app-shell") as HTMLElement;
  const stage = root.querySelector("#stage") as HTMLElement;
  const rail = root.querySelector("#rail") as HTMLElement;
  const docTitle = root.querySelector("#doc-title") as HTMLElement;
  const tbHistory = root.querySelector("#tb-history") as HTMLElement;
  const tbView = root.querySelector("#tb-view") as HTMLElement;
  const tbActions = root.querySelector("#tb-actions") as HTMLElement;
  const welcome = root.querySelector("#welcome") as HTMLElement;
  const floatNav = root.querySelector("#float-nav") as HTMLElement;
  const busy = root.querySelector("#busy") as HTMLElement;
  const dropOverlay = root.querySelector("#drop-overlay") as HTMLElement;

  // --------------------------------------------------------------- topbar
  const renderTitle = () => {
    const hasDoc = state.pages.length > 0;
    const edits = editsSinceOpen();
    docTitle.innerHTML = `
      <div class="title-box ${hasDoc ? "" : "empty"}">
        ${icon("file-text", 17)}
        <input id="title-input" value="${hasDoc ? state.fileName.replace(/"/g, "&quot;") : ""}" placeholder="Chưa có tài liệu" aria-label="Tên tài liệu" ${hasDoc ? "" : "disabled"} spellcheck="false" />
        <span class="title-ext">.pdf</span>
      </div>
      ${hasDoc ? `<span class="chip-status ${edits ? "dirty" : ""}">${edits ? `${edits} thay đổi` : "Chưa chỉnh sửa"}</span>
      <button class="icon-btn" id="close-doc" data-tip="Đóng tài liệu" aria-label="Đóng tài liệu">${icon("x", 16)}</button>` : ""}`;
  };

  const renderHistory = () => {
    tbHistory.innerHTML = `
      <button class="icon-btn" id="btn-undo" data-tip="Hoàn tác (Ctrl+Z)" aria-label="Hoàn tác" ${canUndo() ? "" : "disabled"}>${icon("undo", 19)}</button>
      <button class="icon-btn" id="btn-redo" data-tip="Làm lại (Ctrl+Y)" aria-label="Làm lại" ${canRedo() ? "" : "disabled"}>${icon("redo", 19)}</button>`;
  };

  const renderActions = () => {
    const hasDoc = state.pages.length > 0;
    tbView.innerHTML = `
      <button class="icon-btn" id="btn-search" data-tip="Tìm kiếm (Ctrl+F)" aria-label="Tìm kiếm" ${hasDoc ? "" : "disabled"}>${icon("search", 19)}</button>
      <button class="icon-btn ${state.leftOpen ? "on" : ""}" id="btn-left" data-tip="Ẩn/hiện danh sách trang" aria-label="Danh sách trang">${icon("panel-left", 19)}</button>
      <button class="icon-btn ${state.rightOpen ? "on" : ""}" id="btn-right" data-tip="Ẩn/hiện thuộc tính" aria-label="Thuộc tính">${icon("panel-right", 19)}</button>
      <button class="icon-btn" id="btn-theme" data-tip="${state.theme === "dark" ? "Giao diện sáng" : "Giao diện tối"}" aria-label="Đổi giao diện">${icon(state.theme === "dark" ? "sun" : "moon", 19)}</button>
      <button class="icon-btn" id="btn-help" data-tip="Phím tắt (?)" aria-label="Phím tắt">${icon("keyboard", 19)}</button>`;
    tbActions.innerHTML = `
      <button class="btn" id="btn-add">${icon("file-plus-2", 17)} Thêm tệp</button>
      <button class="btn primary" id="btn-export" ${hasDoc ? "" : "disabled"}>${icon("download", 17)} Xuất tệp</button>`;
  };

  root.querySelector(".topbar")?.addEventListener("click", async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("button");
    if (!target) {
      return;
    }
    switch (target.id) {
      case "btn-undo":
        undo();
        break;
      case "btn-redo":
        redo();
        break;
      case "btn-search":
        openSearch();
        break;
      case "btn-left":
        state.leftOpen = !state.leftOpen;
        if (state.leftOpen && narrowScreen()) state.rightOpen = false;
        storageSet("pdf.leftOpen", state.leftOpen);
        applyPanels();
        break;
      case "btn-right":
        state.rightOpen = !state.rightOpen;
        if (state.rightOpen && narrowScreen()) state.leftOpen = false;
        storageSet("pdf.rightOpen", state.rightOpen);
        applyPanels();
        break;
      case "btn-theme":
        state.theme = state.theme === "dark" ? "light" : "dark";
        storageSet("pdf.theme", state.theme);
        document.documentElement.dataset.theme = state.theme;
        renderActions();
        break;
      case "btn-help":
        openShortcutsDialog();
        break;
      case "btn-add":
        await addFiles();
        break;
      case "btn-export":
        openExportDialog();
        break;
      case "close-doc": {
        const confirmed = editsSinceOpen() === 0 || await confirmDialog({
          title: "Đóng tài liệu?",
          message: "Mọi chỉnh sửa chưa xuất ra tệp sẽ bị mất.",
          confirmLabel: "Đóng tài liệu",
          danger: true,
        });
        if (confirmed) {
          await closeDocument();
        }
        break;
      }
    }
  });

  docTitle.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.id === "title-input") {
      state.fileName = target.value;
    }
  });

  const applyPanels = () => {
    shell.dataset.left = state.leftOpen ? "open" : "closed";
    shell.dataset.right = state.rightOpen ? "open" : "closed";
    renderActions();
  };

  // ----------------------------------------------------------------- rail
  rail.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const toolBtn = target.closest<HTMLElement>("[data-tool]");
    const flyout = target.closest<HTMLElement>("[data-flyout]");
    const insert = target.closest<HTMLElement>("[data-insert]");
    if (flyout) {
      openShapeMenu(flyout);
    } else if (insert) {
      openInsertMenu(insert);
    } else if (toolBtn && !(toolBtn as HTMLButtonElement).disabled) {
      const tool = toolBtn.dataset.tool as ToolId;
      if (SHAPE_TOOLS.includes(tool)) {
        lastShape = tool;
      }
      setTool(state.tool === tool && tool !== "select" ? "select" : tool);
    }
  });

  // -------------------------------------------------------------- welcome
  const renderWelcome = () => {
    const hasDoc = state.pages.length > 0;
    welcome.hidden = hasDoc;
    floatNav.hidden = !hasDoc;
    if (hasDoc) {
      welcome.innerHTML = "";
      return;
    }
    welcome.innerHTML = `
      <div class="welcome-card">
        <div class="welcome-art">${LOGO}</div>
        <h1>Chỉnh sửa PDF thật dễ</h1>
        <p>Kéo thả tệp vào đây hoặc chọn từ máy tính. Mọi thao tác chạy ngay trên máy của bạn.</p>
        <button class="btn primary large" id="welcome-open">${icon("file-up", 20)} Chọn tệp PDF, Word hoặc ảnh</button>
        <span class="welcome-hint">hoặc nhấn <kbd>Ctrl</kbd> + <kbd>O</kbd></span>
        <div class="feature-grid">
          <div class="feature">${icon("edit-text", 20)}<b>Sửa chữ gốc</b><span>Đổi nội dung có sẵn trong PDF</span></div>
          <div class="feature">${icon("signature", 20)}<b>Ký tên & đóng dấu</b><span>Vẽ tay, gõ tên hoặc chọn mẫu</span></div>
          <div class="feature">${icon("eye-off", 20)}<b>Che vĩnh viễn</b><span>Xóa thật thông tin nhạy cảm</span></div>
          <div class="feature">${icon("files", 20)}<b>Gộp & sắp xếp</b><span>Kéo thả, xoay, tách trang</span></div>
          <div class="feature">${icon("droplets", 20)}<b>Dấu chìm & số trang</b><span>Áp dụng cho cả tài liệu</span></div>
          <div class="feature">${icon("lock", 20)}<b>Mật khẩu & nén</b><span>Bảo vệ và giảm dung lượng</span></div>
        </div>
      </div>`;
    welcome.querySelector("#welcome-open")?.addEventListener("click", () => void addFiles());
  };

  // ------------------------------------------------------------ float nav
  const renderFloatNav = () => {
    const index = state.pages.findIndex((page) => page.id === state.activePageId);
    const total = state.pages.length;
    const input = floatNav.querySelector<HTMLInputElement>("#nav-page");
    if (input && document.activeElement === input) {
      return;
    }
    floatNav.innerHTML = `
      <button class="icon-btn" data-nav="prev" aria-label="Trang trước" data-tip="Trang trước (PgUp)">${icon("chevron-up", 18)}</button>
      <div class="nav-page"><input id="nav-page" type="text" inputmode="numeric" value="${index + 1}" aria-label="Số trang" /> <span>/ ${total}</span></div>
      <button class="icon-btn" data-nav="next" aria-label="Trang sau" data-tip="Trang sau (PgDn)">${icon("chevron-down", 18)}</button>
      <span class="nav-sep"></span>
      <button class="icon-btn" data-nav="zoom-out" aria-label="Thu nhỏ" data-tip="Thu nhỏ (−)">${icon("zoom-out", 18)}</button>
      <button class="zoom-readout" data-nav="zoom-reset" data-tip="Bấm để đổi giữa vừa chiều rộng / 100%">${zoomPercent()}</button>
      <button class="icon-btn" data-nav="zoom-in" aria-label="Phóng to" data-tip="Phóng to (+)">${icon("zoom-in", 18)}</button>
      <span class="nav-sep"></span>
      <button class="icon-btn ${state.zoomMode === "fit-width" ? "on" : ""}" data-nav="fit-width" aria-label="Vừa chiều rộng" data-tip="Vừa chiều rộng (Ctrl+0)">${icon("fit-width", 18)}</button>
      <button class="icon-btn ${state.zoomMode === "fit-page" ? "on" : ""}" data-nav="fit-page" aria-label="Vừa cả trang" data-tip="Vừa cả trang (Ctrl+2)">${icon("fit-page", 18)}</button>`;
  };

  floatNav.addEventListener("click", (event) => {
    const nav = (event.target as HTMLElement).closest<HTMLElement>("[data-nav]")?.dataset.nav;
    const index = state.pages.findIndex((page) => page.id === state.activePageId);
    const go = (delta: number) => {
      const next = state.pages[Math.min(Math.max(index + delta, 0), state.pages.length - 1)];
      if (next) {
        setActivePage(next.id);
        state.selectedPageIds = new Set([next.id]);
        bus.emit("selection");
        requestReveal(next.id);
      }
    };
    switch (nav) {
      case "prev":
        go(-1);
        break;
      case "next":
        go(1);
        break;
      case "zoom-in":
        zoomBy(1.15);
        break;
      case "zoom-out":
        zoomBy(1 / 1.15);
        break;
      case "zoom-reset":
        if (state.zoomMode === "fit-width") setZoomMode("manual", 96 / 72);
        else setZoomMode("fit-width");
        break;
      case "fit-width":
        setZoomMode("fit-width");
        break;
      case "fit-page":
        setZoomMode("fit-page");
        break;
    }
  });
  floatNav.addEventListener("keydown", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== "nav-page") {
      return;
    }
    if (event.key === "Enter") {
      const page = state.pages[Math.min(Math.max(Number.parseInt(input.value, 10) || 1, 1), state.pages.length) - 1];
      if (page) {
        setActivePage(page.id);
        state.selectedPageIds = new Set([page.id]);
        bus.emit("selection");
        requestReveal(page.id);
      }
      input.blur();
    } else if (event.key === "Escape") {
      input.blur();
    }
  });
  floatNav.addEventListener("focusin", (event) => {
    if ((event.target as HTMLElement).id === "nav-page") {
      (event.target as HTMLInputElement).select();
    }
  });
  floatNav.addEventListener("focusout", () => renderFloatNav());

  // ----------------------------------------------------------- busy overlay
  const renderBusy = () => {
    busy.hidden = !state.busy;
    busy.innerHTML = state.busy
      ? `<div class="busy-card"><span class="spinner"></span><span>${state.busy.replace(/[<>&]/g, "")}</span></div>`
      : "";
  };

  // --------------------------------------------------------- drag & drop
  let dragDepth = 0;
  const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes("Files");
  window.addEventListener("dragenter", (event) => {
    if (hasFiles(event)) {
      dragDepth += 1;
      dropOverlay.hidden = false;
    }
  });
  window.addEventListener("dragleave", (event) => {
    if (hasFiles(event)) {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) {
        dropOverlay.hidden = true;
      }
    }
  });
  window.addEventListener("dragover", (event) => {
    if (hasFiles(event)) {
      event.preventDefault();
    }
  });
  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.some(isSupportedFile)) {
      void importFiles(files);
    } else if (files.length) {
      toast("Chỉ hỗ trợ PDF, Word (.doc/.docx), PNG hoặc JPG.", "error");
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (state.pages.length && editsSinceOpen() > 0) {
      event.preventDefault();
    }
  });

  // -------------------------------------------------------------- wiring
  initThumbs(root.querySelector("#thumbs") as HTMLElement);
  initInspector(root.querySelector("#inspector") as HTMLElement);
  initViewer(root.querySelector("#viewer") as HTMLElement);
  initSearch(stage);
  initShortcuts();

  bus.on("pages", () => {
    renderActions();
    renderTitle();
    renderWelcome();
    renderRail(rail);
    renderFloatNav();
  });
  bus.on("doc", () => {
    renderActions();
    renderTitle();
    renderWelcome();
    renderRail(rail);
  });
  bus.on("history", () => {
    renderHistory();
    renderTitle();
  });
  bus.on("tool", () => renderRail(rail));
  bus.on(["active", "zoom"], renderFloatNav);
  bus.on("busy", renderBusy);
  bus.on("search", () => {
    stage.classList.toggle("searching", state.search.open);
  });

  applyPanels();
  renderTitle();
  renderHistory();
  renderRail(rail);
  renderWelcome();
  renderFloatNav();
  renderBusy();

  void loadFontList();
}
