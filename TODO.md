# TODO

## High Priority

- Keep `data/koto-items.json` regenerated from the official Koto City PDF master via `npm run update-items`.
- Move item interpretation entirely into the Codex wrapper so `reserve-koto-sodai.js` only receives canonical master names.
- Keep `resolve-item.js` as a local test harness only; do not move canonicalization logic into `reserve-koto-sodai.js`.
- Use `resolve-item.js` only to validate wrapper-side canonicalization before reservation runs.
- Verify the final completion state end-to-end against the live site, including the completion page or explicit receipt response.
- Keep the collection-date picker logic under watch in case the site changes its calendar markup again.

## Medium Priority

- Add explicit logging of the completion page URL/title before writing `reservation-result.json` success.
- Revisit the disposal-location selection logic if the site introduces a new apartment-specific branch.
- Keep the item-selection path strict: no fuzzy matching on the reservation site, only exact master-name candidates.

## Low Priority

- Add a small self-check or dry-run summary that reports the current page title and URL at each major step.
- Trim any remaining overly broad selector heuristics that are no longer needed.
- Document `.koto-session.json` only if the reuse flow changes again.
