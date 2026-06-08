# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```bash
npm install        # first time only
node server.js     # starts on http://localhost:3000
```

Requires a `.env` file with:
```
ANTHROPIC_API_KEY=sk-ant-...
```

PDF regulations are loaded automatically from any `.pdf` files placed in the project root. Requires `npm install pdf-parse mammoth` for parsing.

## Architecture

**Single-file frontend + thin Node proxy.** All UI logic lives in `public/index.html`. The server is a stateless Express proxy — it holds the regulation knowledge base in memory but persists nothing to disk.

### server.js

- `POST /api/chat` — proxies to Anthropic `claude-sonnet-4-6`. Uses **prompt caching** (`anthropic-beta: prompt-caching-2024-07-31`) on the system block. Runs a **web search loop**: if `stop_reason === 'pause_turn'`, appends the assistant turn and re-calls (up to 5 iterations). The `web_search_20250305` tool is always included.
- `POST /api/upload` — multer upload; parses `.pdf` (pdf-parse), `.docx` (mammoth), `.txt`. Returns extracted text.
- `GET /api/regulation-pdfs` — lists loaded knowledge base docs `[{ name }]`.
- `GET /api/regulation-pdfs/:name` — serves the original PDF file for download.
- `GET /api/kb-status` — debug endpoint showing loaded docs and char counts.

**Knowledge base** (`knowledgeBase[]`): up to 10 regulation PDFs loaded at startup, capped at 8,000 chars each. `selectRelevantDocs(messages)` scores each doc by keyword match against the last 3 user messages and returns the top 3 — keeping requests under ~20K tokens to stay within the 30K TPM rate limit.

### public/index.html

Everything else: CSS, HTML, all JS in one `<script>` block. RTL Hebrew UI. Fonts: Rubik + Frank Ruhl Libre.

**Layout:**
```
#header → #role-bar → #toolbar → #error-banner → #layout(#sidebar | #main)
```

**Sidebar tabs** (`switchSidebarTab(tab, btn)`):
- `law` — dynamically populated from `/api/regulation-pdfs` via `renderRegulationSidebar()`. Each item has a 📥 download button.
- `company` — uploaded company procedures (`renderUploadedDocs()`), each with 📥 extract download + ✕ remove.
- `history` — saved conversations (`renderSidebarHistory()`), localStorage key `safetyil_history`.
- `checklists` — saved checklists (`renderSavedChecklists()`), localStorage key `safetyil_checklists`.

**Key globals:**
- `currentRole` — `עובד` | `מנהל עבודה` | `ממונה בטיחות` | `קבלן`
- `conversation` — `{role, content}[]` sent to the API (last 8 messages)
- `uploadedDocs` — uploaded file objects appended to system prompt
- `regulationFiles` — list from `/api/regulation-pdfs`, populated on load
- `currentChecklistData` — `{ title, sections, allItems }` for the currently open interactive checklist

**Prompt system:**
- `SYSTEM_PROMPT` — closed-system: Hebrew-only, refuse off-topic, answer only from the regulation knowledge base, never invent section numbers, HTML-only output with specific inline-style tags.
- `ROLE_PROMPTS[currentRole]` — dramatically different format per role (worker: plain bullets; manager: 3-section; safety officer: full citations; contractor: insurance/liability focus).
- `CHECKLIST_SYSTEM` — requires `<h2>` as first element with a topic-specific title; structured `<h3>` + `<ul><li>` output.
- `CHECKLIST_PROMPTS[currentRole]` — role-specific checklist structure.

**Interactive checklist flow:**
1. `generateChecklist()` calls the API → gets HTML with `<h3>` sections + `<li>` items.
2. `parseChecklistStructure(html)` extracts `{ title, sections[], allItems[] }` from the HTML (uses DOM parsing, not regex).
3. `buildInteractiveChecklistHtml(structure)` renders `.cl-item` divs with `data-state="0"` and `onclick="cycleCheckState(this)"`.
4. States: 0=☐, 1=✅, 2=❌, cycling on click.
5. `saveChecklist()` — saves title + items + states to `safetyil_checklists` localStorage (max 50).
6. `whatsappChecklist()` — encodes items as `?cl=<lz-string-JSON>` URL and sends the link via `wa.me`.
7. `openChecklistFromUrl(data)` — called on `DOMContentLoaded` when `?cl=` param is present; opens the modal with restored items.
8. `printChecklist()` / `printBlankChecklist()` — build an iframe with current states / all-☐ and trigger `print()`.

**URL params (both handled in DOMContentLoaded):**
- `?s=` — shared conversation (lz-string compressed JSON with `conversation` + `messagesHtml`)
- `?cl=` — shared interactive checklist (lz-string compressed JSON with `title`, `role`, `date`, `items[]`)

## Deployment

Render, auto-deploys from GitHub `main` push.
Live URL: https://safety-il.onrender.com

`ANTHROPIC_API_KEY` is set in Render → Environment (org account key).

## Key constraints

- The system prompt enforces **HTML-only output** with specific inline styles. Do not switch to markdown — the frontend renders via `innerHTML`. `sanitizeHtml()` strips `<script>`, `<style>`, and all `on*=` attributes from Claude's responses before rendering.
- `SYSTEM_PROMPT` is a **closed system** — never weaken the guardrails (Hebrew-only, off-topic refusal, no invented section numbers).
- `CHECKLIST_SYSTEM` must produce `<h2>` as first element — this drives the modal title and the WhatsApp message header. `parseChecklistStructure` depends on `<h3>` + `<li>` structure from the model output.
- The interactive checklist items are built by the client (not from Claude's HTML directly), so they are NOT passed through `sanitizeHtml` — they are safe because item text comes from `textContent` extraction.
- Rate limit: 30K input tokens/minute. Each request uses ~15–20K tokens (3 selected docs × 8K chars + system prompt). Do not increase `selectRelevantDocs` to more than 3 docs or raise the per-doc char cap without testing.
- Render has **ephemeral disk** — the knowledge base PDFs must be committed to the repo for them to survive deploys.
