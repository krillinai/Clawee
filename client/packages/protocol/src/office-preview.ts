export type OfficePreviewBlock =
  | { type: 'paragraph' | 'heading' | 'list' | 'unsupported'; text: string; level?: number; marker?: string }
  | { type: 'table'; rows: string[][] };

export type OfficePreviewCell = { column: number; text: string; formula?: string };

export type OfficePreviewSheet = {
  name: string;
  state: 'visible' | 'hidden' | 'veryHidden';
  totalRows: number;
  totalColumns: number;
  rowCount: number;
  columnCount: number;
  rows: Array<{ number: number; cells: OfficePreviewCell[] }>;
  merges: Array<{ row: number; column: number; rowSpan: number; columnSpan: number }>;
  truncated: boolean;
};

export type OfficePreviewSlide = { number: number; blocks: OfficePreviewBlock[]; notes: OfficePreviewBlock[] };

export type OfficePreview = (
  | { format: 'doc'; blocks: OfficePreviewBlock[] }
  | { format: 'docx'; blocks: OfficePreviewBlock[] }
  | { format: 'xls'; sheets: Array<{ name: string; blocks: OfficePreviewBlock[] }>; totalSheets: number }
  | { format: 'xlsx'; sheets: OfficePreviewSheet[]; totalSheets: number }
  | { format: 'ppt'; slides: OfficePreviewSlide[]; totalSlides: number }
  | { format: 'pptx'; slides: OfficePreviewSlide[]; totalSlides: number }
) & { truncated: boolean };

export type WorkspaceOfficePreviewResponse = {
  meta: import('./api.js').WorkspaceFileMeta;
  preview: OfficePreview;
};
