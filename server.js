require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// File upload setup
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Load optional libraries gracefully
let pdfParse = null;
let mammoth = null;
try { pdfParse = require('pdf-parse'); } catch(e) { console.log('pdf-parse not installed'); }
try { mammoth = require('mammoth'); } catch(e) { console.log('mammoth not installed'); }

// ── REGULATION KNOWLEDGE BASE ──
// Loaded once on startup from PDF files in project root.
// Passed to every chat request via Anthropic prompt caching.
const knowledgeBase = [];

function cleanPdfText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\f/g, '\n')          // form feeds
    .replace(/[ \t]+/g, ' ')       // multiple spaces
    .replace(/\n{4,}/g, '\n\n\n')  // max 3 consecutive newlines
    .trim();
}

async function loadRegulationPDFs() {
  if (!pdfParse) {
    console.log('⚠️  pdf-parse not available — install with: npm install pdf-parse');
    return;
  }

  const pdfFiles = fs.readdirSync(__dirname)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .sort();

  if (!pdfFiles.length) {
    console.log('ℹ️  No PDF files found in project root');
    return;
  }

  console.log(`\n📚 Loading ${pdfFiles.length} regulation PDFs into knowledge base...`);

  for (const file of pdfFiles) {
    try {
      const buffer = fs.readFileSync(path.join(__dirname, file));
      const result = await pdfParse(buffer);
      // 8000 chars per doc (~4,800 tokens) keeps 3 selected docs under 30K TPM
      const text = cleanPdfText(result.text).substring(0, 8000);

      if (text.trim().length > 100) {
        const name = file
          .replace(/\.pdf$/i, '')
          .replace(/[-_]/g, ' ')
          .trim();
        knowledgeBase.push({ name, text });
        console.log(`  ✅  ${file} (${text.length.toLocaleString()} chars)`);
      } else {
        console.log(`  ⚠️  ${file} — could not extract text (scanned PDF?)`);
      }
    } catch(e) {
      console.log(`  ❌  ${file}: ${e.message}`);
    }
  }

  const totalChars = knowledgeBase.reduce((s, d) => s + d.text.length, 0);
  console.log(`\n✅  Knowledge base ready: ${knowledgeBase.length}/${pdfFiles.length} regulations (${Math.round(totalChars/1000)}K chars)\n`);
}

// ── SMART DOCUMENT SELECTION ──
// Maps Hebrew keywords to partial doc name matches.
// Each request selects only the 2-3 most relevant docs (~15K tokens total).
const TOPIC_KEYWORDS = [
  { keywords: ['גובה','נפילה','פיגום','סולם','חגורת','גג','מרפסת','ארובה','עמוד'], topic: 'גובה' },
  { keywords: ['בניה','בנייה','אתר בנ','חפירה','שרטוט','דיפון','מנהור','שלד'], topic: 'בניה' },
  { keywords: ['חומר מסוכן','חומרים מסוכנ','כימי','רעיל','נפץ','חומצה','מסוכן','סולן','בנזן'], topic: 'hazardous' },
  { keywords: ['חשמל','מתח','חשמלי','כבל','לוח חשמל','שנאי','מפסק','גנרטור'], topic: 'חשמל' },
  { keywords: ['ציוד מגן','קסדה','כפפות','נשמת','אוזניות','מגפיים','מגן פנים','אפוד'], topic: 'ציוד מגן' },
  { keywords: ['ממונה','פיקוח על','ביקורת בטיחות','מינוי ממונה'], topic: 'ממונים' },
  { keywords: ['עגורן','מלגזה','הרמה','מנוף','אתת','קרסים','ווים','טרקטור'], topic: 'עגורנאים' },
  { keywords: ['כיבוי','אש','שריפה','מטף','ספרינקלר','מוקד','פינוי'], topic: 'כבאות' },
  { keywords: ['ניטור','סביבתי','ביולוגי','גורמים מזיק','אבק','רעש','קרינה','גזים'], topic: 'ניטור' },
];

// The base law is always included as anchor
const BASE_DOC_KEYWORDS = ['פקודת', 'פקודה'];

function selectRelevantDocs(userMessages) {
  if (!knowledgeBase.length) return [];

  // Combine last 3 messages for context
  const text = userMessages.slice(-3)
    .filter(m => m.role === 'user')
    .map(m => (typeof m.content === 'string' ? m.content : ''))
    .join(' ')
    .toLowerCase();

  // Score each doc
  const scores = knowledgeBase.map(doc => {
    let score = 0;
    const docName = doc.name.toLowerCase();

    // Check if it's the base law (always gets a boost)
    if (BASE_DOC_KEYWORDS.some(k => docName.includes(k.toLowerCase()))) {
      score += 0.5; // slight boost, not forced to #1
    }

    for (const { keywords, topic } of TOPIC_KEYWORDS) {
      for (const kw of keywords) {
        if (text.includes(kw)) {
          // Check if this topic matches the doc
          if (docName.includes(topic.toLowerCase()) ||
              doc.text.substring(0, 200).toLowerCase().includes(topic.toLowerCase())) {
            score += 1;
          }
        }
      }
    }
    return { doc, score };
  });

  scores.sort((a, b) => b.score - a.score);

  // Return top 3 docs. If nothing matched (all score 0), return first 3 (includes base law)
  return scores.slice(0, 3).map(s => s.doc);
}

