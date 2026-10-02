import type * as pdfjs from "pdfjs-dist";

export type Rot = 0 | 90 | 180 | 270;

export type ToolId =
  | "select"
  | "text"
  | "edit-text"
  | "highlight"
  | "pen"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "cover"
  | "redact";

type OverlayBase = {
  id: string;
  opacity: number;
};

/** Toạ độ x, y chuẩn hoá (0..1) theo trang đang hiển thị; kích thước chữ & nét tính theo pt. */
export type TextOverlay = OverlayBase & {
  type: "text";
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
  family: string;
  bold: boolean;
  italic: boolean;
  /** Góc xoay (độ, theo chiều kim đồng hồ) quanh góc trên-trái. */
  angle: number;
};

export type BoxOverlay = OverlayBase & {
  type: "cover" | "redact" | "highlight";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
};

export type ShapeOverlay = OverlayBase & {
  type: "rect" | "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string;
  strokeWidth: number;
  fill: string;
};

export type LineOverlay = OverlayBase & {
  type: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
};

export type PenOverlay = OverlayBase & {
  type: "pen";
  points: number[];
  stroke: string;
  strokeWidth: number;
};

export type ImageOverlay = OverlayBase & {
  type: "image";
  x: number;
  y: number;
  /** Chiều rộng ảnh tính theo pt. */
  wPt: number;
  /** Tỉ lệ cao / rộng. */
  aspect: number;
  angle: number;
  imageId: string;
};

export type Overlay =
  | TextOverlay
  | BoxOverlay
  | ShapeOverlay
  | LineOverlay
  | PenOverlay
  | ImageOverlay;

export type OverlayType = Overlay["type"];

export type SourcePdf = {
  id: string;
  fileName: string;
  bytes: ArrayBuffer;
  pdfDoc: pdfjs.PDFDocumentProxy;
};

export type PageItem = {
  id: string;
  /** null = trang trắng do người dùng chèn. */
  sourceId: string | null;
  sourceName: string;
  pageIndex: number;
  /** Kích thước (pt) khi người dùng chưa xoay thêm — đã gồm góc xoay gốc của PDF. */
  baseW: number;
  baseH: number;
  intrinsicRotate: number;
  rotation: Rot;
  overlays: Overlay[];
};

export type ImageAsset = {
  id: string;
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
  url: string;
  width: number;
  height: number;
};

export type WatermarkSettings = {
  enabled: boolean;
  text: string;
  family: string;
  size: number;
  color: string;
  opacity: number;
  angle: number;
};

export type PageNumberPosition = "tl" | "tc" | "tr" | "bl" | "bc" | "br";

export type PageNumberSettings = {
  enabled: boolean;
  position: PageNumberPosition;
  format: string;
  size: number;
  color: string;
  startAt: number;
  family: string;
};

export type DocSettings = {
  watermark: WatermarkSettings;
  pageNumbers: PageNumberSettings;
};

export type PdfTextItem = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
};

export type ZoomMode = "fit-width" | "fit-page" | "manual";

export type FontInfo = {
  id: string;
  label: string;
  script: boolean;
  bold: boolean;
  italic: boolean;
};
