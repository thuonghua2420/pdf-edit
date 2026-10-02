import { arrayBufferToBase64 } from "./util";

export class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function postJson(path: string, body: unknown, fallbackMessage: string) {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Không kết nối được máy chủ xử lý PDF. Hãy chạy `npm run dev` hoặc start-all.bat.");
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new ApiError(payload?.error || fallbackMessage, payload?.code);
  }

  return response.arrayBuffer();
}

export type Redaction = { pageIndex: number; rect: [number, number, number, number] };

export const api = {
  unlock: (bytes: ArrayBuffer, password: string) =>
    postJson("/api/unlock", { pdfBase64: arrayBufferToBase64(bytes), password }, "Không thể mở khóa PDF."),

  finalize: (
    bytes: Uint8Array,
    options: { redactions: Redaction[]; optimize: boolean; password: string; restrict: boolean },
  ) =>
    postJson(
      "/api/finalize",
      { pdfBase64: arrayBufferToBase64(bytes), ...options },
      "Không thể hoàn tất PDF.",
    ),

  editText: (body: Record<string, unknown>) =>
    postJson("/api/edit-text", body, "Không thể sửa text PDF."),

  toImages: (bytes: Uint8Array, options: { fileName: string; format: string; dpi: number; quality: number }) =>
    postJson(
      "/api/pdf-to-images",
      { pdfBase64: arrayBufferToBase64(bytes), pageRange: "all", ...options },
      "Không thể chuyển PDF sang hình ảnh.",
    ),

  toWord: (bytes: Uint8Array, options: { fileName: string; mode: string }) =>
    postJson(
      "/api/pdf-to-word",
      { pdfBase64: arrayBufferToBase64(bytes), pageRange: "all", dpi: 150, ...options },
      "Không thể chuyển PDF sang Word.",
    ),

  wordToPdf: async (file: File) =>
    postJson(
      "/api/word-to-pdf",
      { fileBase64: arrayBufferToBase64(await file.arrayBuffer()), fileName: file.name },
      "Không thể chuyển Word sang PDF.",
    ),
};
