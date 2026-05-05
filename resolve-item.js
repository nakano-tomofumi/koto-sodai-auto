#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");

const ITEM_MASTER_PATH = path.resolve(process.cwd(), "data/koto-items.json");
const ITEM_CATALOG_PATH = path.resolve(process.cwd(), "item-catalog.json");

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[　]/g, " ")
    .trim();
}

function toKatakana(value) {
  return normalizeText(value).replace(/[\u3041-\u3096]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 0x60),
  );
}

function toHiragana(value) {
  return normalizeText(value).replace(/[\u30a1-\u30f6]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60),
  );
}

function normalizeForMatch(value) {
  return toHiragana(toKatakana(value)).replace(/[（〕［］【】「」『』()]/g, "");
}

function getBaseName(value) {
  return normalizeText(String(value || "").replace(/[（(].*$/, ""));
}

function scoreText(haystack, needle) {
  const nHaystack = normalizeForMatch(haystack);
  const nNeedle = normalizeForMatch(needle);
  if (!nHaystack || !nNeedle) return 0;
  if (nHaystack === nNeedle) return 100;
  let score = 0;
  if (nHaystack.includes(nNeedle)) score += 40;
  if (nNeedle.includes(nHaystack)) score += 20;
  const compactHaystack = nHaystack.replace(/[^\p{L}\p{N}]+/gu, "");
  const compactNeedle = nNeedle.replace(/[^\p{L}\p{N}]+/gu, "");
  if (compactHaystack && compactNeedle && compactHaystack.includes(compactNeedle)) {
    score += 15;
  }
  return score;
}

function scoreChairLike(baseName, requested) {
  const normalizedBase = normalizeForMatch(baseName);
  const normalizedRequested = normalizeForMatch(requested);
  if (!normalizedBase || !normalizedRequested) return 0;
  if (normalizedBase === "いす" || normalizedBase === "イス") {
    if (
      normalizedRequested.includes("いす") ||
      normalizedRequested.includes("イス") ||
      normalizedRequested.includes("椅子") ||
      normalizedRequested.includes("チェア") ||
      normalizedRequested.includes("chair") ||
      normalizedRequested.includes("officechair") ||
      normalizedRequested.includes("オフィスチェア")
    ) {
      return 80;
    }
  }
  return 0;
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function flattenMasterItems(master) {
  return Array.isArray(master?.items) ? master.items : [];
}

function flattenCatalogItems(catalog) {
  const categories = Array.isArray(catalog?.categories) ? catalog.categories : [];
  return categories.flatMap((category) => {
    const items = Array.isArray(category.items) ? category.items : [];
    return items.map((item) =>
      typeof item === "string"
        ? { category: category.name || "", canonicalName: item, aliases: [] }
        : {
            category: category.name || "",
            canonicalName: item.canonicalName || item.name || "",
            aliases: Array.isArray(item.aliases) ? item.aliases : [],
          },
    );
  });
}

function rankCandidates(requested, masterItems, catalogItems) {
  const normalizedRequested = normalizeText(requested);
  const candidates = [];

  for (const item of masterItems) {
    const canonicalName = normalizeText(item.item_name);
    const baseName = getBaseName(canonicalName);
    const catalogEntry = catalogItems.find(
      (entry) => normalizeText(entry.canonicalName) === canonicalName,
    );
    const aliasScore = (catalogEntry?.aliases || []).reduce(
      (sum, alias) => sum + scoreText(alias, normalizedRequested),
      0,
    );
    const categoryScore = catalogEntry?.category ? scoreText(catalogEntry.category, normalizedRequested) : 0;
    const keywordScore = catalogEntry?.category ? scoreText(catalogEntry.category, normalizedRequested) : 0;
    const exactScore = scoreText(canonicalName, normalizedRequested);
    const baseNameScore = scoreText(baseName, normalizedRequested);
    const chairLikeScore = scoreChairLike(baseName, normalizedRequested);
    const memoScore = scoreText(item.memo, normalizedRequested);
    const totalScore = exactScore + baseNameScore + chairLikeScore + aliasScore + categoryScore + keywordScore + memoScore;

    if (totalScore > 0) {
      candidates.push({
        canonicalName,
        feeYen: item.fee_yen,
        memo: item.memo,
        score: totalScore,
        category: catalogEntry?.category || "",
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.canonicalName.localeCompare(b.canonicalName, "ja"));
  return candidates;
}

async function askCandidateChoice(rl, candidates) {
  console.log("候補が複数見つかりました。");
  candidates.slice(0, 10).forEach((candidate, index) => {
    const categorySuffix = candidate.category ? ` / ${candidate.category}` : "";
    console.log(`${index + 1}. ${candidate.canonicalName}${categorySuffix}`);
  });
  while (true) {
    const answer = normalizeText(await rl.question("番号を選択してください: "));
    const value = Number(answer);
    if (Number.isInteger(value) && value >= 1 && value <= Math.min(candidates.length, 10)) {
      return candidates[value - 1];
    }
    console.log("有効な番号を入力してください。");
  }
}

async function main() {
  const requestedItem = normalizeText(process.argv.slice(2).join(" "));
  const rl = readline.createInterface({ input, output });
  try {
    const inputValue = requestedItem || normalizeText(await rl.question("粗大ごみの品目名を入力してください: "));
    if (!inputValue) {
      throw new Error("品目名が入力されていません。");
    }

    const master = await loadJson(ITEM_MASTER_PATH, { items: [] });
    const catalog = await loadJson(ITEM_CATALOG_PATH, { categories: [] });
    const masterItems = flattenMasterItems(master);
    const catalogItems = flattenCatalogItems(catalog);
    const candidates = rankCandidates(inputValue, masterItems, catalogItems);

    if (candidates.length === 0) {
      console.log(`正式品目に解決できませんでした: ${inputValue}`);
      process.exitCode = 1;
      return;
    }

    const bestScore = candidates[0].score;
    const bestCandidates = candidates.filter((candidate) => candidate.score === bestScore);
    const selected = bestCandidates.length === 1 ? bestCandidates[0] : await askCandidateChoice(rl, bestCandidates);

    console.log(JSON.stringify({
      requested_item: inputValue,
      official_item_name: selected.canonicalName,
      category: selected.category || "",
      fee_yen: selected.feeYen,
      memo: selected.memo,
    }, null, 2));
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
