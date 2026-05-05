#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");

const localBrowserPath = path.resolve(__dirname, ".playwright-browsers");
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowserPath;
}

const dotenv = require("dotenv");
const { launchBrowser, getBrowserChannel, parseBoolean } = require("./lib/browser");

dotenv.config();

const START_URL = "https://www2.sodai-web.jp/koto/index.html";
const MAIL_INPUT_URL = "https://www2.sodai-web.jp/sodai/mailInput.na?id=08&ptype=1";
const RESULT_PATH = path.resolve(process.cwd(), "reservation-result.json");
const SESSION_PATH = path.resolve(process.cwd(), ".koto-session.json");
const DEBUG_ROOT = path.resolve(process.cwd(), "debug");
const TRACE_DIR = path.resolve(DEBUG_ROOT, "traces");
const TRACE_PATH = path.resolve(TRACE_DIR, "trace.zip");
const ITEM_CATALOG_PATH = path.resolve(process.cwd(), "item-catalog.json");
const ITEM_MASTER_PATH = path.resolve(process.cwd(), "data/koto-items.json");

const env = {
  name: process.env.KOTO_NAME || "",
  nameKana: process.env.KOTO_NAME_KANA || "",
  postalCode: process.env.KOTO_POSTAL_CODE || "",
  address: process.env.KOTO_ADDRESS || "",
  building: process.env.KOTO_BUILDING || "",
  phone: process.env.KOTO_PHONE || "",
  email: process.env.KOTO_EMAIL || "",
  defaultDisposalLocation:
    process.env.KOTO_DEFAULT_DISPOSAL_LOCATION || "集合住宅の粗大ごみ置き場",
  headless: parseBoolean(process.env.HEADLESS, true),
  resolvedItemsJson: process.env.KOTO_RESOLVED_ITEMS_JSON || "",
};

const dryRun = process.argv.includes("--dry-run");
const observationEnabled = true;
let currentDebugSessionDir = null;
let traceStarted = false;
let traceExported = false;
let itemCatalogCache = null;
let itemMasterCache = null;

function nowIso() {
  return new Date().toISOString();
}

function formatTimestamp(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[　]/g, " ")
    .trim();
}

function toHiragana(value) {
  return String(value || "").replace(/[\u30a1-\u30f6]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60),
  );
}

function includesNormalized(haystack, needle) {
  return toHiragana(normalizeText(haystack)).includes(toHiragana(normalizeText(needle)));
}

function toKatakana(value) {
  return String(value || "").replace(/[\u3041-\u3096]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 0x60),
  );
}

function splitJapaneseName(value) {
  const text = normalizeText(value);
  const parts = text.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    return { lastName: parts[0], firstName: parts.slice(1).join(" ") };
  }
  return { lastName: text, firstName: "" };
}

function parseAddressParts(value) {
  const text = normalizeText(value).replace(/^東京都江東区/, "");
  const match = text.match(/^([^0-9０-９]+)([0-9０-９]+)-([0-9０-９]+)-([0-9０-９]+)$/);
  if (!match) {
    return null;
  }

  return {
    area: match[1],
    chome: match[2],
    banchi: match[3],
    go: match[4],
  };
}

function splitPostalCode(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 7) {
    return null;
  }
  return {
    first: digits.slice(0, 3),
    last: digits.slice(3),
  };
}

function postalCodeToAreaHint(postalCode) {
  const digits = String(postalCode || "").replace(/\D/g, "");
  if (digits === "1350063") {
    return "有明１丁目";
  }
  return "";
}

function parseBuildingParts(value) {
  const text = normalizeText(value);
  const roomMatch = text.match(/^(.*?)(\d+)[-ー](\d{2,4})$/);
  if (roomMatch) {
    return {
      buildingName: normalizeText(roomMatch[1]),
      buildingNo: `${roomMatch[2]}号棟`,
      roomNo: roomMatch[3],
    };
  }

  const match = text.match(/^(.*?)(\d{3,4})$/);
  if (match) {
    return {
      buildingName: normalizeText(match[1]),
      buildingNo: "",
      roomNo: match[2],
    };
  }

  return { buildingName: text, buildingNo: "", roomNo: "" };
}

