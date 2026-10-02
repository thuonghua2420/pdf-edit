import { PDFDocument } from "pdf-lib";
import { api, ApiError } from "./api";
import { isPasswordError, openPdfBytes, wrongPassword } from "./pdfEngine";
import { bus, clearHistory, pushHistory, state } from "./state";
import type { PageItem, SourcePdf } from "./types";
import { baseName, toArrayBuffer, uid } from "./util";
import { passwordDialog, toast, updateBusy, withBusy } from "./ui";
import { selectOnlyPage } from "./ops";

export const isPdfFile = (file: File) =>
  file.type === "application/pdf" || /\.pdf$/i.test(file.name);
export const isWordFile = (file: File) => /\.(docx?|rtf|odt)$/i.test(file.name);
export const isImageFile = (file: File) =>
  /^image\/(png|jpeg)$/.test(file.type) || /\.(png|jpe?g)$/i.test(file.name);

export const isSupportedFile = (file: File) =>
  isPdfFile(file) || isWordFile(file) || isImageFile(file);

async function imageFileToPdf(file: File) {
  const doc = await PDFDocument.create();
  const bytes = await file.arrayBuffer();
  const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
  const image = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const scale = Math.min(1, 14_400 / Math.max(image.width, image.height));
  // Ảnh lớn được co về khổ hợp lý (rộng tối đa ~A4 ở 150 dpi) để dễ thao tác.
  const fit = Math.min(1, 1240 / image.width);
  const width = image.width * scale * fit;
  const height = image.height * scale * fit;
  const page = doc.addPage([width, height]);
  page.drawImage(image, { x: 0, y: 0, width, height });
  return toArrayBuffer(await doc.save());
}

async function openWithPassword(bytes: ArrayBuffer, fileName: string) {
  try {
    return { pdfDoc: await openPdfBytes(bytes), bytes };
  } catch (error) {
    if (!isPasswordError(error)) {
      throw error;
    }
  }

  let wrong = false;
  for (;;) {
    const password = await passwordDialog(fileName, wrong);
    if (password === null) {
      return null;
    }
    try {
      const unlocked = await api.unlock(bytes, password);
      return { pdfDoc: await openPdfBytes(unlocked), bytes: unlocked };
    } catch (error) {
      if (error instanceof ApiError && error.code === "PASSWORD_WRONG") {
        wrong = true;
        continue;
      }
      if (isPasswordError(error) && wrongPassword(error)) {
        wrong = true;
        continue;
      }
      throw error;
    }
  }
}

async function addSource(bytes: ArrayBuffer, fileName: string): Promise<PageItem[] | null> {
  const opened = await openWithPassword(bytes, fileName);
  if (!opened) {
    return null;
  }

  const source: SourcePdf = { id: uid(), fileName, bytes: opened.bytes, pdfDoc: opened.pdfDoc };
  state.sources.set(source.id, source);

  const pages: PageItem[] = [];
  for (let index = 0; index < opened.pdfDoc.numPages; index += 1) {
    const pdfPage = await opened.pdfDoc.getPage(index + 1);
    const viewport = pdfPage.getViewport({ scale: 1 });
    pages.push({
      id: uid(),
      sourceId: source.id,
      sourceName: fileName,
      pageIndex: index,
      baseW: viewport.width,
      baseH: viewport.height,
      intrinsicRotate: pdfPage.rotate,
      rotation: 0,
      overlays: [],
    });
    if (index % 12 === 11) {
      updateBusy(`Đang đọc ${fileName} (${index + 1}/${opened.pdfDoc.numPages} trang)...`);
    }
  }
  return pages;
}

/** Nhập tệp: PDF, Word (qua máy chủ) hoặc ảnh. Luôn thêm vào cuối tài liệu hiện tại. */
export async function importFiles(input: FileList | File[]) {
  const all = [...input];
  const files = all.filter(isSupportedFile);
  const skipped = all.length - files.length;

  if (!files.length) {
    toast("Chỉ hỗ trợ PDF, Word (.doc/.docx), PNG hoặc JPG.", "error");
    return;
  }

  const wasEmpty = state.pages.length === 0;
  const added: PageItem[] = [];
  const failures: string[] = [];

  await withBusy("Đang nhập tài liệu...", async () => {
    for (const file of files) {
      try {
        let bytes: ArrayBuffer;
        let name = file.name;

        if (isWordFile(file)) {
          updateBusy(`Đang chuyển ${file.name} sang PDF...`);
          bytes = await api.wordToPdf(file);
          name = `${baseName(file.name)}.pdf`;
        } else if (isImageFile(file)) {
          updateBusy(`Đang đưa ${file.name} vào PDF...`);
          bytes = await imageFileToPdf(file);
          name = `${baseName(file.name)}.pdf`;
        } else {
          updateBusy(`Đang đọc ${file.name}...`);
          bytes = await file.arrayBuffer();
        }

        const pages = await addSource(bytes, name);
        if (pages) {
          added.push(...pages);
        }
      } catch (error) {
        failures.push(`${file.name}: ${error instanceof Error ? error.message : "không đọc được"}`);
      }
    }
  });

  if (added.length) {
    pushHistory();
    state.pages.push(...added);
    if (wasEmpty) {
      const first = files.find((file) => !failures.some((failure) => failure.startsWith(file.name)));
      state.fileName = baseName(first?.name ?? "tai-lieu");
      clearHistory();
    }
    selectOnlyPage(added[0].id);
    bus.emit("pages", "selection", "active", "doc");
    toast(
      `Đã thêm ${added.length} trang từ ${files.length - failures.length} tệp${skipped ? ` · bỏ qua ${skipped} tệp không hỗ trợ` : ""}.`,
      "success",
    );
  } else if (!failures.length && skipped === 0) {
    // người dùng đã hủy mật khẩu
  }

  for (const failure of failures) {
    toast(failure, "error");
  }
}

export async function closeDocument() {
  for (const source of state.sources.values()) {
    void source.pdfDoc.destroy();
  }
  for (const asset of state.images.values()) {
    URL.revokeObjectURL(asset.url);
  }
  state.sources.clear();
  state.images.clear();
  state.pages = [];
  state.selectedPageIds = new Set();
  state.activePageId = "";
  state.anchorPageId = "";
  state.selected = null;
  state.fileName = "tai-lieu";
  state.zoomMode = "fit-width";
  clearHistory();
  bus.emit("pages", "selection", "active", "doc", "zoom");
}
