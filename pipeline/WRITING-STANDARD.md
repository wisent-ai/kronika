# Kronika writing standard

How every plan and every generated documentation page must be written.
Derived by reading exactly two bodies of evidence, cited throughout:

1. **The 50-reference evidence set** — `spis/documentation-site-examples/`
   (50 complete first-answer journey records; synthesis:
   `full-reference.md`). Referred to below as **[50ref]**.
2. **Our own previous documentation** — the restored human-written corpus
   (77 pages, February 2026), live at `ster.wisent.com/docs`, source
   `ster-landing@bb9a0ec src/app/docs/**`. Referred to below as
   **[corpus]**.

The machine-checked contract (page kinds, claim evidence, drift against
the binary) lives in `schemas/plan.schema.json` and the validators; this
document adds the writing rules those checks cannot see.

## 1. Pages and their jobs

- One page has one job: overview sells nothing and explains scope;
  quick start ends in one observable result; task guides are named by
  the reader's task; concept pages define terms once, for reuse;
  reference pages are uniform lookup tables. [corpus]
- A term used across pages is defined on its own concept page before
  other pages rely on it. Never reuse a word with a private meaning.
  [guidelines terms rule; the "fleet" defect]
- Reference entries are interchangeable in shape: same section order,
  same argument-table format, same example placement. [corpus CLI
  reference]

## 2. Anatomy of a page

- One h1 stating the subject; a one-paragraph lede stating the outcome
  the reader gets. [corpus]
- h2 sections separated by hairlines; every heading anchorable.
  [50ref rule 5: completion must end in addressable content]
- Code before the prose that discusses it; paste-ready commands, never
  pseudo-commands. [corpus quick-start]
- Enumerable facts (flags, defaults, error codes, limits) go in tables
  with real values — a limit without its number does not exist.
  [corpus limits page]
- Callouts carry warnings and tips only; steps are imperative, one
  action each. [corpus]
- A page with six or more h2 sections opens with an in-page table of
  contents right after the lede. [full-text crawl: "in this article"
  blocks near-universal on giants' long pages]
  [50ref rule 5: completion must end in addressable content]
- The HTML `<title>` reads "<Page> — <Product> documentation"; the
  breadcrumb stays unbranded. [full-text crawl title branding across
  Grafana, Elastic, Firebase, MDN]
- Security statements live on the page of the surface they concern.
  [corpus]

## 3. First-answer behavior [50ref]

- Keep product identity and docs scope visible where the reader landed;
  never strand a lookup away from its origin. [50ref rule 1]
- An empty result is a visible state, not silence or an unchanged page.
  [50ref rule 3]
- Recovery replaces the failed query; it never restarts the journey.
  [50ref rule 4]
- Success is a changed, title-bearing, shareable URL — not a highlight.
  [50ref rule 5]
- Critical state may never live only in motion or animation. [50ref
  rule 6]
- Support both transient-search and route-based navigation styles; do
  not assume one timing model. [50ref disagreements]

## 4. Voice

- Titles of guides and concepts state outcomes ("One queue, one
  registry, one answer."); reference titles are plain noun phrases of
  the surface documented. [corpus]
- Sections run general to specific; one reader level per page.
  [corpus]
- No marketing register anywhere: no superlatives, no hype, no claims
  about being fastest or best. Docs are not the landing page. [guidelines]
- Steps are imperative and singular; warnings live in callouts.
  [corpus]

## 5. Honesty

- Every sentence traces to repository truth: README, code, binary help,
  observed output. If a fact cannot be shown, it is not written.
  [guidelines §5]
- Removed or changed behavior always names its replacement and the
  command to run instead. [corpus migration page]
- Optional material (FAQ, roadmap, contributing) exists only with
  sourced content behind every entry; otherwise it is omitted.
  [guidelines optional-kinds rule]

## 6. Never

- No "Boundaries" page or any euphemism for one — the docs say what the
  product does. [operator decision 2026-08-19]
- No invented commands, flags, routes, keys, error codes, or page
  conventions; anything not in the schema or the binary fails the build.
  [validators]
- No second shell, palette, or section anatomy beside
  `DocumentationLayout`. [guidelines §6]