async function writeResult(payload) {
  await fs.writeFile(RESULT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readSession() {
  try {
    const raw = await fs.readFile(SESSION_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeSession(payload) {
  await fs.writeFile(SESSION_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .slice(0, 80);
}

async function getVisibleText(page) {
  return normalizeText(await page.locator("body").innerText().catch(() => ""));
}

async function getControlsSnapshot(page) {
  const items = await page
    .locator("button, a, input, select, textarea")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const tag = node.tagName.toLowerCase();
          const text = (node.innerText || node.textContent || node.value || "").trim();
          const name = node.getAttribute("name") || "";
          const id = node.id || "";
          const type = node.getAttribute("type") || "";
          const value = node.value || node.getAttribute("value") || "";
          const label = (node.getAttribute("aria-label") || "").trim();
          const placeholder = (node.getAttribute("placeholder") || "").trim();
          const parts = [tag, name, id, type, value, label, placeholder, text].map((part) => (part || "").trim()).filter(Boolean);
          return parts.join(" | ");
        })
        .filter(Boolean),
    )
    .catch(() => []);
  return items.join("\n");
}

async function saveDebugSnapshot(page, step, label) {
  if (!observationEnabled || !page || !currentDebugSessionDir) {
    return;
  }
  const stamp = formatTimestamp();
  const safeStep = sanitizeFileName(step);
  const safeLabel = sanitizeFileName(label || "");
  const prefix = [stamp, safeStep, safeLabel].filter(Boolean).join("_");
  const base = path.join(currentDebugSessionDir, prefix);
  const payload = {
    step,
    label,
    saved_at: nowIso(),
    title: await page.title().catch(() => ""),
    current_url: page.url(),
    visible_text: await getVisibleText(page),
    controls: await getControlsSnapshot(page),
  };
  await fs.writeFile(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(`${base}.html`, await page.content().catch(() => ""), "utf8");
  await fs.writeFile(`${base}.title.txt`, `${payload.title}\n`, "utf8");
  await fs.writeFile(`${base}.url.txt`, `${payload.current_url}\n`, "utf8");
  await fs.writeFile(`${base}.text.txt`, `${payload.visible_text}\n`, "utf8");
  await fs.writeFile(`${base}.controls.txt`, `${payload.controls}\n`, "utf8");
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
}

async function saveDebugError(page, reason, step, visibleText = "") {
  if (!observationEnabled) {
    return;
  }
  const dir = path.join(DEBUG_ROOT, `error-${formatTimestamp()}`);
  await ensureDir(dir);
  await ensureDir(TRACE_DIR);
  const targetPage = page || null;
  const payload = {
    reason,
    step,
    saved_at: nowIso(),
    title: targetPage ? await targetPage.title().catch(() => "") : "",
    current_url: targetPage ? targetPage.url() : "",
    visible_text: visibleText || (targetPage ? await getVisibleText(targetPage) : ""),
    controls: targetPage ? await getControlsSnapshot(targetPage) : "",
  };
  await fs.writeFile(path.join(dir, "error.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (targetPage) {
    await fs.writeFile(path.join(dir, "page.html"), await targetPage.content().catch(() => ""), "utf8");
    await fs.writeFile(path.join(dir, "page.title.txt"), `${payload.title}\n`, "utf8");
    await fs.writeFile(path.join(dir, "page.url.txt"), `${payload.current_url}\n`, "utf8");
    await fs.writeFile(path.join(dir, "page.text.txt"), `${payload.visible_text}\n`, "utf8");
    await fs.writeFile(path.join(dir, "page.controls.txt"), `${payload.controls}\n`, "utf8");
    await targetPage.screenshot({ path: path.join(dir, "page.png"), fullPage: true }).catch(() => {});
  }
  if (traceStarted && !traceExported && targetPage?.context) {
    await targetPage.context().tracing.stop({ path: TRACE_PATH }).catch(() => {});
    traceExported = true;
  } else if (traceStarted && !traceExported) {
    await fs.copyFile(TRACE_PATH, path.join(dir, "trace.zip")).catch(() => {});
    traceExported = true;
  }
  console.log(`debug 保存: ${dir}`);
}

async function recordDebugStep(page, step, label) {
  if (!observationEnabled || !page || !currentDebugSessionDir) {
    return;
  }
  await saveDebugSnapshot(page, step, label);
}

function inferCauseFromDebug(reason, step, text) {
  const combined = normalizeText(`${reason} ${step} ${text}`);
  const hints = [];
  if (combined.includes("多重申込")) {
    hints.push("既に予約済みか、同一世帯の新規申込制限に達している可能性があります。");
  }
  if (combined.includes("収集日")) {
    hints.push("収集日ピッカーの選択が確定していない可能性があります。");
  }
  if (combined.includes("確認")) {
    hints.push("確認画面のチェックボックスや送信ボタンが押されていない可能性があります。");
  }
  return hints;
}

async function stopSafely(reason, lastKnownStep) {
  console.error(`停止: ${reason}`);
  if (globalThis.__currentPageForDebug) {
    const visibleText = await getVisibleText(globalThis.__currentPageForDebug).catch(() => "");
    await saveDebugError(globalThis.__currentPageForDebug, reason, lastKnownStep, visibleText);
    const hints = inferCauseFromDebug(reason, lastKnownStep, visibleText);
    if (hints.length > 0) {
      console.error(`原因候補: ${hints.join(" / ")}`);
    }
  }
  await writeResult({
    status: "stopped",
    stopped_at: nowIso(),
    reason,
    last_known_step: lastKnownStep,
  });
  throw new Error(reason);
}

function requireEnv() {
  const missing = [
    "KOTO_NAME",
    "KOTO_NAME_KANA",
    "KOTO_POSTAL_CODE",
    "KOTO_ADDRESS",
    "KOTO_PHONE",
    "KOTO_EMAIL",
  ].filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`.env の必須項目が不足しています: ${missing.join(", ")}`);
  }
}

async function askRuntimeInputs(rl) {
  if (env.resolvedItemsJson) {
    try {
      const parsed = JSON.parse(env.resolvedItemsJson);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const items = parsed
          .map((item) => ({
            itemName: normalizeText(item?.canonicalName || item?.itemName || ""),
            quantity: Number(item?.quantity || 0),
            category: normalizeText(item?.category || ""),
          }))
          .filter((item) => item.itemName && Number.isInteger(item.quantity) && item.quantity > 0);
        if (items.length > 0) {
          console.log("wrapper から解釈済みの品目を受け取りました。");
          return { items };
        }
      }
    } catch (error) {
      console.log(`wrapper からの解釈済み品目JSONを読めませんでした: ${error.message}`);
    }
  }

  const items = [];

  while (true) {
    const itemName = normalizeText(await rl.question("粗大ごみの品目名を入力してください: "));
    const quantityRaw = normalizeText(await rl.question("数量を入力してください: "));
    const quantity = Number(quantityRaw);

    if (!itemName) {
      throw new Error("品目名が空です。");
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error("数量は 1 以上の整数で入力してください。");
    }

    items.push({ itemName, quantity });

    const more = normalizeText(await rl.question("別の品目も追加しますか？ (y/N): "));
    if (!/^y(es)?$/i.test(more)) {
      break;
    }
  }

  return { items };
}

async function askChoice(rl, title, options) {
  if (options.length === 0) {
    throw new Error("選択肢がありません。");
  }

  if (options.length === 1) {
    return 0;
  }

  console.log(title);
  options.forEach((option, index) => {
    console.log(`${index + 1}. ${normalizeText(option)}`);
  });

  while (true) {
    const answer = normalizeText(await rl.question("番号を選択してください: "));
    const value = Number(answer);
    if (Number.isInteger(value) && value >= 1 && value <= options.length) {
      return value - 1;
    }
    console.log("有効な番号を入力してください。");
  }
}

async function loadItemCatalog() {
  if (itemCatalogCache) {
    return itemCatalogCache;
  }

  try {
    const raw = await fs.readFile(ITEM_CATALOG_PATH, "utf8");
    itemCatalogCache = JSON.parse(raw);
  } catch {
    itemCatalogCache = { categories: [] };
  }

  return itemCatalogCache;
}

async function loadItemMaster() {
  if (itemMasterCache) {
    return itemMasterCache;
  }

  try {
    const raw = await fs.readFile(ITEM_MASTER_PATH, "utf8");
    itemMasterCache = JSON.parse(raw);
  } catch {
    itemMasterCache = { items: [] };
  }

  return itemMasterCache;
}

function findExactMasterItem(items, requestedItem) {
  const normalizedRequested = normalizeText(requestedItem);
  return (items || []).find((item) => normalizeText(item.item_name) === normalizedRequested) || null;
}

function flattenCatalogItems(catalog) {
  const categories = Array.isArray(catalog?.categories) ? catalog.categories : [];
  return categories.flatMap((category) => {
    const items = (category.items || []).map((item) =>
      typeof item === "string"
        ? { canonicalName: item, aliases: [] }
        : {
            canonicalName: item.canonicalName || item.name || "",
            aliases: Array.isArray(item.aliases) ? item.aliases : [],
          },
    );
    return items.map((item) => ({
      category: category.name || "",
      canonicalName: item.canonicalName,
      aliases: item.aliases,
      keywords: Array.isArray(category.keywords) ? category.keywords : [],
    }));
  });
}

function scoreCatalogText(haystack, needle) {
  const normalizedHaystack = normalizeText(haystack);
  const normalizedNeedle = normalizeText(needle);
  if (!normalizedHaystack || !normalizedNeedle) {
    return 0;
  }
  if (includesNormalized(normalizedHaystack, normalizedNeedle)) {
    return 4;
  }
  const hiraganaNeedle = toHiragana(normalizedNeedle);
  if (normalizedHaystack.includes(hiraganaNeedle) || normalizedHaystack.includes(toKatakana(normalizedNeedle))) {
    return 3;
  }
  return 0;
}

function normalizeSearchTerm(value) {
  return toKatakana(normalizeText(value));
}

async function inferCatalogSelection(requestedItem) {
  const catalog = await loadItemCatalog();
  const categories = Array.isArray(catalog.categories) ? catalog.categories : [];
  const candidates = [];

  for (const category of categories) {
    const categoryItems = (category.items || []).map((item) =>
      typeof item === "string"
        ? { canonicalName: item, aliases: [] }
        : {
            canonicalName: item.canonicalName || item.name || "",
            aliases: Array.isArray(item.aliases) ? item.aliases : [],
          },
    );
    const categoryScore = [
      category.name,
      ...(category.keywords || []),
      ...categoryItems.map((item) => item.canonicalName),
      ...categoryItems.flatMap((item) => item.aliases),
    ].reduce((score, value) => score + scoreCatalogText(value, requestedItem), 0);

    for (const item of categoryItems) {
      const itemScore =
        scoreCatalogText(item.canonicalName, requestedItem) +
        item.aliases.reduce((sum, alias) => sum + scoreCatalogText(alias, requestedItem), 0);
      if (itemScore > 0 || categoryScore > 0) {
        candidates.push({
          category: category.name,
          itemName: item.canonicalName,
          score: categoryScore + itemScore,
        });
      }
    }

    if (categoryItems.length === 0 && categoryScore > 0) {
      candidates.push({
        category: category.name,
        itemName: "",
        score: categoryScore,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

async function askReuseAuthenticationUrl(rl, cachedUrl) {
  if (!cachedUrl) {
    return null;
  }

  const answer = normalizeText(
    await rl.question("前回の認証URLを再利用しますか？ (Y/n): "),
  );

  if (!answer || /^y(es)?$/i.test(answer)) {
    return cachedUrl;
  }

  return null;
}

async function waitForStableNavigation(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

async function detectStopConditions(page, step) {
  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  const lines = bodyText.split(/\n+/).map((line) => normalizeText(line)).filter(Boolean);
  const blockers = ["CAPTCHA", "画像認証", "メンテナンス", "ただいまご利用", "エラー", "エラーが発生"];
  const found = blockers.find((word) => bodyText.includes(word));
  if (found) {
    const matchedLine =
      lines.find((line) => line.includes(found)) ||
      lines.find((line) => line.includes("新規") && line.includes("多重")) ||
      lines.find((line) => line.includes("申込") && line.includes("失敗")) ||
      "";
    const detail = matchedLine ? `: ${matchedLine}` : "";
    await stopSafely(`${found} を検知したため停止しました${detail}`, step);
  }
}

async function clickFirstVisible(page, candidates) {
  for (const candidate of candidates) {
    const locator = candidate();
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const nth = locator.nth(index);
      if (await nth.isVisible().catch(() => false)) {
        await nth.click();
        return true;
      }
    }
  }
  return false;
}

async function gotoMailInput(page) {
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await waitForStableNavigation(page);
  await detectStopConditions(page, "start");

  const title = await page.title();
  if (!includesNormalized(title, "江東区粗大ごみインターネット申込")) {
    await stopSafely("開始ページのタイトルが想定外です。", "start");
  }

  await page.goto(MAIL_INPUT_URL, { waitUntil: "domcontentloaded" });
  await waitForStableNavigation(page);
  await detectStopConditions(page, "mail_input");

  const bodyText = normalizeText(await page.locator("body").innerText());
  if (!bodyText.includes("メールアドレス")) {
    await stopSafely("メールアドレス入力画面に遷移できませんでした。", "mail_input");
  }
}

async function splitEmailAddress(email) {
  const at = email.indexOf("@");
  if (at < 1 || at === email.length - 1) {
    throw new Error("KOTO_EMAIL の形式が不正です。");
  }
  return [email.slice(0, at), email.slice(at + 1)];
}

async function submitEmail(page) {
  const [mailLocal, mailDomain] = await splitEmailAddress(env.email);

  const emailField = page.locator('input[name="mail"]');
  const localField = page.locator('input[name="remail1"]');
  const domainField = page.locator('input[name="remail2"]');

  await emailField.fill(env.email);
  await localField.fill(mailLocal);
  await domainField.fill(mailDomain);

  const clicked = await clickFirstVisible(page, [
    () => page.getByRole("button", { name: /送\s*信/ }),
    () => page.locator('input[type="submit"][value*="送"]'),
  ]);

  if (!clicked) {
    await stopSafely("メール送信ボタンが見つかりませんでした。", "mail_input");
  }

  await waitForStableNavigation(page);
}

async function askAuthenticationUrl(rl) {
  const authUrl = normalizeText(
    await rl.question("確認メールに記載された認証URLを貼り付けてください: "),
  );

  if (!/^https?:\/\//i.test(authUrl)) {
    throw new Error("認証URLの形式が不正です。");
  }

  return authUrl;
}

async function tryFillByLabels(page, value, labels) {
  for (const label of labels) {
    const locator = page.getByLabel(label, { exact: false });
    if ((await locator.count().catch(() => 0)) > 0 && (await locator.first().isVisible().catch(() => false))) {
      await locator.first().fill(value);
      return true;
    }
  }
  return false;
}

async function fillByName(page, name, value) {
  if (!value && value !== "0") {
    return false;
  }
  const locator = page.locator(`[name="${name}"]`);
  if (!(await locator.count().catch(() => 0))) {
    return false;
  }
  await locator.first().fill(String(value)).catch(() => {});
  return true;
}

async function selectByNameText(page, name, matcher) {
  const locator = page.locator(`select[name="${name}"]`);
  if (!(await locator.count().catch(() => 0))) {
    return false;
  }
  const options = await locator
    .first()
    .locator("option")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        value: node.getAttribute("value") || "",
        text: (node.textContent || "").trim(),
      })),
    )
    .catch(() => []);
  const found = options.find((option) => matcher(option.text));
  if (!found) {
    return false;
  }
  await locator.first().selectOption(found.value).catch(() => {});
  return true;
}

async function trySelectByLabels(page, labels, matcher) {
  for (const label of labels) {
    const locator = page.getByLabel(label, { exact: false });
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const field = locator.nth(index);
      const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
      if (tag !== "select") {
        continue;
      }
      const options = await field
        .locator("option")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            value: node.getAttribute("value") || "",
            text: (node.textContent || "").trim(),
          })),
        )
        .catch(() => []);
      const found = options.find((option) => matcher(option.text));
      if (found) {
        await field.selectOption(found.value);
        return true;
      }
    }
  }
  return false;
}

