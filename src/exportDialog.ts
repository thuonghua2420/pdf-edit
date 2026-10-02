import { api } from "./api";
import { producePdf } from "./exporter";
import { icon } from "./icons";
import { bus, selectedPageIdsInOrder, state, totalOverlayCount } from "./state";
import { toast, openModal, withBusy } from "./ui";
import { downloadBlob, escapeHtml, formatBytes, parsePageRange, storageGet, storageSet, toArrayBuffer } from "./util";

type Format = "pdf" | "images" | "word";
type Scope = "all" | "selected" | "range";

type Prefs = {
  format: Format;
  optimize: boolean;
  restrict: boolean;
  imageFormat: "png" | "jpg";
  dpi: number;
  quality: number;
  wordMode: "layout" | "text";
};

const defaultPrefs: Prefs = {
  format: "pdf",
  optimize: false,
  restrict: false,
  imageFormat: "png",
  dpi: 150,
  quality: 90,
  wordMode: "layout",
};

const safeFileName = (name: string) =>
  name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/\.(pdf|docx|zip)$/i, "").trim() || "tai-lieu";

export function openExportDialog(options: { scope?: Scope } = {}) {
  if (!state.pages.length) {
    toast("Hãy mở một tài liệu trước khi xuất.", "info");
    return;
  }

  const prefs: Prefs = { ...defaultPrefs, ...storageGet<Partial<Prefs>>("pdf.export", {}) };
  const selectedCount = selectedPageIdsInOrder().length;
  let scope: Scope = options.scope === "selected" && selectedCount > 0 ? "selected" : "all";
  let rangeText = "";
  let password = "";

  const redactCount = state.pages.reduce(
    (sum, page) => sum + page.overlays.filter((overlay) => overlay.type === "redact").length,
    0,
  );

  const formatCard = (format: Format, iconName: "file-text" | "file-image" | "file-word", title: string, text: string) => `
    <label class="format-card ${prefs.format === format ? "on" : ""}">
      <input type="radio" name="format" value="${format}" ${prefs.format === format ? "checked" : ""} />
      <span class="format-icon">${icon(iconName, 22)}</span>
      <strong>${title}</strong>
      <small>${text}</small>
    </label>`;

  const handle = openModal({
    title: "Xuất tài liệu",
    subtitle: `${state.pages.length} trang · ${totalOverlayCount()} chỉnh sửa`,
    width: 560,
    body: `
      <div class="format-grid">
        ${formatCard("pdf", "file-text", "PDF", "Giữ nguyên chữ & vector")}
        ${formatCard("images", "file-image", "Hình ảnh", "PNG / JPG, nén ZIP")}
        ${formatCard("word", "file-word", "Word", "Chuyển sang .docx")}
      </div>

      <div class="field">
        <span class="field-label">Phạm vi trang</span>
        <div class="scope-list">
          <label class="scope-item"><input type="radio" name="scope" value="all" ${scope === "all" ? "checked" : ""} /><span>Tất cả <b>${state.pages.length}</b> trang</span></label>
          <label class="scope-item ${selectedCount ? "" : "disabled"}"><input type="radio" name="scope" value="selected" ${scope === "selected" ? "checked" : ""} ${selectedCount ? "" : "disabled"} /><span>Trang đang chọn <b>${selectedCount}</b></span></label>
          <label class="scope-item"><input type="radio" name="scope" value="range" /><span>Tùy chọn</span><input type="text" id="range-input" placeholder="VD: 1-3, 5, 8-" /></label>
        </div>
        <p class="field-error" id="range-error" hidden></p>
      </div>

      <div class="field">
        <span class="field-label">Tên tệp</span>
        <div class="input-suffix">
          <input type="text" id="export-name" value="${escapeHtml(state.fileName)}" />
          <span id="export-ext">.pdf</span>
        </div>
      </div>

      <div id="format-options"></div>
      ${redactCount ? `<p class="callout warn">${icon("shield", 16)}<span>Có <b>${redactCount}</b> vùng “Che vĩnh viễn”: chữ, ảnh và nét vẽ bên dưới sẽ bị xóa hẳn khỏi file xuất.</span></p>` : ""}
    `,
    footer: `
      <button class="btn" data-close>Hủy</button>
      <button class="btn primary" id="export-go">${icon("download", 16)} Xuất tệp</button>`,
    onMount: ({ el }) => {
      const optionsEl = el.querySelector("#format-options") as HTMLElement;
      const extEl = el.querySelector("#export-ext") as HTMLElement;

      const renderOptions = () => {
        extEl.textContent = prefs.format === "pdf" ? ".pdf" : prefs.format === "images" ? "-images.zip" : ".docx";
        el.querySelectorAll(".format-card").forEach((card) => {
          const input = card.querySelector("input") as HTMLInputElement;
          card.classList.toggle("on", input.value === prefs.format);
        });

        if (prefs.format === "pdf") {
          optionsEl.innerHTML = `
            <div class="option-group">
              <label class="check-row"><input type="checkbox" id="opt-optimize" ${prefs.optimize ? "checked" : ""} /><span><b>Tối ưu dung lượng</b><small>Nén dữ liệu và loại bỏ phần dư thừa</small></span></label>
              <div class="field">
                <span class="field-label"><span class="label-main">${icon("lock", 14)} Mật khẩu mở tệp</span><small>(tùy chọn)</small></span>
                <input type="password" id="opt-password" autocomplete="new-password" placeholder="Để trống nếu không cần" value="${escapeHtml(password)}" />
              </div>
              <label class="check-row" id="restrict-row"><input type="checkbox" id="opt-restrict" ${prefs.restrict ? "checked" : ""} /><span><b>Chặn sao chép &amp; chỉnh sửa</b><small>Chỉ cho phép xem và in (cần đặt mật khẩu)</small></span></label>
            </div>`;
        } else if (prefs.format === "images") {
          optionsEl.innerHTML = `
            <div class="option-group">
              <div class="field-pair">
                <div class="field"><span class="field-label">Định dạng ảnh</span>
                  <select id="opt-image-format"><option value="png" ${prefs.imageFormat === "png" ? "selected" : ""}>PNG — sắc nét</option><option value="jpg" ${prefs.imageFormat === "jpg" ? "selected" : ""}>JPG — nhẹ hơn</option></select>
                </div>
                <div class="field"><span class="field-label">Độ phân giải</span>
                  <select id="opt-dpi">${[72, 96, 150, 200, 300].map((dpi) => `<option value="${dpi}" ${prefs.dpi === dpi ? "selected" : ""}>${dpi} DPI</option>`).join("")}</select>
                </div>
              </div>
              ${prefs.imageFormat === "jpg" ? `<div class="field"><span class="field-label">Chất lượng JPG<output>${prefs.quality}%</output></span><input type="range" id="opt-quality" min="40" max="100" value="${prefs.quality}" /></div>` : ""}
            </div>`;
        } else {
          optionsEl.innerHTML = `
            <div class="option-group">
              <div class="field"><span class="field-label">Kiểu chuyển đổi</span>
                <select id="opt-word-mode"><option value="layout" ${prefs.wordMode === "layout" ? "selected" : ""}>Giữ bố cục — giống bản gốc nhất</option><option value="text" ${prefs.wordMode === "text" ? "selected" : ""}>Chỉ văn bản — dễ chỉnh sửa</option></select>
              </div>
            </div>`;
        }

        const restrictRow = el.querySelector("#restrict-row");
        const restrictInput = el.querySelector<HTMLInputElement>("#opt-restrict");
        if (restrictRow && restrictInput) {
          restrictInput.disabled = !password;
          restrictRow.classList.toggle("disabled", !password);
        }
      };
      renderOptions();

      el.addEventListener("change", (event) => {
        const target = event.target as HTMLInputElement;
        if (target.name === "format") {
          prefs.format = target.value as Format;
          renderOptions();
        } else if (target.name === "scope") {
          scope = target.value as Scope;
          if (scope === "range") {
            (el.querySelector("#range-input") as HTMLInputElement).focus();
          }
        } else if (target.id === "opt-optimize") {
          prefs.optimize = target.checked;
        } else if (target.id === "opt-restrict") {
          prefs.restrict = target.checked;
        } else if (target.id === "opt-image-format") {
          prefs.imageFormat = target.value === "jpg" ? "jpg" : "png";
          renderOptions();
        } else if (target.id === "opt-dpi") {
          prefs.dpi = Number(target.value);
        } else if (target.id === "opt-word-mode") {
          prefs.wordMode = target.value === "text" ? "text" : "layout";
        }
      });

      el.addEventListener("input", (event) => {
        const target = event.target as HTMLInputElement;
        if (target.id === "opt-password") {
          password = target.value;
          renderRestrictState();
        } else if (target.id === "range-input") {
          rangeText = target.value;
          scope = "range";
          (el.querySelector<HTMLInputElement>("input[name=scope][value=range]") as HTMLInputElement).checked = true;
          (el.querySelector("#range-error") as HTMLElement).hidden = true;
        } else if (target.id === "opt-quality") {
          prefs.quality = Number(target.value);
          const output = target.closest(".field")?.querySelector("output");
          if (output) output.textContent = `${prefs.quality}%`;
        }
      });

      function renderRestrictState() {
        const restrictInput = el.querySelector<HTMLInputElement>("#opt-restrict");
        const restrictRow = el.querySelector("#restrict-row");
        if (restrictInput && restrictRow) {
          restrictInput.disabled = !password;
          restrictRow.classList.toggle("disabled", !password);
          if (!password) {
            restrictInput.checked = false;
            prefs.restrict = false;
          }
        }
      }

      el.querySelector("#export-go")?.addEventListener("click", async () => {
        const rawName = (el.querySelector("#export-name") as HTMLInputElement).value;
        const name = safeFileName(rawName);

        let pageIds: string[] | undefined;
        if (scope === "selected") {
          pageIds = selectedPageIdsInOrder();
        } else if (scope === "range") {
          const indexes = parsePageRange(rangeText, state.pages.length);
          if (!indexes) {
            const error = el.querySelector("#range-error") as HTMLElement;
            error.textContent = `Phạm vi không hợp lệ. Nhập số trang từ 1 đến ${state.pages.length}, ví dụ 1-3, 5.`;
            error.hidden = false;
            return;
          }
          pageIds = indexes.map((index) => state.pages[index].id);
        }

        if (prefs.format === "images" && (pageIds?.length ?? state.pages.length) > 80) {
          toast("Xuất hình ảnh tối đa 80 trang mỗi lần. Hãy chọn phạm vi nhỏ hơn.", "error");
          return;
        }

        storageSet("pdf.export", prefs);
        state.fileName = name;
        bus.emit("doc");
        handle.close();

        try {
          await runExport(name, pageIds, prefs, password);
        } catch (error) {
          toast(error instanceof Error ? error.message : "Không thể xuất tệp.", "error");
        }
      });
    },
  });
}

