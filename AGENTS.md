# AGENTS.md

## Project

This repository automates the Tokyo Koto City oversized garbage reservation flow.

The goal is to create and maintain a semi-automatic reservation script that helps the user reserve disposal of oversized garbage through the Koto City online application site.

The script should normally complete the reservation, but it must stop and ask the user through CLI when the site shows ambiguous choices, unexpected errors, CAPTCHA, or anything that could cause an incorrect reservation.

## Language

- User-facing messages should be in Japanese.
- Code comments can be in English or Japanese.
- Variable names and file names should be in English.

## Main Goal

Implement and maintain a Node.js + Playwright script for Koto City oversized garbage reservations.

The script should:

1. Start the application flow.
2. Handle the email authentication step by asking the user to paste the authentication URL from the received email.
3. Ask the user each time what item should be disposed of.
4. Ask the user each time how many items should be disposed of.
5. Resolve the requested item to a single canonical item name from `data/koto-items.json` before reservation.
6. Select the item on the reservation site only by exact match against the resolved canonical item name.
7. Stop safely if the canonical item cannot be resolved uniquely or the site does not show an exact match.
8. Use the earliest available collection date.
9. Use the default disposal location: 集合住宅の粗大ごみ置き場
10. If multiple disposal-location choices are shown, ask the user to choose through CLI.
11. Fill applicant information from `.env`.
12. Validate the final confirmation screen.
13. Complete the reservation only if validation passes.
14. Save the result to `reservation-result.json`.

## Bootstrap Policy

When Codex starts, first inspect `AGENTS.md`, `README.md`, `package.json`, `.env.example`, and the current repository state.

Codex may run `npm install`,
`npx playwright install chromium`,
`node test-browser.js`,
`node update-items.js`,
and `node reserve-koto-sodai.js` as needed.

Do not push the user toward manual setup steps when Codex can progress safely within the repository context.

If `.env` does not exist, create it from `.env.example` and ask the user only for the personal information that cannot be inferred. Do not guess any personal information.

Before executing the reservation flow, confirm `.env`, the browser smoke test, `data/koto-items.json`, and canonical item resolution.

On macOS, prefer `KOTO_BROWSER_CHANNEL=chromium` and `HEADLESS=true`.

Do not commit `.env`, debug artifacts, screenshots, Playwright traces, local session files, or `reservation-result.json`.

## Current Implementation Constraints

The script is already partially implemented and should be evolved rather than rewritten.

Important current behaviors:

- Authentication URLs may be reused from a local session file when the user permits it.
- Multiple items can be entered in one run.
- `data/koto-items.json` is the official item master generated from Koto City PDFs and is the source of truth for canonical item names, fees, notes, and A/B ticket counts.
- `update-items.js` is the regeneration tool for that master. It downloads the official PDFs, extracts text, writes `data/koto-items.json`, and stores a debug transcript in `data/koto-items.debug.txt`.
- The Codex wrapper must resolve user language into canonical master item names before `reserve-koto-sodai.js` runs. The script must not do fuzzy interpretation itself.
- `resolve-item.js` is only a local harness for testing the wrapper-side decision. It does not change the reservation script's responsibility.
- Prefer passing pre-resolved items via `KOTO_RESOLVED_ITEMS_JSON` when the wrapper has already decided canonical names, quantities, and optionally site categories.
- `reserve-koto-sodai.js` must treat the official master as a strict allowlist. If the requested canonical item does not exist in `data/koto-items.json`, stop rather than guessing.
- Reservation-site item selection must use only exact matches against the canonical master item name. If the site does not show an exact match, stop safely and ask the user or wrapper to intervene.
- Applicant information must be filled by explicit field names whenever possible.
- Do not use broad "nearest input" fallbacks for applicant data; they can misplace values into the wrong field.
- Collection-date handling should wait for the actual collection page URL and/or `pc_date` / `sp_date` fields before attempting to pick the earliest date.
- Disposal-location selection must remain consistent with the user's preferred default and should not be selected twice or in the wrong order.
- The confirmation page has been verified against the live site and shows applicant data, collection date, and item totals in table/text form.
- The final submit path must still confirm that the completion page or completion response is present before treating the run as a real success.
- `KOTO_BUILDING` may contain a hyphenated building/room suffix such as `3-101`, which should be split into `3号棟` and `101号室`.