// Build knowledge block from a specific subset of docs
function buildKnowledgeBlock(docs) {
  const list = docs || knowledgeBase;
  if (!list.length) return '';
  const body = list.map(d => `### ${d.name}\n\n${d.text}`).join('\n\n---\n\n');
  const names = list.map(d => d.name).join(', ');
  return `\n\n## ===== בסיס ידע — נוסח התקנות הרשמי (טקסט מלא) =====\n\nמסמכים נבחרים לשאלה זו: ${names}\n\nהתשובות שלך חייבות להישען על הטקסטים הבאים בלבד. אם המידע אינו מופיע להלן — אמור זאת במפורש.\n\n${body}`;
}

// ── PROXY TO CLAUDE ──
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY לא מוגדר בקובץ .env' });
  }

  const { messages = [], system = '', max_tokens = 4000 } = req.body;

  if (!messages.length) {
    return res.status(400).json({ error: 'messages array is empty' });
  }

  // Select only the most relevant PDFs for this question (keeps tokens under 30K TPM)
  const selectedDocs = selectRelevantDocs(messages);
  const fullSystemText = system + buildKnowledgeBlock(selectedDocs);

  if (process.env.NODE_ENV !== 'production' && selectedDocs.length) {
    console.log(`📂 Selected docs: ${selectedDocs.map(d => d.name).join(' | ')}`);
  }

  // Use array format for system to enable Anthropic prompt caching.
  // The knowledge base text is large and static — caching saves ~90% on cost.
  const systemBlock = [
    {
      type: 'text',
      text: fullSystemText,
      cache_control: { type: 'ephemeral' }
    }
  ];

  const claudeBody = {
    model: 'claude-sonnet-4-6',
    max_tokens,
    system: systemBlock,
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify(claudeBody)
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const text = data.content?.[0]?.text || '';

    // Log cache stats in dev
    if (process.env.NODE_ENV !== 'production' && data.usage) {
      const u = data.usage;
      console.log(`🔢 tokens — in:${u.input_tokens} | cache_write:${u.cache_creation_input_tokens||0} | cache_read:${u.cache_read_input_tokens||0} | out:${u.output_tokens}`);
    }

    res.json({ text });
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── FILE UPLOAD (company procedures) ──
app.post('/api/upload', upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'לא נמצאו קבצים' });
  }

  const MAX_CHARS = 20000;

  const uploaded = await Promise.all(req.files.map(async f => {
    let content = '';
    const ext = path.extname(f.originalname).toLowerCase();
    try {
      if (ext === '.txt' || f.mimetype === 'text/plain') {
        content = fs.readFileSync(f.path, 'utf8').substring(0, MAX_CHARS);

      } else if (ext === '.pdf') {
        if (pdfParse) {
          const buffer = fs.readFileSync(f.path);
          const result = await pdfParse(buffer);
          content = cleanPdfText(result.text).substring(0, MAX_CHARS);
          if (!content.trim()) content = `[PDF: ${f.originalname} — לא ניתן לחלץ טקסט (PDF סרוק?)]`;
        } else {
          content = `[PDF: ${f.originalname} — יש להתקין pdf-parse: npm install pdf-parse]`;
        }

      } else if (ext === '.docx') {
        if (mammoth) {
          const buffer = fs.readFileSync(f.path);
          const result = await mammoth.extractRawText({ buffer });
          content = result.value.substring(0, MAX_CHARS);
        } else {
          content = `[DOCX: ${f.originalname} — יש להתקין mammoth: npm install mammoth]`;
        }

      } else if (ext === '.doc') {
        content = `[DOC: ${f.originalname} — שמור קובץ זה כ-DOCX או TXT]`;

      } else {
        content = `[${f.originalname} — פורמט לא נתמך]`;
      }
    } catch(e) {
      content = `[שגיאה בקריאת ${f.originalname}: ${e.message}]`;
    }

    try { fs.unlinkSync(f.path); } catch(e) {}
    return { name: f.originalname, content, size: f.size };
  }));

  res.json({ files: uploaded });
});

// ── KNOWLEDGE BASE STATUS ──
app.get('/api/kb-status', (req, res) => {
  res.json({
    loaded: knowledgeBase.length,
    docs: knowledgeBase.map(d => ({ name: d.name, chars: d.text.length }))
  });
});

// ── START ──
loadRegulationPDFs().then(() => {
  app.listen(PORT, () => {
    console.log(`✅  SafetyIL פועל על http://localhost:${PORT}`);
    console.log(`📋  http://localhost:${PORT}\n`);
  });
});
