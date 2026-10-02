import { icon } from "./icons";
import { loadFont, scriptFonts } from "./fonts";
import { canvasToBlob, placeImage, registerImage, renderStamp, STAMP_PRESETS, trimCanvas } from "./media";
import { openModal, toast } from "./ui";
import { escapeHtml, storageGet, storageSet } from "./util";

const SIGNATURES_KEY = "pdf.signatures";

const SIGNATURE_COLORS = ["#111827", "#1d4ed8", "#b91c1c"];

async function insertCanvas(canvas: HTMLCanvasElement, widthFraction: number) {
  const blob = await canvasToBlob(canvas);
  const asset = await registerImage(blob);
  if (!placeImage(asset, { widthFraction })) {
    toast("Hãy mở tài liệu trước khi chèn.", "info");
  }
}

// ---------------------------------------------------------------- signature

export function openSignatureDialog() {
  type Mode = "draw" | "type" | "saved";
  let mode: Mode = "draw";
  let color = SIGNATURE_COLORS[0];
  let typedText = "";
  let typedFont = scriptFonts()[0]?.id ?? "";
  let hasStroke = false;
  const saved = () => storageGet<string[]>(SIGNATURES_KEY, []);

  openModal({
    title: "Chữ ký",
    subtitle: "Vẽ, gõ hoặc dùng lại chữ ký đã lưu",
    width: 600,
    body: `
      <div class="tabs" role="tablist">
        <button class="tab on" data-mode="draw" role="tab">Vẽ tay</button>
        <button class="tab" data-mode="type" role="tab">Gõ tên</button>
        <button class="tab" data-mode="saved" role="tab">Đã lưu</button>
      </div>
      <div class="swatches sig-colors">
        ${SIGNATURE_COLORS.map((swatch, index) => `<button class="swatch ${index === 0 ? "on" : ""}" style="--c:${swatch}" data-color="${swatch}" aria-label="${swatch}"></button>`).join("")}
      </div>
      <div id="sig-panel"></div>
    `,
    footer: `
      <label class="check-inline" id="sig-save-wrap"><input type="checkbox" id="sig-save" checked /> Lưu để dùng lại</label>
      <span class="spacer"></span>
      <button class="btn" data-close>Hủy</button>
      <button class="btn primary" id="sig-insert" disabled>${icon("check", 16)} Chèn vào trang</button>`,
    onMount: ({ el, close }) => {
      const panel = el.querySelector("#sig-panel") as HTMLElement;
      const insertBtn = el.querySelector("#sig-insert") as HTMLButtonElement;
      const saveWrap = el.querySelector("#sig-save-wrap") as HTMLElement;
      let drawCanvas: HTMLCanvasElement | null = null;
      let typedCanvas: HTMLCanvasElement | null = null;

      const setupDraw = () => {
        panel.innerHTML = `
          <div class="sig-pad"><canvas width="1080" height="360"></canvas><span class="sig-hint">Ký vào khung này</span><button class="chip" id="sig-clear">Xóa</button></div>`;
        const canvas = panel.querySelector("canvas") as HTMLCanvasElement;
        drawCanvas = canvas;
        const context = canvas.getContext("2d") as CanvasRenderingContext2D;
        context.lineCap = "round";
        context.lineJoin = "round";
        let drawing = false;
        let last: { x: number; y: number } | null = null;
        let lastMid: { x: number; y: number } | null = null;

        const pos = (event: PointerEvent) => {
          const rect = canvas.getBoundingClientRect();
          return {
            x: ((event.clientX - rect.left) / rect.width) * canvas.width,
            y: ((event.clientY - rect.top) / rect.height) * canvas.height,
          };
        };
        canvas.addEventListener("pointerdown", (event) => {
          drawing = true;
          canvas.setPointerCapture(event.pointerId);
          last = pos(event);
          lastMid = last;
          context.strokeStyle = color;
          context.lineWidth = 7;
          context.beginPath();
          context.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
          context.fillStyle = color;
          context.fill();
          hasStroke = true;
          insertBtn.disabled = false;
          panel.querySelector(".sig-hint")?.classList.add("hidden");
        });
        canvas.addEventListener("pointermove", (event) => {
          if (!drawing || !last) {
            return;
          }
          const next = pos(event);
          const mid = { x: (last.x + next.x) / 2, y: (last.y + next.y) / 2 };
          context.strokeStyle = color;
          context.lineWidth = 7;
          context.beginPath();
          context.moveTo((lastMid ?? last).x, (lastMid ?? last).y);
          context.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
          context.stroke();
          lastMid = mid;
          last = next;
        });
        const stop = () => {
          if (drawing && last && lastMid) {
            context.beginPath();
            context.moveTo(lastMid.x, lastMid.y);
            context.lineTo(last.x, last.y);
            context.stroke();
          }
          drawing = false;
          last = null;
          lastMid = null;
        };
        canvas.addEventListener("pointerup", stop);
        canvas.addEventListener("pointercancel", stop);
        panel.querySelector("#sig-clear")?.addEventListener("click", () => {
          context.clearRect(0, 0, canvas.width, canvas.height);
          hasStroke = false;
          insertBtn.disabled = true;
          panel.querySelector(".sig-hint")?.classList.remove("hidden");
        });
        insertBtn.disabled = !hasStroke;
      };

      const renderTyped = async () => {
        const canvas = panel.querySelector<HTMLCanvasElement>("#typed-canvas");
        if (!canvas) {
          return;
        }
        typedCanvas = canvas;
        const context = canvas.getContext("2d") as CanvasRenderingContext2D;
        context.clearRect(0, 0, canvas.width, canvas.height);
        if (!typedText.trim()) {
          insertBtn.disabled = true;
          return;
        }
        const loaded = typedFont ? await loadFont(typedFont, false, false) : null;
        const family = loaded ? `"${loaded.cssName}"` : "cursive";
        context.fillStyle = color;
        context.textBaseline = "middle";
        context.textAlign = "center";
        let size = 150;
        context.font = `${size}px ${family}`;
        const maxWidth = canvas.width - 80;
        const width = context.measureText(typedText).width;
        if (width > maxWidth) {
          size = Math.floor((size * maxWidth) / width);
          context.font = `${size}px ${family}`;
        }
        context.fillText(typedText, canvas.width / 2, canvas.height / 2);
        insertBtn.disabled = false;
      };

      const setupType = () => {
        const fonts = scriptFonts();
        panel.innerHTML = `
          <div class="field"><span class="field-label">Họ tên</span><input type="text" id="typed-text" placeholder="Nhập tên của bạn" value="${escapeHtml(typedText)}" data-autofocus /></div>
          ${fonts.length ? `<div class="font-chips">${fonts.map((font) => `<button class="chip ${font.id === typedFont ? "on" : ""}" data-font="${font.id}">${escapeHtml(font.label)}</button>`).join("")}</div>` : ""}
          <div class="sig-pad typed"><canvas id="typed-canvas" width="1080" height="360"></canvas></div>`;
        const input = panel.querySelector("#typed-text") as HTMLInputElement;
        input.addEventListener("input", () => {
          typedText = input.value;
          void renderTyped();
        });
        panel.querySelectorAll<HTMLElement>("[data-font]").forEach((button) => {
          button.addEventListener("click", () => {
            typedFont = button.dataset.font ?? typedFont;
            panel.querySelectorAll(".font-chips .chip").forEach((chip) => chip.classList.toggle("on", chip === button));
            void renderTyped();
          });
        });
        input.focus();
        void renderTyped();
      };

      const setupSaved = () => {
        const items = saved();
        panel.innerHTML = items.length
          ? `<div class="saved-grid">${items
              .map(
                (url, index) => `<div class="saved-item"><button class="saved-use" data-use="${index}"><img src="${url}" alt="Chữ ký ${index + 1}" /></button><button class="saved-del" data-del="${index}" aria-label="Xóa chữ ký">${icon("x", 14)}</button></div>`,
              )
              .join("")}</div>`
          : `<p class="empty-note">Chưa có chữ ký nào được lưu. Hãy vẽ hoặc gõ chữ ký rồi chọn “Lưu để dùng lại”.</p>`;
        insertBtn.disabled = true;
        panel.querySelectorAll<HTMLElement>("[data-use]").forEach((button) => {
          button.addEventListener("click", async () => {
            const url = items[Number(button.dataset.use)];
            const blob = await (await fetch(url)).blob();
            const asset = await registerImage(blob);
            placeImage(asset, { widthFraction: 0.25 });
            close();
          });
        });
        panel.querySelectorAll<HTMLElement>("[data-del]").forEach((button) => {
          button.addEventListener("click", () => {
            const next = saved().filter((_, index) => index !== Number(button.dataset.del));
            storageSet(SIGNATURES_KEY, next);
            setupSaved();
          });
        });
      };

      const switchMode = (next: Mode) => {
        mode = next;
        el.querySelectorAll<HTMLElement>(".tab").forEach((tab) => tab.classList.toggle("on", tab.dataset.mode === next));
        saveWrap.style.visibility = next === "saved" ? "hidden" : "visible";
        if (next === "draw") setupDraw();
        else if (next === "type") setupType();
        else setupSaved();
      };

      el.querySelectorAll<HTMLElement>(".tab").forEach((tab) =>
        tab.addEventListener("click", () => switchMode(tab.dataset.mode as Mode)),
      );
      el.querySelectorAll<HTMLElement>("[data-color]").forEach((button) =>
        button.addEventListener("click", () => {
          color = button.dataset.color ?? color;
          el.querySelectorAll(".sig-colors .swatch").forEach((swatch) => swatch.classList.toggle("on", swatch === button));
          if (mode === "type") {
            void renderTyped();
          }
        }),
      );

      insertBtn.addEventListener("click", async () => {
        const source = mode === "draw" ? drawCanvas : typedCanvas;
        if (!source) {
          return;
        }
        const trimmed = trimCanvas(source, 10);
        if ((el.querySelector("#sig-save") as HTMLInputElement).checked) {
          const list = [trimmed.toDataURL("image/png"), ...saved()].slice(0, 8);
          storageSet(SIGNATURES_KEY, list);
        }
        await insertCanvas(trimmed, 0.24);
        close();
      });

      switchMode("draw");
    },
  });
}

