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
    model: 'claude-haiku-4-5-20251001',
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
app.post('/api/upload', upload.array('files', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'לא נמצאו קבצים' });
  }
  const uploaded = req.files.map(f => {
    let content = '';
    try {
      if (f.mimetype === 'text/plain' || f.originalname.endsWith('.txt')) {
        content = fs.readFileSync(f.path, 'utf8').substring(0, 12000);
      } else {
        content = `[קובץ: ${f.originalname} — ${Math.round(f.size/1024)}KB — לעיבוד נוסף יש להוסיף ספריית PDF/Word]`;
      }
    } catch(e) { content = `[שגיאה בקריאת הקובץ: ${e.message}]`; }
    return { name: f.originalname, content, size: f.size };
  });
  res.json({ files: uploaded });
});

app.listen(PORT, () => {
  console.log(`\n✅ SafetyIL פועל על http://localhost:${PORT}`);
  console.log(`📋 פתח את הדפדפן ועבור ל: http://localhost:${PORT}\n`);
});