async function trySelectRadioByText(page, text) {
  const radio = page.getByRole("radio", { name: new RegExp(text) });
  if ((await radio.count().catch(() => 0)) > 0) {
    await radio.first().check();
    return true;
  }

  const label = page.getByText(text, { exact: false });
  if ((await label.count().catch(() => 0)) > 0) {
    const first = label.first();
    await first.click().catch(() => {});
    return true;
  }
  return false;
}

async function collectClickableTexts(page) {
  return page
    .locator("button, input[type='button'], input[type='submit'], a, label")
    .evaluateAll((elements) =>
      elements
        .map((element) => (element.innerText || element.value || element.textContent || "").trim())
        .filter(Boolean),
    );
}

async function openItemSearch(page, categoryName = "") {
  if (categoryName) {
    const categorySelect = page.locator('select[name="itemType"]').first();
    if (await categorySelect.count().catch(() => 0)) {
      const options = await categorySelect
        .locator("option")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            value: node.getAttribute("value") || "",
            text: (node.textContent || "").trim(),
          })),
        )
        .catch(() => []);
      const matched = options.find((option) => includesNormalized(option.text, categoryName));
      if (matched) {
        await categorySelect.selectOption(matched.value).catch(() => {});
      }
    }
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.evaluate(() => {
      const listButton = document.forms.frmbutton?.often;
      if (listButton) {
        listButton.click();
        return;
      }
      document.forms.frmbutton.subBtn.click();
    }),
  ]);
  await waitForStableNavigation(page);
}

