import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import nodemailer from 'nodemailer';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const UPLOADS = path.join(__dirname, 'uploads');
const PROFILE_FILE = path.join(DATA, 'profile.json');
const LOG_FILE = path.join(DATA, 'sent-log.json');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const DAILY_LIMIT = Number(process.env.DAILY_SEND_LIMIT || 40);
const DELAY_MS = Number(process.env.SEND_DELAY_SECONDS || 20) * 1000;
const PORT = Number(process.env.PORT || 3000);

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_req, file, cb) => cb(null, 'resume' + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(null, /\.(pdf|docx?)$/i.test(file.originalname)),
});

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// ---------- config / profile ----------
app.get('/api/status', (_req, res) => {
  const profile = readJson(PROFILE_FILE, {});
  const resume = fs.readdirSync(UPLOADS).find((f) => f.startsWith('resume'));
  res.json({
    ai: !!anthropic,
    gmail: !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
    gmailUser: process.env.GMAIL_USER || null,
    resume: resume || null,
    profile,
    sentToday: sentToday().length,
    dailyLimit: DAILY_LIMIT,
  });
});

app.post('/api/profile', (req, res) => {
  writeJson(PROFILE_FILE, req.body || {});
  res.json({ ok: true });
});

app.post('/api/resume', (req, res, next) => {
  for (const f of fs.readdirSync(UPLOADS)) if (f.startsWith('resume')) fs.unlinkSync(path.join(UPLOADS, f));
  next();
}, upload.single('resume'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a PDF or Word file (max 5MB).' });
  res.json({ ok: true, file: req.file.filename });
});


// ---------- no-AI fallback: regex extraction + templates ----------
const FREE_MAIL = /^(gmail|yahoo|outlook|hotmail|icloud|proton|protonmail|rediffmail|live)\./i;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function extractLocal(text) {
  const lines = text.split(/\r?\n/);
  const out = [], seen = new Set();
  lines.forEach((line, idx) => {
    for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      const email = m[0].toLowerCase().replace(/[.,;]+$/, '');
      if (seen.has(email)) continue; seen.add(email);
      const ctx = [lines[idx - 2], lines[idx - 1], line, lines[idx + 1]].filter(Boolean).join(' ');
      const [local, domain] = email.split('@');
      let name = '';
      const before = line.slice(0, m.index).match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*[<(:\-–|,]*\s*$/);
      if (before) name = before[1];
      else if (/^[a-z]+[._][a-z]+$/.test(local)) name = local.split(/[._]/).map(cap).join(' ');
      const company = FREE_MAIL.test(domain) ? '' : cap(domain.split('.')[0]);
      const roleCtx = [lines[idx - 1] && !/@/.test(lines[idx - 1]) ? lines[idx - 1] : '', line].join(' ');
      const role = (roleCtx.match(/(?:hiring|looking for|opening for|opportunity for|role:?|position:?)\s+(?:an?\s+)?([A-Za-z0-9+#/ .-]{3,50}?)(?=[.,\n|(]|\s+(?:at|in|with|for)\b|$)/i) || [])[1] || '';
      out.push({ name, email, company, role: role.trim(), context: ctx.slice(0, 300) });
    }
  });
  return out;
}

const SUBJECTS = [
  (c, p) => c.role ? `${c.role}: quick intro from ${p.name.split(' ')[0]}` : `Quick intro: ${p.name}${p.targetRoles ? ' · ' + p.targetRoles.split(',')[0].trim() : ''}`,
  (c, p) => c.company ? `Can I help ${c.company} ship faster?` : `An engineer worth a 10-minute chat`,
  (c, p) => c.role ? `Re: ${c.role}, resume attached` : `${p.name} · resume attached`,
  (c, p) => c.company ? `${p.name} × ${c.company}` : `Introduction from ${p.name}`,
];
const BODIES = [
  (c, p, hook, pitch) => `${greet(c)}\n\n${c.role ? `I saw you're hiring for ${/^[aeiou]/i.test(c.role) ? 'an' : 'a'} ${c.role}${c.company ? ' at ' + c.company : ''}, and it lines up closely with my work.` : `I'm reaching out because I'm looking for my next ${p.targetRoles || 'role'}${c.company ? ' and ' + c.company + ' is on my shortlist' : ''}.`}\n\n${pitch}\n\nMy resume is attached. If this looks like a fit, I'd love a quick call, or a pointer to the right person on your team if it's not you.`,
  (c, p, hook, pitch) => `${greet(c)}\n\n${hook}\n\n${pitch}\n\nI've attached my resume${c.role ? ` for the ${c.role} role` : ''}. Would you be open to a short chat this week?`,
  (c, p, hook, pitch) => `${greet(c)}\n\nI'll keep this short. ${pitch}\n\n${c.company ? `I'd be excited to bring that to ${c.company}` : `I'd be excited to bring that to your team`}${c.role ? ` as ${/^[aeiou]/i.test(c.role) ? 'an' : 'a'} ${c.role}` : ''}. Resume attached, and happy to share more or jump on a quick call whenever suits you.`,
];
const greet = (c) => `Hi ${(c.name || '').split(' ')[0] || 'there'},`;
const pick = (arr, seed) => arr[seed % arr.length];
let draftCounter = Math.floor(Math.random() * 100);

function draftLocal(c, p) {
  const seed = draftCounter++;
  const lines = (p.background || '').split(/\n+/).map((l) => l.replace(/^[-•*\s]+/, '').trim()).filter(Boolean);
  const pitch = p.pitch || lines.slice(0, 2).join(' ') || `I'm ${p.name}, and I build things that work.`;
  const hook = p.targetRoles ? `I'm a ${p.targetRoles.split(',')[0].trim()} and I think we could be a good match.` : `I think we could be a good match.`;
  return { subject: pick(SUBJECTS, seed)(c, p).slice(0, 70), body: pick(BODIES, seed + 1)(c, p, hook, pitch) };
}

// ---------- agent step 1: extract recruiters from pasted text ----------
const extractTool = {
  name: 'save_recruiters',
  description: 'Save every recruiter / hiring contact found in the pasted text.',
  input_schema: {
    type: 'object',
    properties: {
      contacts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Recruiter first+last name, or empty' },
            email: { type: 'string' },
            company: { type: 'string' },
            role: { type: 'string', description: 'Job title being hired for, if mentioned' },
            context: { type: 'string', description: 'Key details from the post: stack, location, requirements, anything useful for personalizing' },
          },
          required: ['email'],
        },
      },
    },
    required: ['contacts'],
  },
};