## Browser Launch Policy

Chrome for Testing may crash on macOS before page automation starts.

Do not assume a page script or selector caused the failure when the crash report shows `Google Chrome for Testing`, `EXC_CRASH(SIGABRT)`, or `abort() called` at launch time.

Browser launch must be configurable through `.env`.

Supported variable:

- `KOTO_BROWSER_CHANNEL`

Allowed values:

- `chrome`
- `msedge`
- `chromium`
- `firefox`
- `webkit`

Default should be `chrome`.

For macOS smoke testing and initial reservation runs, prefer headless mode first and keep headed mode for the last resort.

Prefer the user's installed Google Chrome over Playwright's bundled Chromium / Chrome for Testing when Chrome for Testing crashes.

Before debugging reservation logic, run a minimal browser launch test such as opening `https://example.com`.

Only proceed to reservation automation after the selected browser can launch reliably.

## Browser Crash Handling Policy

If the crash report shows Google Chrome or Google Chrome for Testing crashing with `EXC_CRASH(SIGABRT)` / `abort() called` around AppKit, HIServices, or `_RegisterApplication`, do not treat it as a page automation or selector problem.

This means the browser process itself failed during startup.

When this happens:

1. Run `node test-browser.js`.
2. Prefer headless browser modes first.
3. Do not default to `headless=false`.
4. Use the first browser configuration that can open `https://example.com`.
5. Continue reservation automation only after the browser smoke test passes.
6. If headed mode is unavailable, rely on debug screenshots, HTML snapshots, and Playwright trace.

Default browser settings on macOS should be:

```env
KOTO_BROWSER_CHANNEL="chromium"
HEADLESS="true"
```

## Important Safety Rules

The script may complete the reservation, but it must not blindly click the final submit button.

Before final submission, it must verify:

- Applicant name matches `KOTO_NAME`
- Email address matches `KOTO_EMAIL`
- Address appears to match `KOTO_ADDRESS`
- Official item name matches the resolved canonical item name
- The selected site item exactly matches the canonical item name
- Item name is not empty
- Quantity is correct
- Collection date is selected
- Fee is shown
- The reservation is for the item and quantity requested by the user
- There are no unexpected extra items
- There is no warning or error message on the confirmation page

If any validation fails, stop before final submission and print the reason.

## Stop Conditions

Stop and ask the user, or abort safely, in any of these cases:

- CAPTCHA or image authentication appears
- Email authentication URL is not available
- The page structure is different from expected
- The user's requested item cannot be resolved to exactly one canonical item before reservation
- The requested canonical item does not exist in `data/koto-items.json`
- The reservation site does not show an exact match for the resolved canonical item name
- The selected item does not exactly match the resolved canonical item name
- Disposal location is ambiguous
- Address candidates are ambiguous
- Earliest date cannot be determined
- Fee is missing or looks abnormal
- The final confirmation screen cannot be parsed
- The site shows an error
- The reservation site is under maintenance
- Any personal information appears incorrect

## Personal Information

Never hard-code personal information in source code.

Read personal information from `.env`.

Expected variables:

- `KOTO_NAME`
- `KOTO_NAME_KANA`
- `KOTO_POSTAL_CODE`
- `KOTO_ADDRESS`
- `KOTO_BUILDING`
- `KOTO_PHONE`
- `KOTO_EMAIL`
- `KOTO_DEFAULT_DISPOSAL_LOCATION`
- `HEADLESS`

Do not commit `.env`.
Do not commit `reservation-result.json`.
Debug artifacts may contain personal information; keep `debug/` untracked.

Use `.env.example` as the template.

Optional local state:

- A local session cache may be used to reuse the most recent authentication URL.
- Any local session cache must remain untracked and must not contain personal information beyond what is needed for the workflow.

## Git Rules

This repository may be pushed to a private GitHub repository.

Never commit:

- `.env`
- `reservation-result.json`
- reservation results containing personal information
- screenshots containing personal information
- browser profiles
- cookies
- session files
- logs containing personal information

Keep `.gitignore` updated.

