import { fontInfo, preloadFamily, textFonts } from "./fonts";
import { icon, type IconName } from "./icons";
import {
  duplicateOverlay,
  insertBlankPage,
  removeAllOverlays,
  removeOverlay,
  reorderOverlay,
  requestReveal,
  reversePages,
  rotatePages,
  updateDoc,
  updateOverlay,
} from "./ops";
import { bus, selectedOverlay, state, totalOverlayCount } from "./state";
import type { OverlayType } from "./types";
import { escapeHtml, formatBytes } from "./util";
import { editSelectedText } from "./viewer";

const TYPE_INFO: Record<OverlayType, { label: string; icon: IconName; hint: string }> = {
  text: { label: "Văn bản", icon: "type", hint: "Nhấp đúp vào chữ trên trang để sửa nội dung." },
  highlight: { label: "Tô sáng", icon: "highlighter", hint: "Kéo trên trang để tô sáng — nội dung bên dưới vẫn đọc được." },
  cover: { label: "Che nội dung", icon: "square", hint: "Kéo để phủ một vùng. Nội dung gốc vẫn nằm trong file — dùng “Che vĩnh viễn” nếu cần xóa thật." },
  redact: { label: "Che vĩnh viễn", icon: "eye-off", hint: "Khi xuất PDF, mọi chữ, ảnh và nét vẽ dưới vùng này sẽ bị xóa hẳn khỏi file." },
  pen: { label: "Bút vẽ", icon: "pencil", hint: "Giữ chuột và vẽ tự do trên trang." },
  rect: { label: "Hình chữ nhật", icon: "square", hint: "Kéo để vẽ. Giữ Shift để vẽ hình vuông." },
  ellipse: { label: "Hình elip", icon: "circle", hint: "Kéo để vẽ. Giữ Shift để vẽ hình tròn." },
  line: { label: "Đường thẳng", icon: "minus", hint: "Kéo để vẽ. Giữ Shift để khóa góc 45°." },
  arrow: { label: "Mũi tên", icon: "arrow-up-right", hint: "Kéo để vẽ. Giữ Shift để khóa góc 45°." },
  image: { label: "Hình ảnh", icon: "image", hint: "Kéo để di chuyển, kéo góc dưới phải để đổi kích thước." },
};