app.post('/api/extract', async (req, res) => {
  const text = String(req.body.text || '').slice(0, 60000);
  if (!text.trim()) return res.status(400).json({ error: 'Paste some text first.' });
  const sent0 = new Set(readJson(LOG_FILE, []).map((l) => l.to.toLowerCase()));
  if (!anthropic) return res.json({ contacts: extractLocal(text).filter((c) => EMAIL_RE.test(c.email)).map((c) => ({ ...c, alreadySent: sent0.has(c.email) })) });
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      tools: [extractTool],
      tool_choice: { type: 'tool', name: 'save_recruiters' },
      messages: [{
        role: 'user',
        content: `Extract every recruiter or hiring contact with an email address from the text below. It may be LinkedIn posts, job ads, spreadsheets, or a raw list; format is arbitrary. Only include real email addresses that appear in the text; never invent any. Merge duplicates.\n\n<text>\n${text}\n</text>`,
      }],
    });
    const block = msg.content.find((b) => b.type === 'tool_use');
    const seen = new Set();
    const sent = new Set(readJson(LOG_FILE, []).map((l) => l.to.toLowerCase()));
    const contacts = (block?.input?.contacts || [])
      .map((c) => ({ ...c, email: String(c.email || '').trim().toLowerCase() }))
      .filter((c) => EMAIL_RE.test(c.email) && !seen.has(c.email) && seen.add(c.email))
      .map((c) => ({ ...c, alreadySent: sent.has(c.email) }));
    res.json({ contacts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- agent step 2: draft a personalized email per recruiter ----------
const draftTool = {
  name: 'save_email',
  description: 'Save the drafted outreach email.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Catchy, specific subject line, under 70 chars' },
      body: { type: 'string', description: 'Plain-text email body, no signature (added separately)' },
    },
    required: ['subject', 'body'],
  },
};