async function collectItemCandidatesFromSearchResults(page) {
  const rows = page.locator("table tr");
  const count = await rows.count().catch(() => 0);
  const candidates = [];

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const text = normalizeText(await row.innerText().catch(() => ""));
    const button = row.locator('input[type="submit"][value="選択"], input[type="submit"][value="解除"]').first();
    const hasButton = (await button.count().catch(() => 0)) > 0;
    if (!text || !hasButton) {
      continue;
    }

    candidates.push({
      row,
      text,
      button,
    });
  }

  return candidates;
}

async function chooseItemCandidate(page, rl, requestedItem) {
  const bodyText = normalizeText(await page.locator("body").innerText());
  if (!bodyText.includes("排出品目入力")) {
    await stopSafely("品目入力画面を認識できませんでした。", "item_input");
  }

  const master = await loadItemMaster();
  const exactMasterItem = findExactMasterItem(master.items, requestedItem);
  if (!exactMasterItem) {
    await stopSafely(`公式品目マスタに一致する品目が見つかりませんでした: ${requestedItem}`, "item_input");
  }

  const catalogSelection = await inferCatalogSelection(exactMasterItem.item_name);
  await openItemSearch(page, catalogSelection?.category || "");

  const collectCurrentCandidates = async () => {
    const candidates = await collectItemCandidatesFromSearchResults(page);
    if (candidates.length > 0) {
      return candidates;
    }

    const clicked = await clickFirstVisible(page, [
      () => page.getByRole("button", { name: /一覧を表示する/ }),
      () => page.locator('input[type="submit"][value*="一覧"]').first(),
    ]);
    if (clicked) {
      await waitForStableNavigation(page);
      return collectItemCandidatesFromSearchResults(page);
    }

    return [];
  };

  if (catalogSelection?.category) {
    const directListCandidates = await collectCurrentCandidates();
    if (directListCandidates.length > 0) {
      const exactDirectMatches = directListCandidates.filter((candidate) =>
        normalizeText(candidate.text).startsWith(normalizeText(exactMasterItem.item_name)),
      );
      if (exactDirectMatches.length === 1) {
        const selectedCandidate = exactDirectMatches[0];
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          selectedCandidate.button.click(),
        ]);
        await waitForStableNavigation(page);

        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.locator('input[name="back"]').click(),
        ]);
        await waitForStableNavigation(page);
        return selectedCandidate.text;
      }
    }
  }
  const matchingCandidates = await collectCurrentCandidates();
  const exactSiteMatches = matchingCandidates.filter((candidate) =>
    normalizeText(candidate.text).startsWith(normalizeText(exactMasterItem.item_name)),
  );

  if (exactSiteMatches.length === 0) {
    await stopSafely(`予約サイトで正式品目名の完全一致候補が見つかりませんでした: ${exactMasterItem.item_name}`, "item_input");
  }

  if (exactSiteMatches.length > 1) {
    await stopSafely(`予約サイトで正式品目名の完全一致候補が複数見つかりました: ${exactMasterItem.item_name}`, "item_input");
  }

  const selectedCandidate = exactSiteMatches[0];

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    selectedCandidate.button.click(),
  ]);
  await waitForStableNavigation(page);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.locator('input[name="back"]').click(),
  ]);
  await waitForStableNavigation(page);

  return exactMasterItem.item_name;
}

