import { icon } from "./icons";
import { getTextItems } from "./pdfEngine";
import { bus, state, type SearchHit } from "./state";
import { stripDiacritics } from "./util";
import { scrollToRect } from "./viewer";

let token = 0;
let bar: HTMLElement;
let input: HTMLInputElement;
let counter: HTMLElement;
let diacriticsToggle: HTMLInputElement;

const normalize = (value: string, ignoreDiacritics: boolean) =>
  (ignoreDiacritics ? stripDiacritics(value) : value).toLowerCase();

async function runSearch() {
  const query = state.search.query.trim();
  const current = ++token;

  if (!query) {
    state.search.hits = [];
    state.search.index = -1;
    updateCounter();
    bus.emit("search");
    return;
  }

  const needle = normalize(query, state.search.ignoreDiacritics);
  const hits: SearchHit[] = [];

  for (const page of state.pages) {
    const items = await getTextItems(page);
    if (current !== token) {
      return;
    }
    for (const item of items) {
      const haystack = normalize(item.text, state.search.ignoreDiacritics);
      let from = 0;
      for (;;) {
        const index = haystack.indexOf(needle, from);
        if (index === -1) {
          break;
        }
        const length = Math.max(haystack.length, 1);
        hits.push({
          pageId: page.id,
          x: item.x + item.width * (index / length),
          y: item.y,
          w: Math.max(item.width * (needle.length / length), 0.004),
          h: item.height,
        });
        from = index + needle.length;
        if (hits.length >= 1000) {
          break;
        }
      }
      if (hits.length >= 1000) {
        break;
      }
    }
    if (hits.length >= 1000) {
      break;
    }
  }

  state.search.hits = hits;
  state.search.index = hits.length ? 0 : -1;
  updateCounter();
  bus.emit("search");
  revealCurrent();
}

function revealCurrent() {
  const hit = state.search.hits[state.search.index];
  if (hit) {
    scrollToRect(hit.pageId, hit);
  }
}

function updateCounter() {
  const { hits, index, query } = state.search;
  counter.textContent = !query.trim()
    ? ""
    : hits.length
      ? `${index + 1} / ${hits.length}${hits.length >= 1000 ? "+" : ""}`
      : "Không thấy";
  counter.classList.toggle("none", Boolean(query.trim()) && !hits.length);
}

export function stepSearch(direction: 1 | -1) {
  const { hits } = state.search;
  if (!hits.length) {
    return;
  }
  state.search.index = (state.search.index + direction + hits.length) % hits.length;
  updateCounter();
  bus.emit("search");
  revealCurrent();
}

export function openSearch() {
  state.search.open = true;
  bar.hidden = false;
  input.focus();
  input.select();
  bus.emit("search", "ui");
  void runSearch();
}

export function closeSearch() {
  if (!state.search.open) {
    return;
  }
  state.search.open = false;
  bar.hidden = true;
  bus.emit("search", "ui");
}

export function initSearch(container: HTMLElement) {
  bar = document.createElement("div");
  bar.className = "search-bar";
  bar.hidden = true;
  bar.innerHTML = `
    ${icon("search", 16)}
    <input type="search" placeholder="Tìm trong tài liệu..." aria-label="Tìm trong tài liệu" />
    <span class="search-count"></span>
    <label class="check-inline small" title="Tìm “toan” cũng ra “toán”"><input type="checkbox" checked /> Bỏ qua dấu</label>
    <button class="icon-btn" data-dir="-1" aria-label="Kết quả trước" data-tip="Trước (Shift+Enter)">${icon("chevron-up", 16)}</button>
    <button class="icon-btn" data-dir="1" aria-label="Kết quả sau" data-tip="Sau (Enter)">${icon("chevron-down", 16)}</button>
    <button class="icon-btn" data-close aria-label="Đóng tìm kiếm">${icon("x", 16)}</button>`;
  container.append(bar);

  input = bar.querySelector("input[type=search]") as HTMLInputElement;
  counter = bar.querySelector(".search-count") as HTMLElement;
  diacriticsToggle = bar.querySelector("input[type=checkbox]") as HTMLInputElement;

  let timer = 0;
  input.addEventListener("input", () => {
    state.search.query = input.value;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void runSearch(), 180);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      stepSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      closeSearch();
    }
  });
  diacriticsToggle.addEventListener("change", () => {
    state.search.ignoreDiacritics = diacriticsToggle.checked;
    void runSearch();
  });
  bar.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const dir = target.closest<HTMLElement>("[data-dir]")?.dataset.dir;
    if (dir) {
      stepSearch(Number(dir) as 1 | -1);
    } else if (target.closest("[data-close]")) {
      closeSearch();
    }
  });

  bus.on("pages", () => {
    if (state.search.open && state.search.query.trim()) {
      void runSearch();
    }
  });
}
