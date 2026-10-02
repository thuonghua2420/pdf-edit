import "./styles.css";
import { bootstrap } from "./app";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Không tìm thấy root app.");
}

bootstrap(root);
