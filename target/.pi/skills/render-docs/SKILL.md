---
name: render-docs
description: Use this skill whenever the user mentions feature docs, HTML rendering, documentation updates, publishing md files, or requests "render the docs" / "update feature docs" / "make X into HTML". Always invoke this skill after document-feature creates a new .md file. Output language is Korean; skill instructions are English.
---

# render-docs

Converts `docs/feat/*.md` to HTML — not by mechanical conversion, but by **reading the content and deciding which HTML patterns best serve the reader**.

## Usage

```
/render-docs
/render-docs adapt-oauth
```

Natural language triggers:
```
"render the docs"
"make adapt-oauth into HTML"
"update feature docs"
```

## ⚡ Core Editorial Principles (READ THIS FIRST)

These principles define the quality bar. Every HTML file must embody them.

### 1. Importance-first ordering
Never display content in the order it appears in the md. **Re-rank by impact.**
- Decision Log → sort by architectural impact (High → Medium → Low)
- Changed files → sort by scope of change (most lines changed first)
- Flow diagrams → primary flow first, edge/admin flows second

### 2. Progressive disclosure
The reader's first glance should reveal the 20% that matters most. Everything else is one click away.
- Core decisions, primary flow diagram → always visible
- Long lists, secondary flows, detailed diffs → collapsed by default
- Ask: "Would a new team member need this on first read?" If no → collapse it.

### 3. Density signal → pattern choice
| Signal | Pattern |
|--------|---------|
| 2+ independent diagrams | Tab |
| 6+ decision rows that cluster into categories | Accordion |
| 7+ list items, or secondary/background content | Toggle (collapsed) |
| Changed files section | Always toggle + git diff |
| Short, essential content | Flat — no toggle |

**Never force a pattern.** A 4-row Decision Log does not need an accordion. Three similar diagrams that are not independent do not need tabs. When in doubt, flat is safer than a toggle that hides critical information.

### 4. Diff presentation standards
Changed files are the most technically dense section. Make diffs readable:
- Show the **why** in the `diff-meta` line (one sentence, not the filename again)
- Add/delete counts in the summary badge
- For diffs > 150 lines: excerpt the most structurally significant hunks only, label as "(key excerpts)"
- Highlight paradigm shifts (N+1 → batch, DB lookup → ENUM, TODO → real implementation)
- Never escape `<` / `>` inside mermaid `<div class="mermaid">` blocks — mermaid requires raw characters

### 5. Consistency rules
- Dark theme: background `#0d1117`, surface `#161b22`, border `#30363d`
- Badge colors: High = red (`#f47067`), Medium = yellow (`#e3b341`), Low = green (`#3fb950`)
- Diff line colors: add = `#122d22` bg / `#aff5b4` text, del = `#2d1515` bg / `#ffc0c0` text
- Breadcrumb always links to `./index.html`
- `mermaid.initialize({ startOnLoad: true, theme: 'dark' })` always present
- Tab switching must call `mermaid.run()` on the newly active tab

---

## Process

### Step 1: Identify target files

- No argument: all `docs/feat/*.md` (excluding `INDEX.md`) where `docs/feat/html/{name}.html` is missing or older than the md.
- With argument: that specific md file only.

### Step 2: Read and analyze the md

Read the full file. For each section, decide:
- What is the reader trying to understand here?
- What pattern best serves that goal?
- Does any content deserve re-ordering or categorization that the md doesn't have?

Apply the **Core Editorial Principles** above. Write your pattern decisions down before generating HTML.

### Step 3: Collect git diffs for changed files

For each file listed in the "변경 범위" section:

1. Resolve the actual path (use the Grep tool if the md uses `...` abbreviation)
2. Get the diff:
   ```bash
   git diff origin/dev...HEAD -- {file_path}
   ```
   Fallback if empty:
   ```bash
   git show HEAD:{file_path} | head -80
   ```
3. Count `+` and `-` lines for the badge
4. If diff > 150 lines: select the 2-3 most structurally significant hunks

### Step 4: Generate HTML

Output: `docs/feat/html/{name}.html` (create `docs/feat/html/` if missing)

Required elements:
- Breadcrumb: `← Feature Docs` linking to `./index.html`
- All patterns from Step 2 applied
- All changed files as toggles with diffs from Step 3
- `mermaid.initialize({ startOnLoad: true, theme: 'dark' })` at end of body
- Tab JS that calls `mermaid.run()` on tab switch

HTML patterns reference:

**Toggle**
```html
<details>
  <summary>
    <div class="file-summary">
      <span class="file-name">FileName.java</span>
      <span class="badge badge-path">module/.../package</span>
      <div class="diff-stats">
        <span class="badge badge-add">+N</span>
        <span class="badge badge-del">-N</span>
      </div>
    </div>
  </summary>
  <div class="details-body" style="padding:0">
    <div class="diff-meta">One sentence: what changed and why</div>
    <div class="diff-container">
      <!-- .diff-line.diff-hunk / .diff-add / .diff-del rows -->
    </div>
  </div>
</details>
```

**Tab**
```html
<div class="tabs">
  <div class="tab-buttons">
    <button class="tab-btn active" data-tab="flow-0">Label A</button>
    <button class="tab-btn" data-tab="flow-1">Label B</button>
  </div>
  <div class="tab-content active" id="flow-0"><div class="mermaid">...</div></div>
  <div class="tab-content" id="flow-1"><div class="mermaid">...</div></div>
</div>
```

**Accordion (grouped toggles)**
```html
<details open>
  <summary><span class="badge badge-high">High</span> Category name (N)</summary>
  <div class="details-body"><table class="decision-table">...</table></div>
</details>
<details open>
  <summary><span class="badge badge-medium">Medium</span> Category name (N)</summary>
  ...
</details>
```

### Step 5: Update index.html

Edit `docs/feat/html/index.html` directly — add the new entry to the table, sorted newest-first.
Parse date and branch from the `> 작성일:` line in the md.

### Step 6: Report pattern decisions

```
docs/feat/html/{name}.html generated

Patterns applied:
- Flow Diagram ×2 → Tab (reason: two independent flows, Builder vs Admin)
- Decision Log 11 items → Accordion: High(3) / Medium(5) / Low(3)
- Changed files (6) → Toggle + git diff
  - OAuthScopeService.java: +47 -119 (key excerpts, paradigm shift: N+1→batch)
  - OAuthScopeInternalController.java: +34 -41
  - ...
```

## Notes

- Existing `.html` files are always overwritten
- Never modify the source `.md` files
- When a pattern choice is ambiguous, prefer flat over collapsed — hiding essential content is worse than a long page
- The validator gate (`validate-feat-html.js`) runs automatically on Write — if it exits 1, fix the reported issues before finishing