async function fillQuantity(page, quantity) {
  const fields = [
    page.getByLabel("数量", { exact: false }),
    page.locator('select[name^="num"], input[name*="count"], input[name*="qty"], input[type="number"], select[name*="count"], select[name*="qty"]'),
  ];

  for (const locator of fields) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const field = locator.nth(index);
      if (!(await field.isVisible().catch(() => false))) {
        continue;
      }

      const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
      if (tag === "select") {
        await field.selectOption(String(quantity)).catch(() => {});
      } else {
        await field.fill(String(quantity)).catch(() => {});
      }
      return true;
    }
  }

  return false;
}

async function proceedFromGuideIfNeeded(page) {
  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  if (!bodyText.includes("申込案内") && !bodyText.includes("申込開始")) {
    return;
  }

  const clicked = await clickFirstVisible(page, [
    () => page.getByRole("button", { name: /申込開始/ }),
    () => page.locator('input[type="submit"][value="申込開始"]'),
  ]);

  if (!clicked) {
    await stopSafely("申込開始ボタンが見つかりませんでした。", "guide");
  }

  await waitForStableNavigation(page);
}

async function proceedToApplicantForm(page) {
  const clicked = await clickFirstVisible(page, [
    () => page.getByRole("button", { name: /次へ|進む|入力へ|申込者情報入力/ }),
    () => page.locator('input[type="submit"][value*="次"], input[type="submit"][value*="進"]'),
  ]);

  if (!clicked) {
    await stopSafely("次へ進むボタンが見つかりませんでした。", "item_input");
  }

  await waitForStableNavigation(page);
}