app.post('/api/draft', async (req, res) => {
  const { contact, style } = req.body;
  const p = readJson(PROFILE_FILE, {});
  if (!p.name) return res.status(400).json({ error: 'Fill in your profile first.' });
  if (!anthropic) return res.json(draftLocal(contact, p));
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: `You write cold outreach emails from a job seeker to a recruiter. Rules:
- Sound like a sharp, warm human, not a template. No clichés ("I hope this email finds you well", "I am writing to express my interest").
- 90-150 words. Short paragraphs. One concrete hook tying the candidate's strongest relevant experience to what the recruiter is hiring for.
- Use only facts from the candidate profile. Never invent employers, numbers or skills.
- Subject: specific and intriguing, under 70 chars, no ALL CAPS, no emojis, not clickbait.
- Mention the resume is attached. End with a low-friction ask (a quick call / a pointer to the right team).
- Greet by first name if known, otherwise "Hi there,".
- Do not include a signature or sign-off name; it is appended automatically.
- Style requested: ${style || p.tone || 'confident but friendly'}.`,
      tools: [draftTool],
      tool_choice: { type: 'tool', name: 'save_email' },
      messages: [{
        role: 'user',
        content: `Candidate profile:\nName: ${p.name}\nTarget roles: ${p.targetRoles || ''}\nBackground / highlights:\n${p.background || ''}\n\nRecruiter:\n${JSON.stringify(contact)}`,
      }],
    });
    const out = msg.content.find((b) => b.type === 'tool_use')?.input;
    if (!out) throw new Error('No draft returned');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- send ----------
function sentToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return readJson(LOG_FILE, []).filter((l) => new Date(l.at) >= start);
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function signature(p) {
  const lines = [p.name, p.phone, p.links].filter(Boolean);
  return lines.length ? '\n\nBest,\n' + lines.join('\n') : '';
}

// Streams one JSON line per email so the UI can show live progress.
app.post('/api/send', async (req, res) => {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return res.status(400).json({ error: 'Set GMAIL_USER and GMAIL_APP_PASSWORD in .env' });
  const resumeName = fs.readdirSync(UPLOADS).find((f) => f.startsWith('resume'));
  if (!resumeName) return res.status(400).json({ error: 'Upload your resume first.' });

  const profile = readJson(PROFILE_FILE, {});
  const emails = (req.body.emails || []).filter((e) => EMAIL_RE.test(e.to));
  const remaining = DAILY_LIMIT - sentToday().length;
  if (remaining <= 0) return res.status(429).json({ error: `Daily limit of ${DAILY_LIMIT} reached. Spreading sends protects your Gmail from being flagged.` });

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  try { await transporter.verify(); } catch (e) {
    return res.status(400).json({ error: 'Gmail login failed: ' + e.message });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  const emit = (o) => res.write(JSON.stringify(o) + '\n');
  const sentSet = new Set(readJson(LOG_FILE, []).map((l) => l.to.toLowerCase()));
  const batch = emails.slice(0, remaining);
  if (emails.length > batch.length) emit({ type: 'note', message: `Only sending ${batch.length} today (daily limit).` });

  let first = true;
  for (const e of batch) {
    const to = e.to.toLowerCase();
    if (sentSet.has(to)) { emit({ type: 'skip', to, reason: 'already emailed' }); continue; }
    if (!first) await sleep(DELAY_MS + Math.random() * 5000);
    first = false;
    const text = e.body.trim() + signature(profile);
    try {
      await transporter.sendMail({
        from: `"${profile.name || user}" <${user}>`,
        to,
        subject: e.subject,
        text,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;white-space:pre-wrap">${escapeHtml(text)}</div>`,
        attachments: [{ filename: `${(profile.name || 'Resume').replace(/\s+/g, '_')}_Resume${path.extname(resumeName)}`, path: path.join(UPLOADS, resumeName) }],
      });
      const log = readJson(LOG_FILE, []);
      log.push({ to, subject: e.subject, company: e.company || '', at: new Date().toISOString() });
      writeJson(LOG_FILE, log);
      sentSet.add(to);
      emit({ type: 'sent', to });
    } catch (err) {
      emit({ type: 'error', to, message: err.message });
    }
  }
  emit({ type: 'done' });
  res.end();
});

app.get('/api/log', (_req, res) => res.json(readJson(LOG_FILE, []).reverse()));

app.listen(PORT, '127.0.0.1', () => console.log(`Mass Mailer running at http://localhost:${PORT}`));
