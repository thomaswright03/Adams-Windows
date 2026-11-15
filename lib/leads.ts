import { normalizePhone, type Lead, type Store } from "./store.js";

/** Reads CSV text, handling quoted fields with commas, quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export interface ImportResult {
  added: number;
  alreadyOnList: number;
  excluded: number;
  optedOut: number;
  badPhone: string[];
}

const TRUTHY = /^(y|yes|true|1|x|exclude|excluded)$/i;

/** Adds leads from CSV with a header row. Columns (any order, any case):
 * phone (required); name, or first name + last name; notes; exclude (yes
 * to skip: not interested, wrong number, not a customer). A number already
 * on the list is left as it is, so importing twice never texts anyone twice. */
export async function importLeads(store: Store, csv: string, now = new Date()): Promise<ImportResult> {
  const [header, ...rows] = parseCsv(csv);
  if (!header) throw new Error("The CSV is empty.");
  const cols = header.map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
  const find = (...names: string[]) => cols.findIndex((c) => names.includes(c));
  const phoneCol = find("phone", "phonenumber", "mobile", "cell", "number");
  if (phoneCol < 0) throw new Error(`No phone column. Found: ${header.join(", ")}`);
  const nameCol = find("name", "fullname", "customer", "customername");
  const firstCol = find("firstname", "first");
  const lastCol = find("lastname", "last");
  const notesCol = find("notes", "note", "comments");
  const excludeCol = find("exclude", "excluded", "skip");

  const result: ImportResult = { added: 0, alreadyOnList: 0, excluded: 0, optedOut: 0, badPhone: [] };
  for (const row of rows) {
    const cell = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
    const phone = normalizePhone(cell(phoneCol));
    if (!phone) {
      result.badPhone.push(cell(phoneCol) || "(blank)");
      continue;
    }
    if (await store.getLead(phone)) {
      result.alreadyOnList++;
      continue;
    }
    const name = cell(nameCol) || [cell(firstCol), cell(lastCol)].filter(Boolean).join(" ");
    let status: Lead["status"] = "queued";
    if (TRUTHY.test(cell(excludeCol))) {
      status = "excluded";
      result.excluded++;
    } else if (await store.isOptedOut(phone)) {
      status = "opted_out";
      result.optedOut++;
    } else result.added++;
    await store.saveLead({ phone, name, notes: cell(notesCol), status, addedAt: now.toISOString(), nudgesSent: 0 });
  }
  return result;
}