async function waitForCollectionPage(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
    const title = normalizeText(await page.title().catch(() => ""));
    const hasDateInputs = (await page.locator('input[name="pc_date"], input[name="sp_date"]').count().catch(() => 0)) > 0;
    const currentUrl = page.url();
    if (
      hasDateInputs ||
      title === "収集" ||
      bodyText.includes("収集日の選択") ||
      /\/sodai\/mo\.jqsu8u\.on\.jqsu8u\.na(?:[?#].*)?$/.test(currentUrl)
    ) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function fillApplicantForm(page, rl) {
  const bodyText = normalizeText(await page.locator("body").innerText());
  if (!bodyText.includes("申込者") && !bodyText.includes("住所") && !bodyText.includes("氏名")) {
    await stopSafely("申込者情報入力画面を認識できませんでした。", "applicant_input");
  }

  const name = splitJapaneseName(env.name);
  const nameKana = splitJapaneseName(toKatakana(env.nameKana));
  const addressParts = parseAddressParts(env.address);
  const postalCode = splitPostalCode(env.postalCode);
  const buildingParts = parseBuildingParts(env.building);
  const phoneDigits = String(env.phone || "").replace(/\D/g, "");
  const postalAreaHint = postalCodeToAreaHint(env.postalCode);

  await fillByName(page, "kanjisei", name.lastName);
  await fillByName(page, "kanjimei", name.firstName);
  await fillByName(page, "kanasei", nameKana.lastName);
  await fillByName(page, "kanamei", nameKana.firstName);
  await fillByName(page, "tel1", phoneDigits);
  await fillByName(page, "tel2", phoneDigits);
  await fillByName(page, "frontzipcode", postalCode?.first || "");
  await fillByName(page, "backzipcode", postalCode?.last || "");
  await fillByName(page, "address2", addressParts?.banchi || "");
  await fillByName(page, "address3", addressParts?.go || "");
  await fillByName(page, "address5", buildingParts.buildingName);
  await fillByName(page, "address6", buildingParts.buildingNo);
  await fillByName(page, "address7", buildingParts.roomNo);

  if (postalAreaHint) {
    const addressSelect = page.locator('select[name="address1"]').first();
    const options = await addressSelect
      .locator("option")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: node.getAttribute("value") || "",
          text: (node.textContent || "").trim(),
        })),
      )
      .catch(() => []);
    const preferred = options.find((option) => includesNormalized(option.text, postalAreaHint));
    if (preferred) {
      await addressSelect.selectOption(preferred.value).catch(() => {});
    }
  } else if (addressParts?.area && addressParts?.chome) {
    await selectByNameText(
      page,
      "address1",
      (text) => includesNormalized(text, addressParts.area) && includesNormalized(text, addressParts.chome),
    );
  }

  await selectByNameText(page, "home_type", (text) =>
    includesNormalized(text, "集合住宅") || includesNormalized(text, "マンション"),
  );

  const homeTypeValue = await page.locator('select[name="home_type"]').first().inputValue().catch(() => "");
  const preferredLocation = env.defaultDisposalLocation;
  if (homeTypeValue === "apartment") {
    await selectByNameText(page, "outplaceagg", (text) => includesNormalized(text, "粗大ごみ置場"));
  } else {
    await selectByNameText(page, "outplace", (text) => includesNormalized(text, preferredLocation));
  }

  const commitButton = page.locator('input[type="submit"][value="収集日選択画面へ進む"]').first();
  if (!(await commitButton.count().catch(() => 0))) {
    await stopSafely("収集日選択画面へ進むボタンが見つかりませんでした。", "applicant_input");
  }
  await Promise.all([
    page.waitForURL(/\/sodai\/mo\.jqsu8u\.on\.jqsu8u\.na(?:[?#].*)?$/, { timeout: 15000 }).catch(() => {}),
    commitButton.click({ force: true }),
  ]);

  await waitForStableNavigation(page);
  if (!(await waitForCollectionPage(page))) {
    console.log(`収集日画面への遷移確認に失敗しました。url=${page.url()}`);
    await stopSafely("収集日選択画面への遷移を確認できませんでした。", "applicant_input");
  }
}

async function completeApplicantFlow(page, rl) {
  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  if (bodyText.includes("申込者") || bodyText.includes("住所") || bodyText.includes("氏名") || bodyText.includes("郵便番号")) {
    await fillApplicantForm(page, rl);
    return;
  }

  if (bodyText.includes("収集日")) {
    return;
  }

  await stopSafely("申込者情報入力後の画面を認識できませんでした。", "applicant_input");
}

async function selectEarliestCollectionDate(page) {
  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  const hasDateInputs = (await page.locator('input[name="pc_date"], input[name="sp_date"]').count().catch(() => 0)) > 0;
  if (!bodyText.includes("収集日") && !hasDateInputs) {
    await stopSafely("収集日選択画面を認識できませんでした。", "date_select");
  }

  const pcDate = page.locator('input[name="pc_date"]').first();
  const spDate = page.locator('input[name="sp_date"]').first();
  const dateInput = (await pcDate.count().catch(() => 0)) ? pcDate : spDate;
  if (!(await dateInput.count().catch(() => 0))) {
    await stopSafely("収集日入力欄が見つかりませんでした。", "date_select");
  }

  const beforeValue = await dateInput.inputValue().catch(() => "");
  await dateInput.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1200);

  const dateCells = page.locator("td, button, a, span, div").filter({ hasText: /[0-9０-９]{1,2}/ });
  const cellCount = await dateCells.count().catch(() => 0);
  let selected = false;
  for (let i = 0; i < Math.min(cellCount, 60); i += 1) {
    const target = dateCells.nth(i);
    const text = normalizeText(await target.innerText().catch(() => ""));
    if (!text || !/[0-9０-９]{1,2}/.test(text)) {
      continue;
    }
    const ariaDisabled = normalizeText(await target.getAttribute("aria-disabled").catch(() => ""));
    const ariaSelected = normalizeText(await target.getAttribute("aria-selected").catch(() => ""));
    const className = normalizeText(await target.getAttribute("class").catch(() => ""));
    const isDisabled = ariaDisabled === "true" || /disabled|unavailable|blank|no|off/i.test(className);
    if (isDisabled) {
      continue;
    }
    if (ariaSelected === "true" || /selected|current/i.test(className)) {
      continue;
    }
    const box = await target.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    } else {
      await target.click({ force: true }).catch(() => {});
    }
    selected = true;
    break;
  }

  if (!selected) {
    if (await spDate.count().catch(() => 0)) {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      await spDate.first().fill(`${yyyy}-${mm}-${dd}`).catch(() => {});
      selected = true;
    }
  }

  if (!selected) {
    await stopSafely("選択可能な収集日が見つかりませんでした。", "date_select");
  }

  await page.waitForTimeout(800);
  const afterValue = await dateInput.inputValue().catch(() => "");
  const dateValue = await spDate.inputValue().catch(() => "");
  if (!afterValue && !dateValue) {
    console.log(`収集日の選択値が変わっていません。before=${beforeValue} after=${afterValue} sp=${dateValue}`);
    await stopSafely("収集日の選択が確定できませんでした。", "date_select");
  }
  if (!afterValue && dateValue) {
    console.log(`収集日は選択されました。sp=${dateValue}`);
  }

  const clicked = await clickFirstVisible(page, [
    () => page.getByRole("button", { name: /次へ|確認/ }),
    () => page.locator('input[type="submit"][value*="次"], input[type="submit"][value*="確認"]'),
  ]);

  if (!clicked) {
    await stopSafely("収集日選択後に次へ進めませんでした。", "date_select");
  }

  await waitForStableNavigation(page);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
    const title = normalizeText(await page.title().catch(() => ""));
    const currentUrl = page.url();
    if (
      bodyText.includes("確認") ||
      bodyText.includes("申込内容") ||
      bodyText.includes("最終") ||
      /confirm|check/i.test(currentUrl) ||
      /確認/.test(title)
    ) {
      return;
    }
    await page.waitForTimeout(500);
  }
  console.log(`確認画面の到達を明示確認できませんでした。url=${page.url()}`);
}

