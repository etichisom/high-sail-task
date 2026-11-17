// The parts of Docling's JSON (a "DoclingDocument") that our code reads.
// Docling's JSON has more fields; we only describe what we use.

export type Ref = { $ref: string }; // a pointer like "#/texts/12" or "#/tables/3"

export type Prov = {
  page_no: number; // PDF page, counted from 1
  bbox: { l: number; t: number; r: number; b: number };
};

export type Item = {
  self_ref: string;
  parent?: Ref;
  children?: Ref[];
  content_layer?: string; // "body" or "furniture" (page headers/footers)
  label: string; // "text", "section_header", "list_item", "caption", "table", "picture", "list", ...
  prov?: Prov[];
};

export type TextItem = Item & { text: string };

export type TableItem = Item & {
  data: { num_rows: number; num_cols: number; grid: { text: string }[][] };
};

export type DoclingDoc = {
  name: string;
  body: Item;
  texts: TextItem[];
  tables: TableItem[];
  pictures: Item[];
  groups: Item[];
  pages: Record<string, { page_no: number; size: { width: number; height: number } }>;
};