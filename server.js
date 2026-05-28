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
try { pdfParse = require('pdf-parse'); } catch(e) { console.log('pdf-parse not installed — PDF files will be skipped'); }
try { mammoth = require('mammoth'); } catch(e) { console.log('mammoth not installed — DOCX files will be skipped'); }

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

  const claudeBody = {
    model: 'claude-sonnet-4-6',
    max_tokens,
    ...(system && { system }),
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(claudeBody)
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const text = data.content?.[0]?.text || '';
    res.json({ text });
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── FILE UPLOAD ──
app.post('/api/upload', upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'לא נמצאו קבצים' });
  }

  const MAX_CHARS = 20000; // per file

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
          content = result.text.substring(0, MAX_CHARS);
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
        content = `[DOC: ${f.originalname} — פורמט .doc ישן אינו נתמך. שמור כ-DOCX או TXT]`;

      } else {
        content = `[${f.originalname} — פורמט לא נתמך]`;
      }
    } catch(e) {
      content = `[שגיאה בקריאת ${f.originalname}: ${e.message}]`;
    }

    // Cleanup temp file
    try { fs.unlinkSync(f.path); } catch(e) {}

    return { name: f.originalname, content, size: f.size };
  }));

  res.json({ files: uploaded });
});

app.listen(PORT, () => {
  console.log(`\n✅ SafetyIL פועל על http://localhost:${PORT}`);
  console.log(`📋 פתח את הדפדפן ועבור ל: http://localhost:${PORT}\n`);
  if (!pdfParse) console.log('💡 להפעלת PDF: npm install pdf-parse');
  if (!mammoth) console.log('💡 להפעלת DOCX: npm install mammoth');
});