async function extractConfirmationDetails(page) {
  const bodyText = normalizeText(await page.locator("body").innerText());
  const lines = bodyText
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const tableText = normalizeText(await page.locator("table").first().innerText().catch(() => ""));
  const rowTexts = await page
    .locator("tr, th, td, label, input, select, option")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => {
          if (node.tagName === "INPUT" || node.tagName === "SELECT") {
            const el = node;
            return `${el.name || ""} ${el.value || ""}`.trim();
          }
          return (node.textContent || "").trim();
        })
        .filter(Boolean),
    )
    .catch(() => []);
  const combinedText = [bodyText, tableText, ...rowTexts].filter(Boolean).join("\n");

  const dateLine = lines.find((line) => line.includes("収集日") || /\d+月\d+日/.test(line)) || "";
  const feeLine = lines.find((line) => line.includes("円") || line.includes("手数料")) || "";
  const locationLine = lines.find((line) => line.includes("置き場") || line.includes("玄関")) || "";
  const receptionLine =
    lines.find((line) => line.includes("受付番号") || line.includes("申込番号") || line.includes("確認番号")) || "";

  return {
    bodyText,
    combinedText,
    dateLine,
    feeLine,
    locationLine,
    receptionLine,
  };
}

async function validateFinalConfirmation(page, officialItemName, quantity) {
  const detail = await extractConfirmationDetails(page);
  const errors = [];
  const name = splitJapaneseName(env.name);
  const nameKana = splitJapaneseName(toKatakana(env.nameKana));
  const addressParts = parseAddressParts(env.address);
  const buildingParts = parseBuildingParts(env.building);

  if (!includesNormalized(detail.combinedText, name.lastName) || !includesNormalized(detail.combinedText, name.firstName)) {
    errors.push("氏名が確認画面で一致しません。");
  }
  if (!includesNormalized(detail.combinedText, nameKana.lastName) || !includesNormalized(detail.combinedText, nameKana.firstName)) {
    errors.push("氏名カタカナが確認画面で一致しません。");
  }
  if (!includesNormalized(detail.combinedText, env.email)) {
    errors.push("メールアドレスが確認画面で一致しません。");
  }
  if (addressParts?.area && !includesNormalized(detail.combinedText, addressParts.area)) {
    errors.push("住所が確認画面で一致しません。");
  }
  if (addressParts?.banchi && !includesNormalized(detail.combinedText, addressParts.banchi)) {
    errors.push("番地が確認画面で一致しません。");
  }
  if (buildingParts.buildingName && !includesNormalized(detail.combinedText, buildingParts.buildingName)) {
    errors.push("建物名が確認画面で一致しません。");
  }
  if (!includesNormalized(detail.combinedText, officialItemName)) {
    errors.push("品目名が確認画面で一致しません。");
  }
  if (!includesNormalized(detail.combinedText, String(quantity))) {
    errors.push("数量が確認画面で一致しません。");
  }
  if (!detail.dateLine && !/\d+月\d+日/.test(detail.combinedText)) {
    errors.push("収集日が確認できません。");
  }
  if (!detail.feeLine && !/\b\d+\b/.test(detail.combinedText)) {
    errors.push("料金表示が確認できません。");
  }
  if (detail.combinedText.includes("警告") || detail.combinedText.includes("エラー")) {
    errors.push("警告またはエラー表示があります。");
  }

  return {
    valid: errors.length === 0,
    errors,
    detail,
  };
}

async function submitFinalReservation(page) {
  const confirmationCheckbox = page.locator('input[type="checkbox"], input[name*="confirm"], input[name*="check"]').first();
  if (await confirmationCheckbox.count().catch(() => 0)) {
    await confirmationCheckbox.check({ force: true }).catch(() => {});
  }

  const clicked = await clickFirstVisible(page, [
    () => page.getByRole("button", { name: /申込|確定|予約/ }),
    () => page.locator('input[type="submit"][value*="申"], input[type="submit"][value*="確定"], input[type="submit"][value*="予約"]'),
  ]);

  if (!clicked) {
    await stopSafely("最終確定ボタンが見つかりませんでした。", "final_confirmation");
  }

  await waitForStableNavigation(page);
}

