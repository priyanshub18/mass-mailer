const $ = (id) => document.getElementById(id);
let items = []; // {contact, subject, body, error}

const pill = (t, cls) => `<span class="pill ${cls || ''}">${t}</span>`;

async function loadStatus() {
  const s = await (await fetch('/api/status')).json();
  $('status').innerHTML =
    pill(s.ai ? 'Claude writing' : 'Template mode (no API key)', 'ok') +
    pill(s.gmail ? 'Sending as ' + s.gmailUser : 'Add Gmail app password', s.gmail ? 'ok' : 'bad') +
    pill(s.resume ? 'Resume ready' : 'No resume', s.resume ? 'ok' : 'bad') +
    pill(`Today ${s.sentToday}/${s.dailyLimit}`);
  $('resumeName').textContent = s.resume ? 'Uploaded: ' + s.resume : '';
  for (const k of ['name', 'phone', 'links', 'targetRoles', 'pitch', 'background']) $(k).value = s.profile[k] || '';
}

const profile = () => Object.fromEntries(['name', 'phone', 'links', 'targetRoles', 'pitch', 'background'].map((k) => [k, $(k).value.trim()]));

async function saveProfile() {
  await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile()) });
}
$('saveProfile').onclick = async () => { await saveProfile(); $('saveProfile').textContent = 'Saved ✓'; setTimeout(() => ($('saveProfile').textContent = 'Save profile'), 1500); loadStatus(); };

$('resume').onchange = async (e) => {
  const fd = new FormData(); fd.append('resume', e.target.files[0]);
  const r = await fetch('/api/resume', { method: 'POST', body: fd });
  if (!r.ok) alert((await r.json()).error);
  loadStatus();
};

const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
};

$('go').onclick = async () => {
  $('go').disabled = true;
  try {
    await saveProfile();
    $('progress').textContent = 'Reading pasted text…';
    const { contacts } = await post('/api/extract', { text: $('paste').value });
    if (!contacts.length) { $('progress').textContent = 'No recruiter emails found.'; return; }
    items = contacts.map((contact) => ({ contact }));
    render();
    $('review').hidden = false;
    // draft with small concurrency
    let done = 0, i = 0;
    const worker = async () => {
      while (i < items.length) {
        const it = items[i++];
        try {
          const d = await post('/api/draft', { contact: it.contact, style: $('style').value });
          it.subject = d.subject; it.body = d.body;
        } catch (e) { it.error = e.message; }
        $('progress').textContent = `Drafted ${++done}/${items.length}`;
        render();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    $('progress').textContent = `Drafted ${items.length} emails. Review below.`;
  } catch (e) { $('progress').textContent = '⚠ ' + e.message; }
  finally { $('go').disabled = false; }
};

function render() { saveEdits(); draw(); }

function saveEdits() {
  document.querySelectorAll('.item').forEach((el) => {
    const it = items[el.dataset.i]; if (!it) return;
    it.selected = el.querySelector('.chk').checked;
    const subj = el.querySelector('.subj'), body = el.querySelector('.body');
    if (subj && body) { it.subject = subj.value; it.body = body.value; }
  });
}

function draw() {
  $('list').innerHTML = items.map((it, i) => {
    const c = it.contact;
    const sel = it.selected ?? (!c.alreadySent && !!it.subject);
    return `<div class="item ${c.alreadySent ? 'dup' : ''}" data-i="${i}">
      <div class="head">
        <input type="checkbox" class="chk" ${sel ? 'checked' : ''} ${it.sent ? 'disabled' : ''}>
        <div class="who"><b>${esc(c.name || c.email)}</b> <span class="muted">${esc(c.email)}${c.company ? ' · ' + esc(c.company) : ''}${c.role ? ' · ' + esc(c.role) : ''}</span></div>
        <span class="state ${it.sent ? 'ok' : it.error ? 'bad' : ''}">${it.sent ? 'Sent ✓' : it.error ? esc(it.error) : c.alreadySent ? 'Already emailed' : it.subject ? '' : 'Drafting…'}</span>
      </div>
      ${it.subject != null ? `<input class="subj" value="${esc(it.subject)}"><textarea class="body">${esc(it.body)}</textarea>` : ''}
    </div>`;
  }).join('');
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

$('selAll').onclick = () => { saveEdits(); items.forEach((it) => { it.selected = !it.sent && !!it.subject; }); draw(); };
$('selNone').onclick = () => { saveEdits(); items.forEach((it) => { it.selected = false; }); draw(); };

$('send').onclick = async () => {
  render();
  const chosen = items.filter((it) => it.selected && it.subject && !it.sent);
  if (!chosen.length) return alert('Nothing selected.');
  if (!confirm(`Send ${chosen.length} email(s) from your Gmail with your resume attached? Sends are spaced out, so keep this tab open.`)) return;
  $('send').disabled = true;
  try {
    const r = await fetch('/api/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: chosen.map((it) => ({ to: it.contact.email, company: it.contact.company, subject: it.subject, body: it.body })) }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '', n = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
        const it = items.find((x) => x.contact.email === m.to);
        if (m.type === 'sent') { it.sent = true; it.selected = false; $('sendProgress').textContent = `Sent ${++n}/${chosen.length}`; }
        if (m.type === 'error') it.error = m.message;
        if (m.type === 'skip') it.error = m.reason;
        if (m.type === 'note') $('sendProgress').textContent = m.message;
        render();
      }
    }
    $('sendProgress').textContent = `Done. ${n} sent.`;
  } catch (e) { $('sendProgress').textContent = '⚠ ' + e.message; }
  finally { $('send').disabled = false; loadStatus(); loadLog(); }
};

async function loadLog() {
  const log = await (await fetch('/api/log')).json();
  $('log').innerHTML = log.length ? '<table>' + log.slice(0, 100).map((l) => `<tr><td>${new Date(l.at).toLocaleString()}</td><td>${esc(l.to)}</td><td>${esc(l.company)}</td><td>${esc(l.subject)}</td></tr>`).join('') + '</table>' : 'Nothing sent yet.';
}

loadStatus(); loadLog();
