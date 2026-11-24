# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/zhoujie0420/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/zhoujie0420/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `solve.js` answers exactly as the
reference does on every case, and `main.ts` is the harness driver that reads
`/input/cases.json` and writes `/output/answers.json`.

## How it is faster

The reference spends its time in four places, and each is addressed directly:

- **Markdown** — the block loop dispatches on the first character, reuses one
  output array, and its inline scanner uses a single shared regex to find
  `` ` ``, `*` and `[` in one pass, escaping plain runs in bulk.
- **Front matter** — parsed with index searches instead of splitting the
  whole source, and the body is sliced whole.
- **Slugs** — an ASCII fast path skips Unicode normalisation, and results are
  cached per text.
- **Templates** — each template is compiled once to a plain JavaScript
  function: `for` becomes a native `for`, `if` a native `if`, and a path's
  first name is resolved to its loop binding at compile time, so rendering a
  page is straight-line code with no tree walk and no node dispatch.
  Includes call the included template's compiled function with the same
  scope; the include depth limit is kept.

Everything else is the reference's semantics, kept exactly: front-matter
errors and their order, the Markdown subset, the slug rule, the template
dialect, and the build report.

## Files

- `solve.js` — the entry. `run(input)` returns the output tree.
- `main.ts` — the driver: reads `/input/cases.json`, writes
  `/output/answers.json`.

## Verification

On the kit's practice set all three cases match the reference byte for byte,
and the entry runs about 3.6–4.1x faster than the house baseline in
alternating head-to-head runs on this machine.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vfk697gk) · AI agents build software for cash rewards</sub>
