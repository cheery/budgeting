# AGENTS.md

Notes for anyone (human or AI) working on this repo. See README.md for what the app does.

## Basics

- **`main` is deployed** by GitHub Pages to https://cheery.github.io/budgeting/. Every push to
  `main` goes live, so run `npm test` before pushing.
- Static PWA, no build step. Plain ES modules: `index.html` loads `app.js`.
- Run: `npm start` (serves on :8000). Test: `npm test` (Node's built-in runner).
- `core.js` must stay DOM-free so it can be tested in Node. Put logic there and keep UI in `app.js`.
- There is no Flutter or Android SDK on the dev machine. That's why this is a PWA.
- **Workflow:** the owner pushes. Agents commit only when asked, and never push.

## Things learned the hard way

- **The text format has no inline comments.** `#` only starts a comment at the beginning of a line.
  A trailing `# note` on a `plan` line is a parse error.
- **Sync merge depends on "one fact per line".** `merge()` does a multiset 3-way merge over
  canonical (serialized) lines. Any format change must keep each fact on its own line, and
  serialization must stay deterministic. Otherwise merges will duplicate or lose data.
- **No common base means union, not sum.** For the first sync or an import, call `merge(null, …)`,
  which takes the max count per line. Passing `''` as the base would double every shared transaction.
- **Editing through the UI re-serializes the file**, so hand-written comments are dropped. That's
  accepted behaviour; the Text tab keeps the raw text until the next UI edit.
- **"Certain" categories make future months look real.** `monthStats` counts the planned amount
  as actual for certain categories, including future months. Any "actual" display in the year
  view (net row, cumulative row, chart) must blank future months. This bug came up twice.
- **Re-rendering kills focus.** `render()` replaces `main.innerHTML` and restores focus through
  `data-focus` keys. In `change` handlers, use `commit({ deferRender: true })` so that Tab still
  moves to the next input before the re-render.
- **Bump `CACHE` in `sw.js`** (`budget-vN`) in every commit that changes a shell file (html/css/js/
  manifest/icons). Otherwise installed apps keep the old code. Pre-caching uses `cache: 'reload'`
  because GitHub Pages sends `max-age=600`.
- Float sums: round money totals to cents (`Math.round(x * 100) / 100`).
- **Undo must not cross a sync merge.** The undo stack holds whole previous texts. `setText()` from
  Drive clears it, because restoring a pre-merge text would make the next sync delete the other
  device's changes. UI edits, Text-tab Apply and import are undoable.
- **Balances anchor the cumulative rows.** `runningBalance()` starts from the latest `balance`
  entry on or before each month (possibly in an earlier year), else from 0 on Jan 1. A mid-month
  balance already contains that month's earlier transactions (`txNetBefore`).
- **Never remove user data as a side effect.** For example, a category can't be deleted while any
  plan or transaction line uses it (`categoryUses`). Keep new destructive actions just as explicit.

## Languages (`i18n.js`)

- The UI is Finnish and English. **All user-visible text goes through `t('key')`**, including
  titles, placeholders, aria-labels, confirm/alert dialogs, and the sync button. A test enforces
  that both languages have the same keys.
- Errors from `core.js`/`drive.js` carry `key` + `args` and are shown with `errorText()`. When you
  add a new error, add an `err.<key>` translation too.
- The **file format stays English** (`category`, `plan`, `income`, …) so the same `budget.txt` works
  in every language. Never translate keywords in `core.js`.
- Formatting uses `LOCALE[lang]` (fi-FI / en-GB). Until the user picks a language, it follows the browser.

## Training mode (`learn.js`)

- Every lesson and every `UI` string exists in both `fi` and `en`. A test enforces matching keys
  and tips, so add both languages together.
- The core message comes from the user's own finance advisor: a budget lets you know in advance
  whether problems are coming, it increases control over your life, and it makes money a
  resource. Keep the lessons built around these ideas, warm and non-judgmental.
- Lessons refer to UI labels with `{i18n.key}` placeholders (e.g. `{tab.year}`), never with
  hard-coded label text, so they always match what the UI shows.
- Learning progress is stored per device in localStorage (`budget.learn`), never in `budget.txt`.

## Data and privacy

- Never commit a real `budget.txt`. It's gitignored. The only exception is `examples/budget.txt`,
  which is imaginary sample data and must stay labelled as such.
- Screenshots in `docs/screenshots/` come from the sample data and carry an
  "Imaginary sample data" banner. Keep it that way when regenerating them.

## UI checks / screenshots

- Playwright's bundled browser download may not match the installed version. Reuse the existing
  Chromium with `chromium.launch({ executablePath: '~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome' })`
  (expand `~`). Install Playwright in a scratch directory, not in this repo.
- Check both desktop (~1100px) and phone (390px) widths. Phone layouts break first
  (the category list and the year grid).
- Seed data with `context.addInitScript` (set `budget.text` in localStorage). Set
  `budget.learn` to `{"dismissed":true}` to hide the training banner.
- To test Finnish, create the context with `locale: 'fi-FI'`. To catch untranslated text, scan
  `innerText` plus `title`/`placeholder`/`aria-label` for English UI words, after removing user
  data (category names, notes, the textarea). Finnish labels are longer, so check phone widths in
  Finnish too.
- The README screenshots are English and predate the language selector. Regenerate them (with the
  banner) after visible UI changes.

## Sync status

- Google Drive sync has been tested by the owner against the real API (Nov 2026) and works.
  Re-test it by hand after changing `drive.js` or the merge, because there are no automated tests
  against Drive.