const TEXT_PRESETS = ["#111827", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#2563eb", "#7c3aed", "#ffffff"];
const HIGHLIGHT_PRESETS = ["#fde047", "#86efac", "#f9a8d4", "#93c5fd", "#fdba74", "#c4b5fd"];
const COVER_PRESETS = ["#ffffff", "#f1f5f9", "#fef3c7", "#e2e8f0", "#111827"];
const STROKE_PRESETS = ["#2563eb", "#dc2626", "#16a34a", "#ea580c", "#7c3aed", "#111827"];

type Spec =
  | { kind: "color"; prop: string; label: string; presets: string[]; none?: boolean }
  | { kind: "range"; prop: string; label: string; min: number; max: number; step: number; scale?: number; unit?: string }
  | { kind: "font" }
  | { kind: "size" }
  | { kind: "toggles" };

const opacity: Spec = { kind: "range", prop: "opacity", label: "Độ trong suốt", min: 10, max: 100, step: 1, scale: 100, unit: "%" };

const SPECS: Record<OverlayType, Spec[]> = {
  text: [
    { kind: "font" },
    { kind: "size" },
    { kind: "toggles" },
    { kind: "color", prop: "color", label: "Màu chữ", presets: TEXT_PRESETS },
    opacity,
  ],
  highlight: [{ kind: "color", prop: "color", label: "Màu tô sáng", presets: HIGHLIGHT_PRESETS }, opacity],
  cover: [{ kind: "color", prop: "color", label: "Màu phủ", presets: COVER_PRESETS }],
  redact: [],
  pen: [
    { kind: "color", prop: "stroke", label: "Màu nét", presets: STROKE_PRESETS },
    { kind: "range", prop: "strokeWidth", label: "Độ dày nét", min: 1, max: 24, step: 0.5, unit: " pt" },
    opacity,
  ],
  rect: [
    { kind: "color", prop: "stroke", label: "Màu viền", presets: STROKE_PRESETS },
    { kind: "range", prop: "strokeWidth", label: "Độ dày viền", min: 0.5, max: 16, step: 0.5, unit: " pt" },
    { kind: "color", prop: "fill", label: "Màu nền", presets: ["#fef08a", "#bfdbfe", "#bbf7d0", "#fecaca", "#ffffff"], none: true },
    opacity,
  ],
  ellipse: [
    { kind: "color", prop: "stroke", label: "Màu viền", presets: STROKE_PRESETS },
    { kind: "range", prop: "strokeWidth", label: "Độ dày viền", min: 0.5, max: 16, step: 0.5, unit: " pt" },
    { kind: "color", prop: "fill", label: "Màu nền", presets: ["#fef08a", "#bfdbfe", "#bbf7d0", "#fecaca", "#ffffff"], none: true },
    opacity,
  ],
  line: [
    { kind: "color", prop: "stroke", label: "Màu nét", presets: STROKE_PRESETS },
    { kind: "range", prop: "strokeWidth", label: "Độ dày nét", min: 0.5, max: 16, step: 0.5, unit: " pt" },
    opacity,
  ],
  arrow: [
    { kind: "color", prop: "stroke", label: "Màu nét", presets: STROKE_PRESETS },
    { kind: "range", prop: "strokeWidth", label: "Độ dày nét", min: 0.5, max: 16, step: 0.5, unit: " pt" },
    opacity,
  ],
  image: [opacity],
};

let root: HTMLElement;

/** Loại overlay đang được chỉnh: overlay đang chọn, hoặc công cụ đang dùng. */
function targetType(): OverlayType | null {
  const selection = selectedOverlay();
  if (selection) {
    return selection.overlay.type;
  }
  const tool = state.tool;
  return tool === "select" || tool === "edit-text" ? null : (tool as OverlayType);
}

function currentValue(prop: string): string | number | boolean {
  const selection = selectedOverlay();
  if (selection) {
    return (selection.overlay as unknown as Record<string, string | number | boolean>)[prop];
  }
  const type = targetType();
  return type ? state.defaults[type][prop] : "";
}

function colorField(spec: Extract<Spec, { kind: "color" }>) {
  const value = String(currentValue(spec.prop) ?? "");
  const swatches = [
    spec.none
      ? `<button class="swatch none ${value === "" ? "on" : ""}" data-prop="${spec.prop}" data-value="" title="Không tô" aria-label="Không tô"></button>`
      : "",
    ...spec.presets.map(
      (preset) =>
        `<button class="swatch ${preset.toLowerCase() === value.toLowerCase() ? "on" : ""}" style="--c:${preset}" data-prop="${spec.prop}" data-value="${preset}" title="${preset}" aria-label="${preset}"></button>`,
    ),
  ].join("");

  return `
    <div class="field">
      <span class="field-label">${spec.label}</span>
      <div class="swatches">
        ${swatches}
        <label class="swatch custom" title="Chọn màu khác">
          <input type="color" data-prop="${spec.prop}" data-kind="color" value="${/^#[0-9a-f]{6}$/i.test(value) ? value : "#2563eb"}" />
        </label>
      </div>
    </div>`;
}

function rangeField(spec: Extract<Spec, { kind: "range" }>) {
  const scale = spec.scale ?? 1;
  const value = Number(currentValue(spec.prop)) * scale;
  return `
    <div class="field">
      <span class="field-label">${spec.label}<output>${Math.round(value * 10) / 10}${spec.unit ?? ""}</output></span>
      <input type="range" data-prop="${spec.prop}" data-kind="range" data-scale="${scale}" data-unit="${spec.unit ?? ""}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${value}" />
    </div>`;
}

function fontField() {
  const family = String(currentValue("family") || "arial");
  const fonts = textFonts();
  const options = (fonts.length ? fonts : [{ id: "arial", label: "Arial" }])
    .map((font) => `<option value="${font.id}" ${font.id === family ? "selected" : ""}>${escapeHtml(font.label)}</option>`)
    .join("");
  return `
    <div class="field">
      <span class="field-label">Phông chữ</span>
      <select data-prop="family" data-kind="font">${options}</select>
    </div>`;
}

function sizeField() {
  return `
    <div class="field">
      <span class="field-label">Cỡ chữ (pt)</span>
      <div class="stepper">
        <button data-step="-1" aria-label="Giảm cỡ chữ">${icon("minus", 16)}</button>
        <input type="number" data-prop="size" data-kind="number" min="4" max="400" step="0.5" value="${Number(currentValue("size")) || 16}" />
        <button data-step="1" aria-label="Tăng cỡ chữ">${icon("plus", 16)}</button>
      </div>
    </div>`;
}

function togglesField() {
  const info = fontInfo(String(currentValue("family") || "arial"));
  const canBold = info ? info.bold : true;
  const canItalic = info ? info.italic : true;
  return `
    <div class="field">
      <span class="field-label">Kiểu chữ</span>
      <div class="toggle-group">
        <button class="toggle-btn ${currentValue("bold") ? "on" : ""}" data-prop="bold" data-kind="toggle" ${canBold ? "" : "disabled"} title="Đậm (Ctrl+B)" aria-label="Đậm">${icon("bold", 17)}</button>
        <button class="toggle-btn ${currentValue("italic") ? "on" : ""}" data-prop="italic" data-kind="toggle" ${canItalic ? "" : "disabled"} title="Nghiêng (Ctrl+I)" aria-label="Nghiêng">${icon("italic", 17)}</button>
      </div>
    </div>`;
}

function specHtml(spec: Spec) {
  switch (spec.kind) {
    case "color":
      return colorField(spec);
    case "range":
      return rangeField(spec);
    case "font":
      return fontField();
    case "size":
      return sizeField();
    case "toggles":
      return togglesField();
  }
}

// ------------------------------------------------------------ doc settings

function switchHtml(path: string, checked: boolean, label: string) {
  return `
    <label class="switch-row">
      <span>${label}</span>
      <span class="switch">
        <input type="checkbox" data-doc="${path}" data-kind="check" ${checked ? "checked" : ""} />
        <i></i>
      </span>
    </label>`;
}

function docRange(path: string, label: string, min: number, max: number, step: number, value: number, unit = "", scale = 1) {
  return `
    <div class="field">
      <span class="field-label">${label}<output>${Math.round(value * scale * 10) / 10}${unit}</output></span>
      <input type="range" data-doc="${path}" data-kind="range" data-scale="${scale}" data-unit="${unit}" min="${min}" max="${max}" step="${step}" value="${value * scale}" />
    </div>`;
}

function positionGrid(current: string) {
  const cells = ["tl", "tc", "tr", "bl", "bc", "br"];
  return `
    <div class="field">
      <span class="field-label">Vị trí</span>
      <div class="pos-grid">
        ${cells.map((cell) => `<button class="${cell === current ? "on" : ""}" data-doc="pageNumbers.position" data-value="${cell}" data-kind="choice" aria-label="Vị trí ${cell}"><i></i></button>`).join("")}
      </div>
    </div>`;
}

function documentPanel() {
  const { watermark, pageNumbers } = state.doc;
  const total = [...state.sources.values()].reduce((sum, source) => sum + source.bytes.byteLength, 0);
  const hasPages = state.pages.length > 0;
  const fonts = textFonts();
  const familyOptions = (selected: string) =>
    (fonts.length ? fonts : [{ id: "arial", label: "Arial" }])
      .map((font) => `<option value="${font.id}" ${font.id === selected ? "selected" : ""}>${escapeHtml(font.label)}</option>`)
      .join("");

  if (!hasPages) {
    return `
      <div class="panel-header"><div><h2>Thuộc tính</h2><p>Chưa có tài liệu</p></div></div>
      <div class="inspector-body">
        <div class="side-empty">
          ${icon("settings", 30)}
          <b>Mọi tùy chỉnh sẽ hiện ở đây</b>
          <span>Mở một tài liệu để thêm dấu chìm, đánh số trang và chỉnh sửa từng đối tượng.</span>
        </div>
      </div>`;
  }

  return `
    <div class="panel-header"><div><h2>Tài liệu</h2><p>${state.pages.length} trang · ${formatBytes(total)} · ${totalOverlayCount()} đối tượng đã thêm</p></div></div>
    <div class="inspector-body">
      <section class="card">
        <header><h3>${icon("droplets", 16)} Dấu chìm</h3></header>
        ${switchHtml("watermark.enabled", watermark.enabled, "Chèn vào mọi trang")}
        ${watermark.enabled ? `
          <div class="field"><span class="field-label">Nội dung</span><input type="text" data-doc="watermark.text" data-kind="text" value="${escapeHtml(watermark.text)}" /></div>
          <div class="field"><span class="field-label">Phông chữ</span><select data-doc="watermark.family" data-kind="font">${familyOptions(watermark.family)}</select></div>
          ${docRange("watermark.size", "Cỡ chữ", 20, 200, 2, watermark.size, " pt")}
          ${docRange("watermark.opacity", "Độ trong suốt", 5, 100, 1, watermark.opacity, "%", 100)}
          ${docRange("watermark.angle", "Góc xoay", -90, 90, 1, watermark.angle, "°")}
          <div class="field"><span class="field-label">Màu</span><div class="swatches">
            ${["#94a3b8", "#dc2626", "#2563eb", "#16a34a", "#111827"].map((color) => `<button class="swatch ${color === watermark.color ? "on" : ""}" style="--c:${color}" data-doc="watermark.color" data-value="${color}" data-kind="choice" aria-label="${color}"></button>`).join("")}
            <label class="swatch custom"><input type="color" data-doc="watermark.color" data-kind="text" value="${watermark.color}" /></label>
          </div></div>` : ""}
      </section>

      <section class="card">
        <header><h3>${icon("hash", 16)} Đánh số trang</h3></header>
        ${switchHtml("pageNumbers.enabled", pageNumbers.enabled, "Thêm số trang khi xuất")}
        ${pageNumbers.enabled ? `
          ${positionGrid(pageNumbers.position)}
          <div class="field"><span class="field-label">Định dạng</span>
            <select data-doc="pageNumbers.format" data-kind="text">
              ${["{n}", "{n} / {total}", "Trang {n}", "Trang {n} / {total}", "- {n} -"].map((format) => `<option value="${format}" ${format === pageNumbers.format ? "selected" : ""}>${format.replace("{n}", "1").replace("{total}", String(Math.max(state.pages.length, 1)))}</option>`).join("")}
            </select>
          </div>
          <div class="field-pair">
            <div class="field"><span class="field-label">Bắt đầu từ</span><input type="number" min="0" max="9999" data-doc="pageNumbers.startAt" data-kind="number" value="${pageNumbers.startAt}" /></div>
            <div class="field"><span class="field-label">Cỡ chữ</span><input type="number" min="6" max="48" data-doc="pageNumbers.size" data-kind="number" value="${pageNumbers.size}" /></div>
          </div>` : ""}
      </section>

      <section class="card">
        <header><h3>${icon("layers", 16)} Thao tác nhanh</h3></header>
        <div class="quick-grid">
          <button class="btn" data-act="rotate-all" ${hasPages ? "" : "disabled"}>${icon("rotate-cw", 16)} Xoay tất cả</button>
          <button class="btn" data-act="reverse" ${state.pages.length > 1 ? "" : "disabled"}>${icon("arrow-down-up", 16)} Đảo thứ tự</button>
          <button class="btn" data-act="blank" ${hasPages ? "" : "disabled"}>${icon("file-plus", 16)} Trang trắng</button>
          <button class="btn" data-act="clear-page" ${hasPages ? "" : "disabled"}>${icon("trash", 16)} Xóa chỉnh sửa trang</button>
        </div>
      </section>

      <p class="tip">${icon("sparkles", 14)} Mẹo: nhấn <kbd>?</kbd> để xem toàn bộ phím tắt.</p>
    </div>`;
}

function overlayPanel(type: OverlayType, selected: boolean) {
  const info = TYPE_INFO[type];
  const fields = SPECS[type].map(specHtml).join("");
  const selection = selectedOverlay();

  return `
    <div class="panel-header">
      <div class="panel-title">
        <span class="panel-icon">${icon(info.icon, 18)}</span>
        <div>
          <h2>${info.label}</h2>
          <p>${selected ? "Đang chọn trên trang" : "Cài đặt cho đối tượng mới"}</p>
        </div>
      </div>
    </div>
    <div class="inspector-body">
      <p class="hint">${info.hint}</p>
      ${fields ? `<section class="card">${fields}</section>` : ""}
      ${
        selected && selection
          ? `<section class="card">
              <div class="action-grid">
                ${type === "text" ? `<button class="btn wide" data-act="edit-text-content">${icon("edit-text", 16)} Sửa nội dung</button>` : ""}
                <button class="btn" data-act="duplicate">${icon("copy-plus", 16)} Nhân bản</button>
                <button class="btn" data-act="front">${icon("bring-to-front", 16)} Lên trên</button>
                <button class="btn" data-act="back">${icon("send-to-back", 16)} Xuống dưới</button>
                <button class="btn danger" data-act="delete">${icon("trash", 16)} Xóa</button>
              </div>
            </section>`
          : ""
      }
    </div>`;
}

function editTextPanel() {
  return `
    <div class="panel-header"><div class="panel-title"><span class="panel-icon">${icon("edit-text", 18)}</span><div><h2>Sửa chữ gốc</h2><p>Chỉnh nội dung có sẵn trong PDF</p></div></div></div>
    <div class="inspector-body">
      <p class="hint">Bấm vào một dòng chữ trên trang để sửa. Màu chữ, màu nền được tự nhận từ trang; cỡ chữ để trống sẽ tự khớp với bản gốc.</p>
      <section class="card steps">
        <ol>
          <li>Rê chuột — các dòng chữ sẽ được viền xanh.</li>
          <li>Bấm vào dòng cần sửa, nhập nội dung mới.</li>
          <li>Nhấn <kbd>Ctrl</kbd> + <kbd>Enter</kbd> để áp dụng.</li>
        </ol>
      </section>
      <p class="tip">${icon("info", 14)} Thao tác này sửa trực tiếp nội dung PDF và có thể hoàn tác bằng <kbd>Ctrl</kbd>+<kbd>Z</kbd>.</p>
    </div>`;
}

// -------------------------------------------------------------------- render

function render() {
  const type = targetType();
  const selected = Boolean(selectedOverlay());
  if (state.tool === "edit-text" && !selected) {
    root.innerHTML = editTextPanel();
  } else if (type) {
    root.innerHTML = overlayPanel(type, selected);
  } else {
    root.innerHTML = documentPanel();
  }
}

function setByPath(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

function applyOverlayProp(prop: string, value: string | number | boolean) {
  const type = targetType();
  if (!type) {
    return;
  }
  const selection = selectedOverlay();
  if (selection) {
    updateOverlay(selection.page.id, selection.overlay.id, { [prop]: value });
  }
  // Ghi nhớ làm mặc định để đối tượng kế tiếp dùng cùng kiểu
  state.defaults[type][prop] = value;
  if (type === "rect" || type === "ellipse") {
    const other = type === "rect" ? "ellipse" : "rect";
    state.defaults[other][prop] = value;
  }
  if (!selection) {
    bus.emit("ui");
  }
}

function readValue(element: HTMLElement) {
  const input = element as HTMLInputElement;
  const kind = element.dataset.kind;
  if (kind === "range" || kind === "number") {
    const scale = Number(element.dataset.scale) || 1;
    return Number(input.value) / scale;
  }
  if (kind === "toggle") {
    return !element.classList.contains("on");
  }
  if (kind === "check") {
    return input.checked;
  }
  if (kind === "choice") {
    return element.dataset.value ?? "";
  }
  return input.value;
}

function updateRangeLabel(element: HTMLElement) {
  if (element.dataset.kind !== "range") {
    return;
  }
  const output = element.closest(".field")?.querySelector("output");
  if (output) {
    output.textContent = `${Math.round(Number((element as HTMLInputElement).value) * 10) / 10}${element.dataset.unit ?? ""}`;
  }
}

async function onAction(action: string) {
  const selection = selectedOverlay();
  switch (action) {
    case "duplicate":
      if (selection) duplicateOverlay(selection.page.id, selection.overlay.id);
      break;
    case "front":
      if (selection) reorderOverlay(selection.page.id, selection.overlay.id, "front");
      break;
    case "back":
      if (selection) reorderOverlay(selection.page.id, selection.overlay.id, "back");
      break;
    case "delete":
      if (selection) removeOverlay(selection.page.id, selection.overlay.id);
      break;
    case "edit-text-content":
      editSelectedText();
      break;
    case "rotate-all":
      rotatePages(state.pages.map((page) => page.id), 1);
      break;
    case "reverse":
      reversePages();
      break;
    case "blank":
      requestReveal(insertBlankPage());
      break;
    case "clear-page":
      if (state.activePageId) removeAllOverlays(state.activePageId);
      break;
  }
}

export function initInspector(container: HTMLElement) {
  root = container;

  root.addEventListener("input", (event) => {
    const element = event.target as HTMLElement;
    if (element.dataset.kind === "choice" || element.dataset.kind === "toggle") {
      return;
    }
    if (element.dataset.prop) {
      const value = readValue(element);
      if (element.dataset.kind === "font") {
        return;
      }
      if (element.dataset.kind === "number" && !Number.isFinite(value as number)) {
        return;
      }
      applyOverlayProp(element.dataset.prop, value);
      updateRangeLabel(element);
    } else if (element.dataset.doc) {
      const path = element.dataset.doc;
      const value = readValue(element);
      if (element.dataset.kind === "check") {
        return;
      }
      if (element.dataset.kind === "number" && !Number.isFinite(value as number)) {
        return;
      }
      updateDoc(path, (doc) => setByPath(doc as unknown as Record<string, unknown>, path, value));
      updateRangeLabel(element);
    }
  });

  root.addEventListener("change", (event) => {
    const element = event.target as HTMLElement;
    if (element.dataset.kind === "font" && element.dataset.prop) {
      const family = (element as HTMLSelectElement).value;
      void preloadFamily(family).then(() => {
        applyOverlayProp("family", family);
        render();
      });
    } else if (element.dataset.kind === "font" && element.dataset.doc) {
      const family = (element as HTMLSelectElement).value;
      const path = element.dataset.doc;
      void preloadFamily(family).then(() => {
        updateDoc(path, (doc) => setByPath(doc as unknown as Record<string, unknown>, path, family));
      });
    } else if (element.dataset.kind === "check" && element.dataset.doc) {
      const path = element.dataset.doc;
      const value = (element as HTMLInputElement).checked;
      updateDoc(path, (doc) => setByPath(doc as unknown as Record<string, unknown>, path, value));
      render();
    }
  });

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const stepper = target.closest<HTMLElement>("[data-step]");
    if (stepper) {
      const input = stepper.parentElement?.querySelector<HTMLInputElement>("input");
      if (input) {
        const next = Math.max(4, Math.round((Number(input.value) + Number(stepper.dataset.step) * (Number(input.value) >= 40 ? 2 : 1)) * 2) / 2);
        input.value = String(next);
        applyOverlayProp(input.dataset.prop ?? "size", next);
      }
      return;
    }

    const choice = target.closest<HTMLElement>("[data-value]");
    if (choice && choice.dataset.doc) {
      const path = choice.dataset.doc;
      const value = choice.dataset.value ?? "";
      updateDoc(path, (doc) => setByPath(doc as unknown as Record<string, unknown>, path, value));
      render();
      return;
    }
    if (choice && choice.dataset.prop) {
      applyOverlayProp(choice.dataset.prop, choice.dataset.value ?? "");
      render();
      return;
    }

    const toggle = target.closest<HTMLElement>("[data-kind='toggle']");
    if (toggle?.dataset.prop && !(toggle as HTMLButtonElement).disabled) {
      applyOverlayProp(toggle.dataset.prop, !toggle.classList.contains("on"));
      render();
      return;
    }

    const action = target.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (action) {
      void onAction(action);
    }
  });

  bus.on(["selection", "tool", "pages", "doc"], render);
  bus.on("ui", () => {
    // Danh sách font nạp xong -> dựng lại để hiện đủ lựa chọn (không dựng lại khi đang gõ)
    if (!root.contains(document.activeElement)) {
      render();
    }
  });
  render();
}