async function waitForCompletionPage(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
    const title = normalizeText(await page.title().catch(() => ""));
    const currentUrl = page.url();
    if (
      bodyText.includes("完了") ||
      bodyText.includes("予約が完了") ||
      bodyText.includes("受付番号") ||
      bodyText.includes("申込が完了") ||
      /complete|finish|done|thanks/i.test(currentUrl) ||
      /完了/.test(title)
    ) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function main() {
  requireEnv();
  const rl = readline.createInterface({ input, output });
  let browser;
  let context;
  let page;

  try {
    const { items } = await askRuntimeInputs(rl);
    const cachedSession = await readSession();

    await ensureDir(DEBUG_ROOT);
    currentDebugSessionDir = path.join(DEBUG_ROOT, `run-${formatTimestamp()}`);
    await ensureDir(currentDebugSessionDir);

    browser = await launchBrowser({ headless: env.headless });
    console.log(`browser_channel=${getBrowserChannel()}`);
    context = await browser.newContext({
      locale: "ja-JP",
      extraHTTPHeaders: {
        "Accept-Language": "ja-JP,ja;q=0.9",
      },
    });
    if (observationEnabled) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      traceStarted = true;
    }
    page = await context.newPage();
    globalThis.__currentPageForDebug = page;

    let authUrl = await askReuseAuthenticationUrl(rl, cachedSession?.authUrl);
    if (!authUrl) {
      console.log("開始ページを開いています。");
      await gotoMailInput(page);
      await recordDebugStep(page, "mail_input", "start");
      console.log("メールアドレスを送信しています。");
      await submitEmail(page);
      await recordDebugStep(page, "mail_sent", "start");
      authUrl = await askAuthenticationUrl(rl);
    }

    await writeSession({
      authUrl,
      saved_at: nowIso(),
    });

    console.log("認証URLへ移動しています。");
    await page.goto(authUrl, { waitUntil: "domcontentloaded" });
    await recordDebugStep(page, "authenticated", "auth_url");
    await waitForStableNavigation(page);
    await detectStopConditions(page, "authenticated");
    await proceedFromGuideIfNeeded(page);
    await recordDebugStep(page, "guide", "after_guide");

    const selectedItems = [];
    for (const [index, item] of items.entries()) {
      console.log(`品目を選択しています。 (${index + 1}/${items.length})`);
      const selectedItem = await chooseItemCandidate(page, rl, item.itemName);
      await recordDebugStep(page, "item_selected", selectedItem);

      const quantityFilled = await fillQuantity(page, item.quantity);
      if (!quantityFilled) {
        console.log("数量欄を自動判定できなかったため、画面を確認してください。");
      }
      await recordDebugStep(page, "quantity_filled", String(item.quantity));

      selectedItems.push({
        requestedItem: item.itemName,
        officialItemName: selectedItem,
        selectedSiteItem: selectedItem,
        quantity: item.quantity,
      });
    }

    await proceedToApplicantForm(page);
    await recordDebugStep(page, "applicant_form", "before_fill");

    console.log("申込者情報を入力しています。");
    await completeApplicantFlow(page, rl);
    await recordDebugStep(page, "applicant_done", "after_fill");

    console.log("最短の収集日を選択しています。");
    await selectEarliestCollectionDate(page);
    await recordDebugStep(page, "date_selected", "after_date");

    console.log("最終確認画面を検証しています。");
    const validation = await validateFinalConfirmation(
      page,
      selectedItems.map((item) => item.officialItemName).join(" "),
      selectedItems.reduce((sum, item) => sum + item.quantity, 0),
    );
    if (!validation.valid) {
      await stopSafely(`最終確認の検証に失敗しました: ${validation.errors.join(" / ")}`, "final_confirmation");
    }
    await recordDebugStep(page, "final_confirmation", "validated");

    if (dryRun) {
      await writeResult({
        status: "stopped",
        stopped_at: nowIso(),
        reason: "dry-run のため最終確定を実行していません。",
        last_known_step: "final_confirmation",
      });
      console.log("dry-run のため確定せず終了しました。");
      return;
    }

    console.log("検証を通過したため予約を確定します。");
    await submitFinalReservation(page);
    await recordDebugStep(page, "submitted", "after_submit");
    if (!(await waitForCompletionPage(page))) {
      await stopSafely("予約確定後の完了画面を確認できませんでした。", "completed");
    }
    await detectStopConditions(page, "completed");
    await recordDebugStep(page, "completed", "after_completion");

    const detail = await extractConfirmationDetails(page);
    await writeResult({
      status: "success",
      reserved_at: nowIso(),
      requested_item: selectedItems.map((item) => item.requestedItem).join(" / "),
      official_item_name: selectedItems.map((item) => item.officialItemName).join(" / "),
      item: selectedItems.map((item) => item.officialItemName).join(" / "),
      quantity: selectedItems.reduce((sum, item) => sum + item.quantity, 0),
      collection_date: detail.dateLine,
      fee: detail.feeLine,
      disposal_location: detail.locationLine || env.defaultDisposalLocation,
      reception_number: detail.receptionLine,
      notes: "最終確認の検証を通過後に自動確定しました。",
    });

    console.log("予約結果を reservation-result.json に保存しました。");
  } finally {
    if (traceStarted && !traceExported && context) {
      await ensureDir(TRACE_DIR);
      await context.tracing.stop({ path: TRACE_PATH }).catch(() => {});
      traceExported = true;
    }
    await rl.close();
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

main().catch(async (error) => {
  if (error && error.message) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  if (globalThis.__currentPageForDebug) {
    const visibleText = await getVisibleText(globalThis.__currentPageForDebug).catch(() => "");
    const hints = inferCauseFromDebug(error?.message || "", "", visibleText);
    if (hints.length > 0) {
      console.error(`原因候補: ${hints.join(" / ")}`);
    }
  }
  process.exitCode = 1;
});
