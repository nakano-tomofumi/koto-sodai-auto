#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

const SOURCE_PAGE_URL = "https://www.city.koto.lg.jp/388010/kurashi/gomi/kate/sodaigomi/7368.html";
const SOURCES = [
  "https://www.city.koto.lg.jp/388010/kurashi/gomi/kate/sodaigomi/documents/51a-2.pdf",
  "https://www.city.koto.lg.jp/388010/kurashi/gomi/kate/sodaigomi/documents/2k_3.pdf",
  "https://www.city.koto.lg.jp/388010/kurashi/gomi/kate/sodaigomi/documents/53s.pdf",
  "https://www.city.koto.lg.jp/388010/kurashi/gomi/kate/sodaigomi/documents/54t-2.pdf",
  "https://www.city.koto.lg.jp/388010/kurashi/gomi/kate/sodaigomi/documents/55n.pdf",
  "https://www.city.koto.lg.jp/388010/kurashi/gomi/kate/sodaigomi/documents/56h.pdf",
  "https://www.city.koto.lg.jp/388010/kurashi/gomi/kate/sodaigomi/documents/57m.pdf",
];

const DATA_DIR = path.resolve(process.cwd(), "data");
const RAW_DIR = path.resolve(DATA_DIR, "raw");
const OUTPUT_PATH = path.resolve(DATA_DIR, "koto-items.json");
const DEBUG_PATH = path.resolve(DATA_DIR, "koto-items.debug.txt");

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[　]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toKatakana(value) {
  return String(value || "").replace(/[\u3041-\u3096]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 0x60),
  );
}

function toHiragana(value) {
  return String(value || "").replace(/[\u30a1-\u30f6]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60),
  );
}

function normalizeKana(value) {
  return toHiragana(normalizeText(value));
}

function compact(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function parseCost(value) {
  const text = normalizeText(value);
  const numeric = text.replace(/[^\d,]/g, "");
  if (!numeric) {
    return text;
  }
  return Number(numeric.replace(/,/g, ""));
}

function parseTicketCount(value) {
  const text = normalizeText(value);
  if (text.includes("-") || text === "－") {
    return 0;
  }
  const match = text.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function isHeadingNoise(text) {
  return (
    text.includes("粗大ごみ品目一覧表") ||
    text.includes("手数料") ||
    text.includes("品目") ||
    text.includes("処理券組合せ") ||
    text.includes("江東区")
  );
}

function splitRowsFromPageText(text) {
  const normalized = normalizeText(text).replace(/\s+/g, " ");
  const starts = [];
  const rowStart = /(?:^|\s)([あ-ん])\s+/g;
  let match;
  while ((match = rowStart.exec(normalized))) {
    starts.push({
      index: match.index + match[0].indexOf(match[1]),
      kana: match[1],
    });
  }

  const rows = [];
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index];
    const next = starts[index + 1];
    const slice = normalized.slice(current.index, next ? next.index : undefined).trim();
    if (slice) {
      rows.push({ kana: current.kana, text: slice });
    }
  }
  return rows;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function downloadPdf(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`PDF download failed: ${url} (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(targetPath, Buffer.from(arrayBuffer));
}

async function extractPdfText(pdfPath) {
  const canvas = require("@napi-rs/canvas");
  global.DOMMatrix = global.DOMMatrix || canvas.DOMMatrix;
  global.ImageData = global.ImageData || canvas.ImageData;
  global.Path2D = global.Path2D || canvas.Path2D;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => (item.str || "").trim())
      .filter(Boolean)
      .join(" ");
    pages.push({ page: index, text });
  }
  return pages;
}

function parseItemRowsFromText(text, source) {
  const items = [];
  const rows = splitRowsFromPageText(text);

  for (const row of rows) {
    if (row.text.includes("手数料 品目")) {
      continue;
    }

    const body = row.text.replace(/^([あ-ん])\s+/, "");
    const feeMatch = body.match(/^(.+?)\s+([0-9][0-9,]*|※)\s*(.*?)\s+([0-9-]+枚|-)\s+([0-9-]+枚|-)(?:\s+|$)/);
    if (!feeMatch) {
      continue;
    }

    const itemName = normalizeText(feeMatch[1]);
    if (!itemName || isHeadingNoise(itemName)) {
      continue;
    }

    items.push({
      item_name: itemName,
      fee_yen: feeMatch[2] === "※" ? "※" : parseCost(feeMatch[2]),
      memo: normalizeText(feeMatch[3]),
      a_tickets: parseTicketCount(feeMatch[4]),
      b_tickets: parseTicketCount(feeMatch[5]),
      source_pdf_url: source.pdfUrl,
      source_pdf_name: source.pdfName,
    });
  }

  return items;
}

function normalizeMasterItems(items) {
  const seen = new Map();
  for (const item of items) {
    const key = `${compact(item.item_name)}|${item.fee_yen}|${compact(item.memo)}`;
    if (!seen.has(key)) {
      seen.set(key, item);
    }
  }
  return [...seen.values()];
}

async function main() {
  await ensureDir(RAW_DIR);

  const downloadedAt = nowIso();
  const debugParts = [
    `source_page_url: ${SOURCE_PAGE_URL}`,
    `downloaded_at: ${downloadedAt}`,
    "",
  ];
  const allItems = [];

  for (const sourceUrl of SOURCES) {
    const pdfName = path.basename(sourceUrl);
    const pdfPath = path.join(RAW_DIR, pdfName);
    await downloadPdf(sourceUrl, pdfPath);
    const pages = await extractPdfText(pdfPath);
    debugParts.push(`## ${pdfName}`);
    debugParts.push(`source_url: ${sourceUrl}`);
    debugParts.push(`pages: ${pages.length}`);
    for (const page of pages) {
      debugParts.push(`### page ${page.page}`);
      debugParts.push(page.text);
      debugParts.push("");
    }

    for (const page of pages) {
      const parsed = parseItemRowsFromText(page.text, { pdfUrl: sourceUrl, pdfName });
      allItems.push(
        ...parsed.map((item) => ({
          ...item,
          source_page_url: SOURCE_PAGE_URL,
          downloaded_at: downloadedAt,
        })),
      );
    }
  }

  const normalized = normalizeMasterItems(allItems);
  const output = {
    source_page_url: SOURCE_PAGE_URL,
    downloaded_at: downloadedAt,
    source_urls: SOURCES,
    items: normalized,
  };

  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await fs.writeFile(DEBUG_PATH, `${debugParts.join("\n")}\n`, "utf8");
  console.log(`saved ${OUTPUT_PATH}`);
  console.log(`saved ${DEBUG_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
