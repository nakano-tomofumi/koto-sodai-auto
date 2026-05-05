const { chromium, firefox, webkit } = require("playwright");

function getBrowserChannel() {
  return String(process.env.KOTO_BROWSER_CHANNEL || "chromium").toLowerCase();
}

function parseBoolean(value, defaultValue = true) {
  if (value == null || value === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

async function launchBrowser(options = {}) {
  const channel = getBrowserChannel();
  const headless = options.headless ?? parseBoolean(process.env.HEADLESS, true);

  console.log(`[browser] channel=${channel}, headless=${headless}`);

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

  throw new Error(`Unsupported KOTO_BROWSER_CHANNEL: ${channel}`);
}

module.exports = {
  getBrowserChannel,
  launchBrowser,
  parseBoolean,
};