## Technology

Use:

- Node.js
- Playwright
- dotenv
- readline/promises or equivalent for CLI input

Prefer Playwright over Selenium unless there is a strong reason to switch.

Run with:

```bash
node update-items.js
node reserve-koto-sodai.js
```

Optional:

```bash
node resolve-item.js
```

Use `headless=false` by default so the user can observe the browser.

## CLI Behavior

At runtime, ask:

1. 粗大ごみの品目名を入力してください
2. 数量を入力してください
3. 確認メールに記載された認証URLを貼り付けてください

If a requested item must be resolved before reservation, that decision happens in the Codex wrapper. `resolve-item.js` is only a local harness for checking that wrapper-side decision. The reservation script should only receive the finalized canonical item. Do not fuzzy-pick a site item from reservation-site search results.

```text
候補が複数見つかりました。
1. いす
2. 回転いす
3. 座いす
番号を選択してください:
```

If disposal-location candidates are found, display them like:

```text
収集場所の候補が複数見つかりました。
1. 集合住宅の粗大ごみ置き場
2. 玄関前
3. その他
番号を選択してください:
```

Default preferred disposal location:

```text
集合住宅の粗大ごみ置き場
```

## Result File

After successful reservation, write `reservation-result.json`.

It should contain:

```json
{
  "status": "success",
  "reserved_at": "ISO-8601 datetime",
  "requested_item": "...",
  "official_item_name": "...",
  "item": "...",
  "quantity": 1,
  "collection_date": "...",
  "fee": "...",
  "disposal_location": "...",
  "reception_number": "...",
  "notes": "..."
}
```

If the reservation is not completed, write:

```json
{
  "status": "stopped",
  "stopped_at": "ISO-8601 datetime",
  "reason": "...",
  "last_known_step": "..."
}
```

## Implementation Notes

Use robust selectors.

Prefer:

* role selectors
* label selectors
* text selectors
* placeholder selectors

Avoid brittle CSS selectors unless necessary.

Add small helper functions for:

* waiting for page navigation
* clicking by text
* filling by label
* selecting earliest date
* extracting confirmation details
* validating final confirmation
* saving JSON results
* asking CLI questions

Log important steps, but do not log sensitive personal information more than necessary.

## Dry Run Mode

If practical, support a dry-run option:

```bash
node reserve-koto-sodai.js --dry-run
```

In dry-run mode, proceed to the final confirmation screen but do not complete the reservation.

Default behavior may complete the reservation after validation.

## Debugging

When the flow stops unexpectedly, inspect the current URL, title, and visible form field names before changing selectors.

Prefer tightening selectors around explicit `name` attributes or page-specific labels instead of adding broader heuristics.

If the user reports that values are being written into the wrong textbox, remove the broad fallback immediately and replace it with field-name-based input.

When the confirmation screen looks complete but the reservation may still not be committed, check for the completion page, receipt number, or explicit completion message before writing a success result.

Store step-by-step debug artifacts under `debug/` and failure bundles under `debug/error-YYYYMMDD-HHMMSS/`.
Always save the latest Playwright trace to `debug/traces/trace.zip` on failure so it can be opened with `npx playwright show-trace debug/traces/trace.zip`.
Inspect the saved artifacts first before adding new ad-hoc observation code.

## Debugging Policy

Do not debug by repeatedly adding ad-hoc observation code after each failure.

From the beginning, implement a reusable observation layer.

At each major step, save:

- current URL
- page title
- screenshot
- full HTML
- visible text summary
- list of visible buttons
- list of visible links
- list of visible input fields
- list of visible select boxes

Save these files under `debug/`.

On failure, save a timestamped debug bundle under:

`debug/error-YYYYMMDD-HHMMSS/`

Also enable Playwright tracing.

Before changing the automation logic after a failure, inspect the saved debug artifacts first.

Only add new observation code if the existing artifacts are insufficient.

## Current User Preference

* Email authentication URL can be pasted manually.
* Item type should be asked every time.
* Quantity should be asked every time.
* Preferred disposal location is: 集合住宅の粗大ごみ置き場
* The user wants the earliest available collection date.
* The user wants the script to complete the reservation when validation passes.
