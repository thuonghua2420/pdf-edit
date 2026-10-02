import { openExportDialog } from "./exportDialog";
import { importFiles } from "./importer";
import { openSignatureDialog } from "./insertDialogs";
import { placeImageFile } from "./media";
import {
  clearSelection,
  copySelectedOverlay,
  deletePages,
  duplicateOverlay,
  nudgeSelected,
  pasteOverlay,
  removeOverlay,
  requestReveal,
  selectAllPages,
  setActivePage,
  setTool,
  setZoomMode,
  updateOverlay,
  zoomBy,
} from "./ops";
import { closeSearch, openSearch } from "./search";
import { bus, redo, selectedOverlay, state, undo } from "./state";
import { openModal, pickFiles, toast } from "./ui";
import type { ToolId } from "./types";
import { isEditingInline } from "./viewer";

const TOOL_KEYS: Record<string, ToolId> = {
  v: "select",
  t: "text",
  e: "edit-text",
  h: "highlight",
  p: "pen",
  r: "rect",
  o: "ellipse",
  l: "line",
  a: "arrow",
  w: "cover",
  x: "redact",
};

export async function chooseImageToInsert() {
  const [file] = await pickFiles("image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.png,.jpg,.jpeg,.webp,.gif,.svg", false);
  if (!file) {
    return;
  }
  if (!state.pages.length) {
    toast("Hãy mở một tài liệu trước khi chèn ảnh.", "info");
    return;
  }
  try {
    await placeImageFile(file);
  } catch (error) {
    toast(error instanceof Error ? error.message : "Không chèn được ảnh.", "error");
  }
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable
    || target instanceof HTMLInputElement && !["checkbox", "radio", "range", "button"].includes(target.type)
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
  );
}

function stepPage(delta: number) {
  const index = state.pages.findIndex((page) => page.id === state.activePageId);
  const next = state.pages[Math.min(Math.max(index + delta, 0), state.pages.length - 1)];
  if (next) {
    setActivePage(next.id);
    state.selectedPageIds = new Set([next.id]);
    state.anchorPageId = next.id;
    bus.emit("selection");
    requestReveal(next.id);
  }
}

export function openShortcutsDialog() {
  const rows = (items: [string, string][]) =>
    items.map(([keys, label]) => `<div class="kb-row"><span>${label}</span><span class="kb-keys">${keys.split(" ").map((key) => `<kbd>${key}</kbd>`).join("")}</span></div>`).join("");

  openModal({
    title: "Phím tắt",
    subtitle: "Làm việc nhanh hơn mà không cần rời bàn phím",
    width: 680,
    body: `
      <div class="kb-grid">
        <section><h3>Công cụ</h3>${rows([
          ["V", "Chọn / di chuyển"],
          ["T", "Thêm chữ"],
          ["E", "Sửa chữ gốc"],
          ["H", "Tô sáng"],
          ["P", "Bút vẽ"],
          ["R", "Hình chữ nhật"],
          ["O", "Hình elip"],
          ["L", "Đường thẳng"],
          ["A", "Mũi tên"],
          ["W", "Che nội dung"],
          ["X", "Che vĩnh viễn"],
          ["I", "Chèn ảnh"],
          ["S", "Chữ ký"],
        ])}</section>
        <section><h3>Chỉnh sửa</h3>${rows([
          ["Ctrl Z", "Hoàn tác"],
          ["Ctrl Y", "Làm lại"],
          ["Ctrl C", "Sao chép đối tượng"],
          ["Ctrl V", "Dán đối tượng / ảnh"],
          ["Ctrl D", "Nhân bản đối tượng"],
          ["Del", "Xóa đối tượng / trang"],
          ["← ↑ → ↓", "Nhích đối tượng 1px"],
          ["Shift + ←↑→↓", "Nhích 10px"],
          ["Enter", "Sửa chữ đang chọn"],
          ["Esc", "Bỏ chọn / về công cụ Chọn"],
        ])}</section>
        <section><h3>Điều hướng & tệp</h3>${rows([
          ["Ctrl O", "Thêm tệp"],
          ["Ctrl S", "Xuất tệp"],
          ["Ctrl F", "Tìm trong tài liệu"],
          ["Ctrl A", "Chọn tất cả trang"],
          ["PgUp PgDn", "Trang trước / sau"],
          ["+ −", "Phóng to / thu nhỏ"],
          ["Ctrl 0", "Vừa chiều rộng"],
          ["Ctrl 2", "Vừa cả trang"],
          ["Ctrl 1", "Kích thước thật (100%)"],
          ["Ctrl lăn chuột", "Thu phóng"],
          ["?", "Mở bảng này"],
        ])}</section>
      </div>`,
  });
}

