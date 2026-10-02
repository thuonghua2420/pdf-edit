import { api } from "./api";
import { icon } from "./icons";
import { openPdfBytes, sampleColors } from "./pdfEngine";
import { bus, pushHistory, state } from "./state";
import type { PageItem, PdfTextItem, SourcePdf } from "./types";
import { arrayBufferToBase64, escapeHtml, uid } from "./util";
import { toast, withBusy } from "./ui";

let current: { el: HTMLElement; close: () => void } | null = null;

export function closeTextEditBubble() {
  current?.close();
  current = null;
}

/** Thay toàn bộ bản PDF nguồn bằng bản đã sửa; mọi trang dùng nguồn cũ trỏ sang nguồn mới (hoàn tác được). */
async function replaceSource(oldSource: SourcePdf, bytes: ArrayBuffer) {
  const pdfDoc = await openPdfBytes(bytes);
  const next: SourcePdf = { id: uid(), fileName: oldSource.fileName, bytes, pdfDoc };
  state.sources.set(next.id, next);
  pushHistory();
  for (const page of state.pages) {
    if (page.sourceId === oldSource.id) {
      page.sourceId = next.id;
    }
  }
  bus.emit("pages");
}

export function openTextEditBubble(options: {
  page: PageItem;
  item: PdfTextItem;
  hitEl: HTMLElement;
  canvas: HTMLCanvasElement;
}) {
  const { page, item, hitEl, canvas } = options;
  closeTextEditBubble();

  if (page.rotation !== 0) {
    toast("Hãy xoay trang về hướng gốc trước khi sửa chữ gốc.", "info");
    return;
  }
  const source = page.sourceId ? state.sources.get(page.sourceId) : null;
  if (!source) {
    return;
  }

  const colors = sampleColors(canvas, { x: item.x, y: item.y, width: item.width, height: item.height });
  hitEl.classList.add("active");

  const bubble = document.createElement("div");
  bubble.className = "edit-bubble";
  bubble.innerHTML = `
    <div class="eb-head">
      <div>
        <strong>Sửa chữ gốc</strong>
        <small>Thay trực tiếp nội dung có sẵn trong PDF</small>
      </div>
      <button class="icon-btn" data-act="close" aria-label="Đóng">${icon("x", 16)}</button>
    </div>
    <textarea rows="2" spellcheck="false">${escapeHtml(item.text)}</textarea>
    <div class="eb-row">
      <label>Cỡ chữ
        <input type="number" id="eb-size" min="4" max="144" step="0.5" placeholder="Tự động" />
      </label>
      <label>Màu chữ <input type="color" id="eb-color" value="${colors.text}" /></label>
      <label>Màu nền <input type="color" id="eb-bg" value="${colors.background}" /></label>
    </div>
    <div class="eb-actions">
      <button class="btn" data-act="close">Hủy</button>
      <button class="btn primary" data-act="apply">${icon("check", 16)} Áp dụng <kbd>Ctrl ↵</kbd></button>
    </div>`;
  document.body.append(bubble);

  const place = () => {
    const rect = hitEl.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const below = rect.bottom + 10;
    const top = below + bubbleRect.height > window.innerHeight - 12
      ? Math.max(12, rect.top - bubbleRect.height - 10)
      : below;
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - bubbleRect.width - 12);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  };
  place();

  const textarea = bubble.querySelector("textarea") as HTMLTextAreaElement;
  textarea.focus();
  textarea.select();

  const close = () => {
    hitEl.classList.remove("active");
    bubble.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    if (current?.el === bubble) {
      current = null;
    }
  };
  const onOutside = (event: PointerEvent) => {
    if (!bubble.contains(event.target as Node) && !(event.target as HTMLElement).closest(".text-hit")) {
      close();
    }
  };
  window.setTimeout(() => document.addEventListener("pointerdown", onOutside, true));
  current = { el: bubble, close };

  const apply = async () => {
    const text = textarea.value;
    if (!text.trim()) {
      toast("Nội dung thay thế không được để trống.", "error");
      return;
    }
    const sizeValue = Number((bubble.querySelector("#eb-size") as HTMLInputElement).value);
    const color = (bubble.querySelector("#eb-color") as HTMLInputElement).value;
    const background = (bubble.querySelector("#eb-bg") as HTMLInputElement).value;
    close();

    try {
      const output = await withBusy("MuPDF đang thay chữ gốc...", () =>
        api.editText({
          pdfBase64: arrayBufferToBase64(source.bytes),
          pageIndex: page.pageIndex,
          rect: [item.x, item.y, item.x + item.width, item.y + item.height],
          originalText: item.text,
          text,
          fontSize: sizeValue > 0 ? sizeValue : undefined,
          autoFontSize: !(sizeValue > 0),
          color,
          coverColor: background,
        }),
      );
      await replaceSource(source, output);
      toast("Đã sửa chữ gốc.", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Không thể sửa chữ gốc.", "error");
    }
  };

  bubble.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (action === "close") {
      close();
    } else if (action === "apply") {
      void apply();
    }
  });
  bubble.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void apply();
    }
  });
}