async function runExport(name: string, pageIds: string[] | undefined, prefs: Prefs, password: string) {
  if (prefs.format === "pdf") {
    const bytes = await withBusy("Đang tạo PDF...", () =>
      producePdf(pageIds, { optimize: prefs.optimize, password, restrict: prefs.restrict && Boolean(password) }),
    );
    downloadBlob(new Blob([toArrayBuffer(bytes)], { type: "application/pdf" }), `${name}.pdf`);
    toast(`Đã xuất ${name}.pdf (${formatBytes(bytes.byteLength)})`, "success");
    return;
  }

  if (prefs.format === "images") {
    const zip = await withBusy("Đang chuyển trang sang hình ảnh...", async () => {
      const bytes = await producePdf(pageIds);
      return api.toImages(bytes, { fileName: name, format: prefs.imageFormat, dpi: prefs.dpi, quality: prefs.quality });
    });
    downloadBlob(new Blob([zip], { type: "application/zip" }), `${name}-images.zip`);
    toast(`Đã xuất ảnh ${prefs.imageFormat.toUpperCase()} (${formatBytes(zip.byteLength)})`, "success");
    return;
  }

  const docx = await withBusy("Đang chuyển sang Word...", async () => {
    const bytes = await producePdf(pageIds);
    return api.toWord(bytes, { fileName: name, mode: prefs.wordMode });
  });
  downloadBlob(
    new Blob([docx], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    `${name}.docx`,
  );
  toast(`Đã xuất ${name}.docx (${formatBytes(docx.byteLength)})`, "success");
}
