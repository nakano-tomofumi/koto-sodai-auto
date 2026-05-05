#!/usr/bin/env node

const path = require("path");
const localBrowserPath = path.resolve(__dirname, ".playwright-browsers");
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowserPath;
}

const dotenv = require("dotenv");
const { chromium, firefox, webkit } = require("playwright");

dotenv.config();

const cases = [
  { channel: "chromium", headless: true },
  { channel: "chrome", headless: true },
  { channel: "firefox", headless: true },
  { channel: "webkit", headless: true },
  { channel: "chrome", headless: false },
  { channel: "chromium", headless: false },
];

function launchByCase(testCase) {
  const { channel, headless } = testCase;

  if (channel === "chrome") {
    return chromium.launch({ channel: "chrome", headless });
  }

  if (channel === "msedge") {
    return chromium.launch({ channel: "msedge", headless });
  }

  if (channel === "chromium") {
    return chromium.launch({ headless });
  }

  if (channel === "firefox") {
    return firefox.launch({ headless });
  }

  if (channel === "webkit") {
    return webkit.launch({ headless });
  }

  throw new Error(`Unsupported channel: ${channel}`);
}

async function runCase(testCase) {
  const label = `${testCase.channel} / headless=${testCase.headless}`;
  console.log(`\n=== Testing ${label} ===`);

  let browser;
  try {
    browser = await launchByCase(testCase);
    const page = await browser.newPage();
    await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
    const title = await page.title();
    console.log(`OK: ${label}: ${title}`);
    await browser.close();
    return { ...testCase, ok: true, title };
  } catch (error) {
    console.error(`NG: ${label}`);
    console.error(error && error.message ? error.message : error);
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    return { ...testCase, ok: false, error: String(error && error.message ? error.message : error) };
  }
}

async function main() {
  const results = [];
  for (const testCase of cases) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runCase(testCase));
  }

  console.log("\n=== Browser smoke test result ===");
  for (const result of results) {
    console.log(`${result.ok ? "OK" : "NG"} ${result.channel} headless=${result.headless}`);
  }

  const firstOk = results.find((result) => result.ok);
  if (firstOk) {
    console.log("\nRecommended .env:");
    console.log(`KOTO_BROWSER_CHANNEL="${firstOk.channel}"`);
    console.log(`HEADLESS="${firstOk.headless}"`);
    return;
  }

  console.log("\nNo browser configuration worked.");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