// -------------------------------------------------------------------- stamp

export function openStampDialog() {
  let label = STAMP_PRESETS[0].label;
  let color = STAMP_PRESETS[0].color;
  let withDate = true;

  openModal({
    title: "Con dấu",
    subtitle: "Chọn mẫu có sẵn hoặc tự tạo nội dung",
    width: 580,
    body: `
      <div class="stamp-grid" id="stamp-grid">
        ${STAMP_PRESETS.map(
          (preset, index) => `<button class="stamp-item ${index === 0 ? "on" : ""}" data-index="${index}"><img alt="${escapeHtml(preset.label)}" /></button>`,
        ).join("")}
      </div>
      <div class="field-pair">
        <div class="field"><span class="field-label">Nội dung</span><input type="text" id="stamp-text" maxlength="28" value="${escapeHtml(label)}" /></div>
        <div class="field"><span class="field-label">Màu</span><input type="color" id="stamp-color" value="${color}" /></div>
      </div>
      <label class="check-inline"><input type="checkbox" id="stamp-date" checked /> Kèm ngày hôm nay</label>
      <div class="stamp-preview"><img id="stamp-preview" alt="Xem trước" /></div>`,
    footer: `<button class="btn" data-close>Hủy</button><button class="btn primary" id="stamp-insert">${icon("stamp", 16)} Chèn con dấu</button>`,
    onMount: ({ el, close }) => {
      const preview = el.querySelector("#stamp-preview") as HTMLImageElement;
      const update = () => {
        preview.src = renderStamp(label || " ", color, withDate).toDataURL("image/png");
      };

      el.querySelectorAll<HTMLImageElement>(".stamp-item img").forEach((img, index) => {
        img.src = renderStamp(STAMP_PRESETS[index].label, STAMP_PRESETS[index].color, false).toDataURL("image/png");
      });

      el.querySelectorAll<HTMLElement>(".stamp-item").forEach((button) =>
        button.addEventListener("click", () => {
          const preset = STAMP_PRESETS[Number(button.dataset.index)];
          label = preset.label;
          color = preset.color;
          (el.querySelector("#stamp-text") as HTMLInputElement).value = label;
          (el.querySelector("#stamp-color") as HTMLInputElement).value = color;
          el.querySelectorAll(".stamp-item").forEach((item) => item.classList.toggle("on", item === button));
          update();
        }),
      );
      el.querySelector("#stamp-text")?.addEventListener("input", (event) => {
        label = (event.target as HTMLInputElement).value;
        el.querySelectorAll(".stamp-item").forEach((item) => item.classList.remove("on"));
        update();
      });
      el.querySelector("#stamp-color")?.addEventListener("input", (event) => {
        color = (event.target as HTMLInputElement).value;
        update();
      });
      el.querySelector("#stamp-date")?.addEventListener("change", (event) => {
        withDate = (event.target as HTMLInputElement).checked;
        update();
      });
      el.querySelector("#stamp-insert")?.addEventListener("click", async () => {
        if (!label.trim()) {
          toast("Hãy nhập nội dung con dấu.", "error");
          return;
        }
        await insertCanvas(renderStamp(label, color, withDate), 0.26);
        close();
      });
      update();
    },
  });
}