export function initShortcuts() {
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) {
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const typing = isTypingTarget(event.target);

    // Phím tắt hoạt động cả khi đang gõ
    if (mod && !event.altKey) {
      if (key === "s" || (key === "e" && event.shiftKey)) {
        event.preventDefault();
        openExportDialog();
        return;
      }
      if (key === "f" && !isEditingInline()) {
        event.preventDefault();
        openSearch();
        return;
      }
      if (key === "o") {
        event.preventDefault();
        void pickFiles(".pdf,.doc,.docx,.rtf,.odt,.png,.jpg,.jpeg", true).then((files) => {
          if (files.length) {
            void importFiles(files);
          }
        });
        return;
      }
    }

    if (typing) {
      return;
    }

    if (mod) {
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        redo();
      } else if (key === "c") {
        if (copySelectedOverlay()) event.preventDefault();
      } else if (key === "d") {
        event.preventDefault();
        const selection = selectedOverlay();
        if (selection) duplicateOverlay(selection.page.id, selection.overlay.id);
      } else if (key === "a") {
        event.preventDefault();
        selectAllPages();
      } else if (key === "0") {
        event.preventDefault();
        setZoomMode("fit-width");
      } else if (key === "2") {
        event.preventDefault();
        setZoomMode("fit-page");
      } else if (key === "1") {
        event.preventDefault();
        setZoomMode("manual", 96 / 72);
      } else if (key === "=" || key === "+") {
        event.preventDefault();
        zoomBy(1.15);
      } else if (key === "-") {
        event.preventDefault();
        zoomBy(1 / 1.15);
      } else if (key === "b" || key === "i") {
        const selection = selectedOverlay();
        if (selection?.overlay.type === "text") {
          event.preventDefault();
          const prop = key === "b" ? "bold" : "italic";
          updateOverlay(selection.page.id, selection.overlay.id, { [prop]: !selection.overlay[prop] });
          bus.emit("selection");
        }
      }
      return;
    }

    if (event.altKey) {
      return;
    }

    switch (event.key) {
      case "Escape": {
        const popover = document.querySelector(".popover");
        if (popover) {
          popover.remove();
        } else if (state.search.open) {
          closeSearch();
        } else if (state.selected) {
          clearSelection();
        } else {
          setTool("select");
        }
        return;
      }
      case "Delete":
      case "Backspace": {
        const selection = selectedOverlay();
        if (selection) {
          event.preventDefault();
          removeOverlay(selection.page.id, selection.overlay.id);
        } else if ((event.target as HTMLElement).closest?.(".thumb-list") && state.selectedPageIds.size) {
          event.preventDefault();
          deletePages([...state.selectedPageIds]);
        }
        return;
      }
      case "Enter": {
        const selection = selectedOverlay();
        if (selection?.overlay.type === "text") {
          event.preventDefault();
          document.querySelector<HTMLElement>("[data-act='edit-text-content']")?.click();
        }
        return;
      }
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        if (nudgeSelected(dx, dy)) {
          event.preventDefault();
        }
        return;
      }
      case "PageDown":
        if (state.pages.length) {
          event.preventDefault();
          stepPage(1);
        }
        return;
      case "PageUp":
        if (state.pages.length) {
          event.preventDefault();
          stepPage(-1);
        }
        return;
      case "+":
      case "=":
        zoomBy(1.15);
        return;
      case "-":
        zoomBy(1 / 1.15);
        return;
      case "?":
        openShortcutsDialog();
        return;
    }

    if (key === "i") {
      void chooseImageToInsert();
    } else if (key === "s") {
      openSignatureDialog();
    } else if (TOOL_KEYS[key]) {
      if (!state.pages.length && key !== "v") {
        return;
      }
      setTool(TOOL_KEYS[key]);
    }
  });

  document.addEventListener("paste", (event) => {
    if (isTypingTarget(event.target) || !state.pages.length) {
      return;
    }
    const imageItem = [...(event.clipboardData?.items ?? [])].find((item) => item.type.startsWith("image/"));
    const file = imageItem?.getAsFile();
    if (file) {
      event.preventDefault();
      void placeImageFile(file).catch(() => toast("Không dán được ảnh.", "error"));
      return;
    }
    if (pasteOverlay()) {
      event.preventDefault();
    }
  });
}
