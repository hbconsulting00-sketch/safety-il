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

## Architecture

This is a **single-file frontend + thin Node proxy** app. Almost all logic lives in `public/index.html`.

- **`server.js`** — Express server with two routes:
  - `POST /api/chat` — proxies to Anthropic Claude API (`claude-haiku-4-5-20251001`). Receives `{ messages, system, max_tokens }`, returns `{ text }`.
  - `POST /api/upload` — multer file upload, reads `.txt` files into text, stubs others.
  - Serves `public/` as static files.

- **`public/index.html`** — everything else: CSS, HTML, and all JS in one `<script>` block. RTL Hebrew UI. Font: Rubik (replaces Heebo) + Frank Ruhl Libre for logo/headers.

## Frontend structure (index.html)

**Layout order (top → bottom):**
```
#header → #role-bar → #toolbar → #error-banner → #layout(#sidebar | #main)
```
`#main` contains: `#messages` → `#quick-row` → `#input-bar` → `#disclaimer`

**Sidebar tabs** (`switchSidebarTab(tab, btn)`):
- `law` — static list of Israeli safety legislation (decorative, not a real doc store)
- `company` — uploaded company procedures (`#uploaded-docs-list`) + upload zone
- `history` — saved conversations rendered by `renderSidebarHistory()`

**Toolbar button groups** (logical order, RTL):
1. Conversation management: `✏️ שיחה חדשה` | `💾 שמור`
2. Export tools: `📋 רשימת תיוג` | `📄 PDF` | `📝 Word`
3. Share: `🔗 שתף`

**Key globals:**
- `currentRole` — one of: `עובד`, `מנהל עבודה`, `ממונה בטיחות`, `קבלן`
- `conversation` — array of `{role, content}` sent to the API
- `uploadedDocs` — array of uploaded file objects appended to user messages

**Prompt system:**
- `SYSTEM_PROMPT` — closed-system base prompt with strict guardrails:
  - Always respond in Hebrew only
  - Refuse off-topic questions with a fixed message
  - Answer only from the explicit list of Israeli safety regulations
  - Never invent section numbers — if uncertain, write "יש לבדוק בנוסח הרשמי"
  - Fixed fallback when regulation not found: "לא מצאתי הוראה ספציפית..."
  - Enforces HTML-only output with specific inline-style tags
- `ROLE_PROMPTS[currentRole]` — appended to `SYSTEM_PROMPT` per role. Each role gets a dramatically different response format:
  - `עובד` (worker): simple bullets, no citations, plain language
  - `מנהל עבודה` (manager): 3-section structured response
  - `ממונה בטיחות` (safety officer): full legal citations, section numbers
  - `קבלן` (contractor): focus on insurance, licenses, liability
- `CHECKLIST_SYSTEM` — requires the model to open with `<h2>` containing a **topic-specific** title (e.g. "רשימת תיוג לעבודה עם כלי ריתוך בחלל מוקף"), not a generic one.
- `CHECKLIST_PROMPTS[currentRole]` — role-specific checklist structure, used in `generateChecklist()`.

**Key functions:**
- `sendMessage()` — builds the messages array, calls `/api/chat`, renders HTML response into `.bubble.bot`
- `generateChecklist()` — calls `/api/chat` with checklist prompts, renders in modal, extracts `<h2>` to update modal title
- `whatsappChecklist()` — extracts plain text from checklist modal, strips emoji, opens `wa.me/?text=`
- `exportPDF()` — sets `#print-role`, `#print-date`, calls `window.print()`
- `exportWord()` — builds an Office-namespaced HTML blob, triggers download as `.doc`
- `newConversation()` — resets `conversation`, `uploadedDocs`, restores welcome screen
- `saveConversation()` — saves to `localStorage['safetyil_history']` (max 30 entries)
- `renderSidebarHistory()` / `restoreConversation(index)` — history lives in sidebar "שיחות" tab, not a modal
- `switchSidebarTab(tab, btn)` — switches sidebar panels, calls `renderSidebarHistory()` when tab is `history`
- `shareLink()` — compresses conversation with lz-string (CDN), encodes in `?s=` URL param
- On DOMContentLoaded: checks `?s=` param and restores a shared conversation

**`API_BASE`** is set dynamically: `''` in production (same-origin), `http://localhost:3000` when on localhost.

## Deployment

Deployed on Render (auto-deploys from GitHub `main` branch push).
Live URL: https://safety-il.onrender.com

The Anthropic API key is stored in Render → Environment as `ANTHROPIC_API_KEY`. The key belongs to the organization account, not a personal account.

## Key constraints

- The system prompt requires the model to return **HTML only** with specific inline styles. Do not change this to markdown — the frontend renders it directly with `innerHTML`.
- `SYSTEM_PROMPT` is a **closed system** — the model must not use general knowledge. Do not weaken the guardrails (Hebrew-only, refuse off-topic, no invented section numbers).
- The checklist `CHECKLIST_SYSTEM` requires `<h2>` as the first element with a topic-specific title — this drives both the modal header and the WhatsApp message title.
- The sidebar knowledge base list (Israeli safety legislation) is **static HTML** — it's decorative/informational, not connected to a real document store.
- Uploaded files: only `.txt` files are actually read; PDF/Word files receive a stub message.
- Mobile: sidebar is a fixed overlay (`right: -290px` → `right: 0`). On mobile, `openHistory()` opens the sidebar to the history tab; `restoreConversation()` closes it.
