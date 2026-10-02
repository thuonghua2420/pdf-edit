import { icon } from "./icons";
import { bus, state } from "./state";
import { escapeHtml } from "./util";

// -------------------------------------------------------------------- toast

type ToastKind = "info" | "success" | "error";

export function toast(message: string, kind: ToastKind = "info", duration = 3600) {
  let host = document.querySelector<HTMLDivElement>("#toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.append(host);
  }

  const element = document.createElement("div");
  element.className = `toast toast-${kind}`;
  element.innerHTML = `${icon(kind === "success" ? "success" : kind === "error" ? "alert" : "info", 18)}<span>${escapeHtml(message)}</span>`;
  host.append(element);

  const remove = () => {
    element.classList.add("leaving");
    window.setTimeout(() => element.remove(), 220);
  };
  element.addEventListener("click", remove);
  window.setTimeout(remove, kind === "error" ? Math.max(duration, 6000) : duration);
}

// --------------------------------------------------------------------- busy

export async function withBusy<T>(message: string, task: () => Promise<T>) {
  state.busy = message;
  bus.emit("busy");
  try {
    return await task();
  } finally {
    state.busy = null;
    bus.emit("busy");
  }
}

export function updateBusy(message: string) {
  state.busy = message;
  bus.emit("busy");
}

// -------------------------------------------------------------------- modal

export type ModalHandle = {
  el: HTMLElement;
  close: () => void;
};

type ModalOptions = {
  title: string;
  subtitle?: string;
  body: string;
  footer?: string;
  width?: number;
  className?: string;
  onMount?: (handle: ModalHandle) => void;
  onClose?: () => void;
};

export function openModal(options: ModalOptions): ModalHandle {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal ${options.className ?? ""}" role="dialog" aria-modal="true" aria-label="${escapeHtml(options.title)}" style="${options.width ? `--modal-width:${options.width}px` : ""}">
      <header class="modal-header">
        <div>
          <h2>${escapeHtml(options.title)}</h2>
          ${options.subtitle ? `<p>${escapeHtml(options.subtitle)}</p>` : ""}
        </div>
        <button class="icon-btn" data-close aria-label="Đóng">${icon("x", 18)}</button>
      </header>
      <div class="modal-body">${options.body}</div>
      ${options.footer ? `<footer class="modal-footer">${options.footer}</footer>` : ""}
    </div>`;
  document.body.append(backdrop);

  const previousFocus = document.activeElement as HTMLElement | null;
  const modalEl = backdrop.querySelector<HTMLElement>(".modal") as HTMLElement;
  let closed = false;

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    backdrop.classList.add("leaving");
    window.setTimeout(() => backdrop.remove(), 160);
    options.onClose?.();
    previousFocus?.focus?.();
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);

  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) {
      close();
    }
  });
  backdrop.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));

  const handle = { el: modalEl, close };
  options.onMount?.(handle);

  requestAnimationFrame(() => {
    const autofocus = modalEl.querySelector<HTMLElement>("[data-autofocus]");
    (autofocus ?? modalEl.querySelector<HTMLElement>("input, textarea, select, button.primary"))?.focus();
  });

  return handle;
}

export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}) {
  return new Promise<boolean>((resolve) => {
    let answered = false;
    const answer = (value: boolean, close?: () => void) => {
      if (!answered) {
        answered = true;
        resolve(value);
      }
      close?.();
    };

    openModal({
      title: options.title,
      width: 420,
      body: `<p class="modal-text">${escapeHtml(options.message)}</p>`,
      footer: `
        <button class="btn" data-cancel>Hủy</button>
        <button class="btn ${options.danger ? "danger" : "primary"}" data-ok data-autofocus>${escapeHtml(options.confirmLabel ?? "Đồng ý")}</button>`,
      onMount: ({ el, close }) => {
        el.querySelector("[data-cancel]")?.addEventListener("click", () => answer(false, close));
        el.querySelector("[data-ok]")?.addEventListener("click", () => answer(true, close));
      },
      onClose: () => answer(false),
    });
  });
}

export function passwordDialog(fileName: string, wrong: boolean) {
  return new Promise<string | null>((resolve) => {
    let answered = false;
    const answer = (value: string | null, close?: () => void) => {
      if (!answered) {
        answered = true;
        resolve(value);
      }
      close?.();
    };

    openModal({
      title: "Tệp được bảo vệ bằng mật khẩu",
      subtitle: fileName,
      width: 420,
      body: `
        <label class="field">
          <span>Mật khẩu</span>
          <input type="password" id="pw-input" autocomplete="off" data-autofocus />
        </label>
        ${wrong ? `<p class="field-error">Mật khẩu chưa đúng, vui lòng thử lại.</p>` : ""}`,
      footer: `
        <button class="btn" data-cancel>Bỏ qua tệp này</button>
        <button class="btn primary" data-ok>Mở khóa</button>`,
      onMount: ({ el, close }) => {
        const input = el.querySelector<HTMLInputElement>("#pw-input");
        const submit = () => answer(input?.value ?? "", close);
        el.querySelector("[data-ok]")?.addEventListener("click", submit);
        el.querySelector("[data-cancel]")?.addEventListener("click", () => answer(null, close));
        input?.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            submit();
          }
        });
      },
      onClose: () => answer(null),
    });
  });
}

// ------------------------------------------------------------- file picker

export function pickFiles(accept: string, multiple = true) {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

// ------------------------------------------------------------------ popover

/** Popover nhỏ neo vào một phần tử; tự đóng khi bấm ra ngoài. */
export function openPopover(anchor: HTMLElement, html: string, options: { side?: "right" | "below" } = {}) {
  document.querySelector(".popover")?.remove();
  const popover = document.createElement("div");
  popover.className = "popover";
  popover.innerHTML = html;
  document.body.append(popover);

  const rect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const side = options.side ?? "right";
  let left = side === "right" ? rect.right + 10 : rect.left;
  let top = side === "right" ? rect.top : rect.bottom + 8;
  left = Math.min(left, window.innerWidth - popRect.width - 12);
  top = Math.min(top, window.innerHeight - popRect.height - 12);
  popover.style.left = `${Math.max(12, left)}px`;
  popover.style.top = `${Math.max(12, top)}px`;

  const close = () => {
    popover.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onOutside = (event: PointerEvent) => {
    if (!popover.contains(event.target as Node) && !anchor.contains(event.target as Node)) {
      close();
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      close();
    }
  };
  window.setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  });

  return { el: popover, close };
}
