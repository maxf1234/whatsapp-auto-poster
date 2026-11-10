const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let cfg = {};
let me = null; // the logged-in user (from /api/me)
let posts = { scheduled: [], queue: [], history: [] };
let imageData = null; // resized JPEG data URL
let when = store.get('when') || 'at';
const selected = new Set(JSON.parse(store.get('targets') || '[]'));

// ---------- API ----------

async function api(path, method = 'GET', body) {
  const res = await fetch(`api/${path}`, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && me && !path.startsWith('me/password') && path !== 'me') { showAuth(); }
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function setMsg(id, text, kind = '') {
  $(id).textContent = text;
  $(id).className = `msg ${kind}`;
}

const icon = (name) => `<svg class="i"><use href="#i-${name}"/></svg>`;
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Auth ----------

let signup = false;
function setAuthTab(isSignup) {
  signup = isSignup;
  $('tabLogin').setAttribute('aria-pressed', String(!isSignup));
  $('tabSignup').setAttribute('aria-pressed', String(isSignup));
  $('nameWrap').hidden = !isSignup;
  $('authBtn').textContent = isSignup ? 'Create account' : 'Log in';
  $('aPw').autocomplete = isSignup ? 'new-password' : 'current-password';
  setMsg('authMsg', '');
}
$('tabLogin').onclick = () => setAuthTab(false);
$('tabSignup').onclick = () => {
  if (!cfg.signupsOpen) return setMsg('authMsg', 'Sign-ups are closed right now.', 'warn');
  setAuthTab(true);
};

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  $('authBtn').disabled = true;
  try {
    const body = { email: $('aEmail').value, password: $('aPw').value };
    if (signup) Object.assign(body, { name: $('aName').value, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const { user } = await api(signup ? 'signup' : 'login', 'POST', body);
    $('aPw').value = '';
    me = user;
    showApp();
  } catch (err) {
    setMsg('authMsg', err.message, 'err');
  } finally {
    $('authBtn').disabled = false;
  }
};

$('logout').onclick = async () => {
  await api('logout', 'POST').catch(() => {});
  me = null;
  showAuth();
};

function showAuth() {
  me = null;
  stopPolling();
  $('appView').hidden = true;
  $('authView').hidden = false;
}

// ---------- Views ----------

function route() {
  const view = location.hash.replace(/^#\/?/, '') || 'dash';
  const name = ['account', 'admin'].includes(view) ? view : 'dash';
  $('dashView').hidden = name !== 'dash';
  $('accountView').hidden = name !== 'account';
  $('adminView').hidden = name !== 'admin';
  for (const a of document.querySelectorAll('nav a[data-view]')) {
    a.toggleAttribute('aria-current', a.dataset.view === name);
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
  }
  if (name === 'account') drawAccount();
  if (name === 'admin') loadAdmin();
}
window.addEventListener('hashchange', route);

function showApp() {
  $('authView').hidden = true;
  $('appView').hidden = false;
  drawMe();
  route();
  loadPosts();
  loadWhatsApp();
  startPolling();
  const billing = new URLSearchParams(location.search).get('billing');
  if (billing) {
    history.replaceState(null, '', location.pathname + location.hash);
    banner(billing === 'success' ? 'Thanks! Pro is switching on. It can take a few seconds.' : 'Checkout cancelled. Nothing was charged.');
    if (billing === 'success') setTimeout(refreshMe, 4000);
  }
}

function banner(text) {
  $('bannerText').textContent = text;
  $('banner').hidden = !text;
  if (text) setTimeout(() => { $('banner').hidden = true; }, 10000);
}

async function refreshMe() {
  try { me = (await api('me')).user; drawMe(); } catch {}
}

function drawMe() {
  document.title = cfg.appName || 'Auto Poster';
  $('appName').textContent = cfg.appName || 'Auto Poster';
  $('adminLink').hidden = !me.isAdmin;
  $('planBadge').hidden = !cfg.billingEnabled;
  $('planBadge').textContent = me.limits.label;
  $('planBadge').className = `badge ${me.plan === 'pro' ? 'pro' : ''}`;
  drawTargets();
  drawWhen();
  drawQueueSettings(me.queue);
  renderPreview();
}

// ---------- Composer ----------

for (const b of document.querySelectorAll('.tools button')) {
  b.onclick = () => {
    const ta = $('text');
    const mark = b.dataset.wrap;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const inner = value.slice(s, e) || 'text';
    ta.value = value.slice(0, s) + mark + inner + mark + value.slice(e);
    ta.focus();
    ta.setSelectionRange(s + mark.length, s + mark.length + inner.length);
    saveDraft();
    renderPreview();
  };
}

$('text').value = store.get('draft') || '';
const saveDraft = () => store.set('draft', $('text').value);
$('text').oninput = () => { saveDraft(); renderPreview(); };

function waFormat(text) {
  return escapeHtml(text)
    .replace(/```([\s\S]+?)```/g, '<code>$1</code>')
    .replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s).,!?:])/gm, '$1<b>$2</b>')
    .replace(/(^|[\s(])_(\S(?:[^_\n]*\S)?)_(?=$|[\s).,!?:])/gm, '$1<i>$2</i>')
    .replace(/(^|[\s(])~(\S(?:[^~\n]*\S)?)~(?=$|[\s).,!?:])/gm, '$1<s>$2</s>');
}

function caption() {
  const text = $('text').value.trim();
  return me?.footer ? (text ? `${text}\n\n${me.footer}` : me.footer) : text;
}

function renderPreview() {
  const cap = caption();
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const picked = me ? me.targets.filter((t) => selected.has(t.id)) : [];
  const statusOnly = !imageData && picked.length > 0 && picked.every((t) => t.kind === 'status');
  $('preview').classList.toggle('status-bubble', statusOnly);
  $('preview').style.setProperty('--status-bg', (editingStatus && statusColor) || picked[0]?.color || '#128c7e');
  $('preview').innerHTML =
    (imageData ? `<img src="${imageData}" alt="Post image" />` : '') +
    `<div class="cap">${waFormat(cap) || '<span style="opacity:.5">Your post…</span>'}</div>` +
    `<div class="time">${time}</div>`;
  $('count').textContent = `${cap.length} characters`;
}

// Image: pick / drop / paste, resized client-side (max 1600px JPEG).
async function loadImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  imageData = canvas.toDataURL('image/jpeg', 0.88);
  $('dropInner').innerHTML =
    `<div><img src="${imageData}" alt="Selected image" /><small>Tap to change · <a href="#" id="rmImg">Remove</a></small></div>`;
  $('rmImg').onclick = (e) => { e.preventDefault(); e.stopPropagation(); clearImage(); };
  renderPreview();
}

function clearImage() {
  imageData = null;
  $('file').value = '';
  $('dropInner').innerHTML = `<span class="drop-ic">${icon('image')}</span><span><b>Add an image</b> · tap, drop or paste<br><small>Optional · JPEG, PNG or WebP</small></span>`;
  renderPreview();
}

$('file').onchange = (e) => loadImage(e.target.files[0]);
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); loadImage(e.dataTransfer.files[0]); };
document.addEventListener('paste', (e) => {
  if ($('dashView').hidden) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) loadImage(item.getAsFile());
});

// Targets as checkboxes in the composer.
const KIND = {
  channel: { label: 'Channel', icon: 'send', color: 'c-teal' },
  group: { label: 'Group', icon: 'users', color: 'c-amber' },
  status: { label: 'Status', icon: 'status', color: 'c-green' },
};
const kindOf = (x) => KIND[x.kind] ?? { label: 'Test', icon: 'users', color: 'c-amber' };

function drawTargets() {
  const t = me.targets;
  for (const id of [...selected]) if (!t.some((x) => x.id === id)) selected.delete(id);
  if (t.length === 1) selected.add(t[0].id);
  $('targetChecks').innerHTML = t.length
    ? t.map((x) => `<label><input type="checkbox" value="${x.id}" ${selected.has(x.id) ? 'checked' : ''} /> ${escapeHtml(x.name)} <small>${kindOf(x).label}</small></label>`).join('')
    : '<div class="hint">Add a group, channel or your Status first, under <b>Where to post</b>.</div>';
  for (const cb of $('targetChecks').querySelectorAll('input')) {
    cb.onchange = () => {
      cb.checked ? selected.add(cb.value) : selected.delete(cb.value);
      store.set('targets', JSON.stringify([...selected]));
      renderPreview();
    };
  }

  $('targetCount').textContent = `${t.length} / ${me.limits.maxTargets}`;
  $('targetList').innerHTML = t.length
    ? t.map((x) => `<li data-id="${x.id}"><span class="t-ic ${kindOf(x).color}">${icon(kindOf(x).icon)}</span><div class="lbody">${escapeHtml(x.name)}<div class="muted">${x.kind === 'status' ? `Seen by ${escapeHtml(x.audienceSummary)}` : kindOf(x).label}</div></div>
        <div class="lbtns">${x.kind === 'status' ? '<button type="button" data-act="edit">Edit</button>' : ''}<button type="button" data-act="del" aria-label="Remove ${escapeHtml(x.name)}">✕</button></div></li>`).join('')
    : '<li class="empty">Nowhere to post yet</li>';
  $('addStatus').hidden = t.some((x) => x.kind === 'status') || !$('statusEditor').hidden;
}

// ---------- Status audience editor ----------

let editingStatus = null; // target id, or 'new'
let statusColor = null;
let lastWa = {};

async function openStatusEditor(target) {
  editingStatus = target?.id ?? 'new';
  const a = target?.audience ?? { contacts: true, groups: [], numbers: [] };
  $('stTitle').textContent = target ? 'Who sees your Status' : 'Post to my Status';
  $('stContacts').checked = a.contacts;
  $('stContactCount').textContent = lastWa.state === 'connected' ? `(${lastWa.contacts ?? 0} synced from your phone)` : '';
  $('stNumbers').value = (a.numbers ?? []).map((n) => `+${n}`).join('\n');
  statusColor = target?.color ?? cfg.statusColors?.[0];
  $('stColors').innerHTML = (cfg.statusColors ?? []).map((c) =>
    `<button type="button" role="radio" aria-checked="${c === statusColor}" aria-label="Colour ${c}" data-color="${c}" style="background:${c}"></button>`).join('');
  setMsg('stMsg', '');
  $('statusEditor').hidden = false;
  $('addStatus').hidden = true;
  $('stGroups').innerHTML = '<div class="hint" style="margin:0">Loading your groups…</div>';
  try {
    const { groups } = await api('whatsapp/groups');
    const chosen = new Set(a.groups);
    $('stGroups').innerHTML = groups.length
      ? groups.map((g) => `<label><input type="checkbox" value="${escapeHtml(g.jid)}" ${chosen.has(g.jid) ? 'checked' : ''} /> ${escapeHtml(g.name)}</label>`).join('')
      : '<div class="hint" style="margin:0">Your number isn\'t in any groups.</div>';
  } catch {
    $('stGroups').innerHTML = '<div class="hint" style="margin:0">Link WhatsApp to pick groups.</div>';
  }
}

function closeStatusEditor() {
  editingStatus = null;
  $('statusEditor').hidden = true;
  drawTargets();
}

$('addStatus').onclick = () => openStatusEditor(null);
$('stCancel').onclick = closeStatusEditor;
$('stColors').onclick = (e) => {
  const b = e.target.closest('button[data-color]');
  if (!b) return;
  statusColor = b.dataset.color;
  for (const x of $('stColors').children) x.setAttribute('aria-checked', String(x === b));
  renderPreview();
};
$('stSave').onclick = async () => {
  const audience = {
    contacts: $('stContacts').checked,
    groups: [...$('stGroups').querySelectorAll('input:checked')].map((i) => i.value),
    numbers: $('stNumbers').value,
  };
  $('stSave').disabled = true;
  try {
    const data = editingStatus === 'new'
      ? await api('targets', 'POST', { ref: 'status', audience, color: statusColor })
      : await api(`targets/${editingStatus}`, 'POST', { audience, color: statusColor });
    me = data.user;
    const st = me.targets.find((x) => x.kind === 'status');
    if (editingStatus === 'new' && st) { selected.add(st.id); store.set('targets', JSON.stringify([...selected])); }
    closeStatusEditor();
    drawMe();
    setMsg('targetMsg', 'Status saved', 'ok');
  } catch (err) {
    setMsg('stMsg', err.message, 'err');
  } finally {
    $('stSave').disabled = false;
  }
};

$('targetList').onclick = async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  if (btn.dataset.act === 'edit') return openStatusEditor(me.targets.find((x) => x.id === id));
  if (!confirm('Remove this? Waiting posts that only go here will be deleted too.')) return;
  try {
    const data = await api(`targets/${id}`, 'DELETE');
    me = data.user;
    drawMe();
    drawPosts(data);
  } catch (err) { setMsg('targetMsg', err.message, 'err'); }
};

async function addTarget(ref) {
  setMsg('targetMsg', 'Adding…');
  try {
    me = (await api('targets', 'POST', { ref })).user;
    const added = me.targets.at(-1);
    if (added) { selected.add(added.id); store.set('targets', JSON.stringify([...selected])); }
    drawMe();
    setMsg('targetMsg', `Added ${added?.name ?? ''}`, 'ok');
    $('targetRef').value = '';
    loadGroups();
  } catch (err) { setMsg('targetMsg', err.message, 'err'); }
}
$('addTarget').onclick = () => addTarget($('targetRef').value);
$('addGroup').onclick = () => $('groupSelect').value && addTarget($('groupSelect').value);

async function loadGroups() {
  try {
    const { groups } = await api('whatsapp/groups');
    const free = groups.filter((g) => !g.added);
    $('groupSelect').innerHTML = free.length
      ? free.map((g) => `<option value="${escapeHtml(g.jid)}">${escapeHtml(g.name)}${g.announce ? ' (admins only)' : ''}</option>`).join('')
      : '<option value="">All your groups are added</option>';
    $('groupPick').hidden = false;
  } catch {
    $('groupPick').hidden = true;
  }
}

// When: now / in… / at / queue (+ repeat).
function drawWhen() {
  for (const b of $('whenSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.when === when));
  $('delayBox').hidden = when !== 'delay';
  $('atBox').hidden = when !== 'at';
  $('repeatBox').hidden = !['delay', 'at'].includes(when);
  $('repeatPro').hidden = !cfg.billingEnabled || me.limits.recurring;
  $('repeat').disabled = !me.limits.recurring;
  if (!me.limits.recurring) $('repeat').value = 'none';
  if (when === 'at' && !$('atInput').value) {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setMinutes(0, 0, 0);
    $('atInput').value = toLocalInput(d);
  }
  $('submit').textContent = { now: 'Post now', delay: 'Schedule', at: 'Schedule', queue: 'Add to queue' }[when];
  updateHint();
}

function updateHint() {
  const tzNote = me && me.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone
    ? ` (your account's time zone is ${me.timeZone}; times here are in this device's time)` : '';
  const t = whenTime();
  $('whenHint').textContent = when === 'queue'
    ? `Goes out after the ${posts.queue.length} post${posts.queue.length === 1 ? '' : 's'} already in the queue.`
    : when === 'now' ? 'Sends straight away.' : t ? `Goes out ${fmtWhen(t)}${tzNote}.` : '';
}

const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
function whenTime() {
  if (when === 'delay') return Date.now() + Number($('delayN').value) * Number($('delayUnit').value) * 60000;
  if (when === 'at') return $('atInput').value ? new Date($('atInput').value).getTime() : null;
  return null;
}

$('whenSeg').onclick = (e) => {
  const b = e.target.closest('button[data-when]');
  if (!b) return;
  when = b.dataset.when;
  store.set('when', when);
  drawWhen();
};
for (const id of ['delayN', 'delayUnit', 'atInput']) $(id).oninput = updateHint;
$('repeat').onchange = () => {
  if (!me.limits.recurring) { $('repeat').value = 'none'; setMsg('msg', 'Repeating posts are on the Pro plan.', 'warn'); }
};

$('submit').onclick = async () => {
  const targets = [...selected].filter((id) => me.targets.some((t) => t.id === id));
  if (!$('text').value.trim() && !imageData) return setMsg('msg', 'Write something or add an image', 'err');
  if (!targets.length) return setMsg('msg', 'Pick at least one group or channel', 'err');
  const w = { type: when };
  if (when === 'delay') w.delayMin = Number($('delayN').value) * Number($('delayUnit').value);
  if (when === 'at') {
    w.at = whenTime();
    if (!w.at) return setMsg('msg', 'Pick a date and time', 'err');
  }
  if (when === 'now' && !confirm(`Post this to ${targets.length} group${targets.length === 1 ? '' : 's'}/channel${targets.length === 1 ? '' : 's'} right now?`)) return;

  $('submit').disabled = true;
  setMsg('msg', when === 'now' ? 'Posting…' : 'Saving…');
  try {
    const data = await api('posts', 'POST', { text: $('text').value, image: imageData, targets, when: w, repeat: $('repeat').value });
    if (when === 'now') {
      data.sent ? setMsg('msg', 'Posted!', 'ok') : setMsg('msg', `Couldn't send yet: ${data.error}. It will retry every 5 minutes (see Scheduled).`, 'warn');
    } else {
      setMsg('msg', `${when === 'queue' ? 'Added to the queue' : 'Scheduled'} · goes out ${fmtWhen(data.eta)}`, 'ok');
    }
    $('text').value = '';
    saveDraft();
    clearImage();
    drawPosts(data);
    refreshMe();
  } catch (err) {
    setMsg('msg', err.message, 'err');
  } finally {
    $('submit').disabled = false;
  }
};

$('clear').onclick = () => { $('text').value = ''; saveDraft(); clearImage(); setMsg('msg', ''); };

// ---------- Scheduled + queue lists ----------

const INTERVALS = [15, 30, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
const fmtInterval = (m) => (m < 60 ? `${m} min` : m === 1440 ? 'day' : `${m / 60} hour${m === 60 ? '' : 's'}`);
const fmtHour = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });

function fmtWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (ms - Date.now() < 60 * 1000) return 'now';
  const today = new Date().toDateString() === d.toDateString();
  const tomorrow = new Date(Date.now() + 864e5).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (today) return `at ${time}`;
  if (tomorrow) return `tomorrow ${time}`;
  const far = ms - Date.now() > 6 * 864e5;
  return `${d.toLocaleDateString([], far ? { month: 'short', day: 'numeric' } : { weekday: 'short' })} ${time}`;
}

function summary(text) {
  return text.split('\n').map((l) => l.replace(/[*_~`]/g, '').trim()).filter(Boolean).slice(0, 3).join(' · ') || '(image)';
}

const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function postItem(p, i, list, isQueue) {
  const repeat = p.repeat && p.repeat !== 'none' ? `<span class="chip c-violet">${icon('repeat')}${p.repeat === 'daily' ? 'Daily' : 'Weekly'}</span>` : '';
  const state = p.status === 'failed' ? `<span class="chip c-red">Failed</span><span class="err">${escapeHtml(p.error)}</span>`
    : p.error ? `<span class="chip c-amber">Retrying</span><span class="err">${escapeHtml(p.error)}</span>`
    : isQueue && me.queue.paused ? '<span class="chip c-gray">Paused</span>'
    : `<span class="chip ${isQueue ? 'c-violet' : 'c-blue'}">${icon('clock')}${escapeHtml(cap1(fmtWhen(p.eta)))}</span>`;
  return `<li data-id="${p.id}">
    ${p.hasImage ? `<img class="thumb" alt="" src="api/posts/${p.id}/image" loading="lazy" />` : '<div class="thumb">Aa</div>'}
    <div class="lbody">
      <div class="lwhen">${isQueue ? `<span class="chip c-gray">#${i + 1}</span>` : ''}${state}${repeat}<span>→ ${escapeHtml(p.targets.join(', ') || 'nowhere')}</span></div>
      <div class="ltext">${escapeHtml(summary(p.text))}</div>
      <div class="lbtns">
        ${isQueue ? `<button type="button" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button type="button" data-act="down" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>` : ''}
        <button type="button" data-act="send">Send now</button>
        <button type="button" data-act="del" aria-label="Delete">Delete</button>
      </div>
    </div>
  </li>`;
}

function drawPosts(data) {
  posts = { ...posts, ...data };
  const s = posts.scheduled;
  $('schedCount').textContent = s.length ? String(s.length) : '';
  $('schedList').innerHTML = s.length ? s.map((p, i) => postItem(p, i, s, false)).join('')
    : '<li class="empty">Nothing scheduled yet. Pick “In…” or “At a time” when you write a post.</li>';

  const q = posts.queue;
  if (data.queueSettings) { me.queue = data.queueSettings; drawQueueSettings(me.queue); }
  let status = q.length ? `${q.length} post${q.length === 1 ? '' : 's'} waiting` : 'Empty. Queued posts go out one at a time, every interval.';
  if (q.length && me.queue.paused) status += ' · paused';
  else if (q.length) status += ` · next ${fmtWhen(q[0].eta)}`;
  if (me.queue.startHour !== me.queue.endHour) {
    status += ` · only ${fmtHour(me.queue.startHour)}–${fmtHour(me.queue.endHour)} (${me.timeZone.split('/').pop().replace(/_/g, ' ')})`;
  }
  if (me.queue.error) status += ` · last send failed: ${me.queue.error}`;
  $('qStatus').textContent = status;
  $('qList').innerHTML = q.map((p, i) => postItem(p, i, q, true)).join('');

  const h = posts.history || [];
  $('history').innerHTML = h.length
    ? h.slice(0, 15).map((x) => {
      const ok = x.status === 'sent';
      return `<li><span class="t-ic ${ok ? 'c-green' : 'c-red'}">${icon(ok ? 'check' : 'history')}</span><div class="lbody"><div class="ltext" style="margin:0">${x.hasImage ? `${icon('image')} ` : ''}${escapeHtml(summary(x.text))}</div><div class="lwhen" style="margin-top:3px">${new Date(x.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}${ok ? '' : ` · <span class="err">${escapeHtml(x.status)}</span>`}${x.targets.length ? ` · ${escapeHtml(x.targets.join(', '))}` : ''}</div></div></li>`;
    }).join('')
    : '<li class="empty">Nothing sent yet</li>';
  updateHint();
}

async function loadPosts() {
  try { drawPosts(await api('posts')); } catch {}
}

async function postAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const act = btn.dataset.act;
  if (act === 'del' && !confirm('Delete this post?')) return;
  if (act === 'send' && !confirm('Send this post right now?')) return;
  btn.disabled = true;
  try {
    const data = act === 'del' ? await api(`posts/${id}`, 'DELETE') : await api(`posts/${id}/${act}`, 'POST');
    drawPosts(data);
    if (act === 'send') setMsg('msg', 'Sent', 'ok');
  } catch (err) {
    setMsg('msg', err.message, 'err');
    loadPosts();
  }
}
$('schedList').onclick = postAction;
$('qList').onclick = postAction;

let qSettingsDrawn = false;
function drawQueueSettings(s) {
  if (!qSettingsDrawn) {
    $('qInterval').innerHTML = INTERVALS.map((m) => `<option value="${m}">every ${fmtInterval(m)}</option>`).join('');
    const hours = [...Array(24).keys()].map((h) => `<option value="${h}">${fmtHour(h)}</option>`).join('');
    $('qStart').innerHTML = hours;
    $('qEnd').innerHTML = hours;
    qSettingsDrawn = true;
  }
  if (!INTERVALS.includes(s.intervalMin) && ![...$('qInterval').options].some((o) => Number(o.value) === s.intervalMin)) {
    $('qInterval').insertAdjacentHTML('beforeend', `<option value="${s.intervalMin}">every ${fmtInterval(s.intervalMin)}</option>`);
  }
  $('qInterval').value = s.intervalMin;
  $('qStart').value = s.startHour;
  $('qEnd').value = s.endHour;
  $('qPause').textContent = s.paused ? 'Resume' : 'Pause';
}

async function saveQueue(patch) {
  try { drawPosts(await api('queue/settings', 'POST', patch)); } catch (err) { setMsg('msg', err.message, 'err'); }
}
$('qInterval').onchange = () => saveQueue({ intervalMin: Number($('qInterval').value) });
$('qStart').onchange = () => saveQueue({ startHour: Number($('qStart').value) });
$('qEnd').onchange = () => saveQueue({ endHour: Number($('qEnd').value) });
$('qPause').onclick = () => saveQueue({ paused: !me.queue.paused });

// ---------- WhatsApp link ----------

const WA_LABEL = {
  connected: ['on', 'Connected'],
  connecting: ['wait', 'Connecting…'],
  needs_link: ['off', 'Not linked'],
  pairing: ['wait', 'Waiting for you to enter the code…'],
};
let lastWaState = null;

async function loadWhatsApp() {
  let wa;
  try { wa = await api('whatsapp'); } catch { return; }
  lastWa = wa;
  const [dot, label] = WA_LABEL[wa.state] || ['off', wa.state];
  let text = escapeHtml(label);
  if (wa.state === 'connected' && wa.phone) text += ` as <b>+${escapeHtml(wa.phone)}</b>`;
  if (wa.error) text += ` · <span class="err">${escapeHtml(wa.error)}</span>`;
  if (wa.dryRun) text += ' <span class="chip c-amber">Test mode</span>';
  $('waStatus').innerHTML = `<span class="dot ${dot}"></span><span>${text}</span>`;
  $('waPill').innerHTML = `<span class="dot ${dot}"></span>WhatsApp`;
  $('waPill').title = label;
  $('waLink').hidden = !['needs_link', 'pairing'].includes(wa.state);
  $('waUnlinkRow').hidden = wa.state !== 'connected';
  $('pairCode').hidden = !wa.pairingCode;
  if (wa.pairingCode) $('code').textContent = wa.pairingCode.replace(/^(.{4})(.{4})$/, '$1-$2');
  if (wa.state !== lastWaState) {
    lastWaState = wa.state;
    if (wa.state === 'connected') loadGroups(); else $('groupPick').hidden = true;
  }
}

$('pair').onclick = async () => {
  $('pair').disabled = true;
  $('waStatus').textContent = 'Getting a code…';
  try {
    await api('whatsapp/pair', 'POST', { phone: $('phone').value });
    await loadWhatsApp();
  } catch (err) {
    $('waStatus').innerHTML = `<span class="dot off"></span><span class="err">${escapeHtml(err.message)}</span>`;
  } finally {
    $('pair').disabled = false;
  }
};

$('unlink').onclick = async () => {
  if (!confirm('Unlink WhatsApp? Scheduled posts will wait until you link again.')) return;
  await api('whatsapp/unlink', 'POST').catch((err) => alert(err.message));
  loadWhatsApp();
};

// ---------- Account + billing ----------

function drawAccount() {
  $('sName').value = me.name || '';
  $('sFooter').value = me.footer || '';
  const zones = Intl.supportedValuesOf?.('timeZone') ?? [me.timeZone];
  if (!zones.includes(me.timeZone)) zones.unshift(me.timeZone);
  $('sTz').innerHTML = zones.map((z) => `<option ${z === me.timeZone ? 'selected' : ''}>${escapeHtml(z)}</option>`).join('');

  $('billingCard').hidden = false;
  const fmt = (p) => `<ul>
      <li>${p.postsPerMonth.toLocaleString()} posts a month</li>
      <li>${p.maxPending.toLocaleString()} waiting at once</li>
      <li>${p.maxTargets} groups/channels</li>
      <li>${p.recurring ? 'Repeating posts (daily / weekly)' : 'No repeating posts'}</li>
    </ul>`;
  if (!cfg.billingEnabled) {
    $('planInfo').innerHTML = `<div class="beta"><span class="t-ic">${icon('star')}</span><div>
      <b>Everything is unlocked, free,</b> while ${escapeHtml(cfg.appName)} is in beta.<br>
      <span class="muted">This month: ${me.usage.created} post${me.usage.created === 1 ? '' : 's'}.</span></div></div>`;
    $('plans').innerHTML = '';
    $('upgrade').hidden = $('manageBilling').hidden = true;
    return;
  }
  const pct = Math.min(100, Math.round((me.usage.created / me.limits.postsPerMonth) * 100));
  $('planInfo').innerHTML = `You're on <b>${escapeHtml(me.limits.label)}</b>${me.subscription && me.plan === 'pro' ? ` <span class="muted">(${escapeHtml(me.subscription.replace('_', ' '))})</span>` : ''}.
    <div class="usage"><div class="usage-bar"><span style="width:${pct}%"></span></div>
    <span class="muted">${me.usage.created} of ${me.limits.postsPerMonth.toLocaleString()} posts used this month</span></div>`;
  $('plans').innerHTML = Object.entries(cfg.plans).map(([id, p]) => `<div class="plan ${id === me.plan ? 'current' : ''}">
      <h3>${escapeHtml(p.label)} ${id === me.plan ? '<span class="badge">Current</span>' : id === 'pro' ? '<span class="badge pro">Best</span>' : ''}</h3>
      <div class="price">${id === 'pro' ? escapeHtml(cfg.proPriceLabel) : 'Free forever'}</div>${fmt(p)}</div>`).join('');
  $('upgrade').hidden = me.plan === 'pro';
  $('manageBilling').hidden = !me.canManageBilling;
}

$('upgrade').onclick = async () => {
  $('upgrade').disabled = true;
  try { location.href = (await api('billing/checkout', 'POST')).url; }
  catch (err) { setMsg('billingMsg', err.message, 'err'); $('upgrade').disabled = false; }
};
$('manageBilling').onclick = async () => {
  try { location.href = (await api('billing/portal', 'POST')).url; }
  catch (err) { setMsg('billingMsg', err.message, 'err'); }
};

$('saveSettings').onclick = async () => {
  try {
    me = (await api('me/settings', 'POST', { name: $('sName').value, footer: $('sFooter').value, timeZone: $('sTz').value })).user;
    drawMe();
    loadPosts();
    setMsg('settingsMsg', 'Saved', 'ok');
  } catch (err) { setMsg('settingsMsg', err.message, 'err'); }
};

$('changePw').onclick = async () => {
  try {
    await api('me/password', 'POST', { current: $('pwCur').value, next: $('pwNew').value });
    $('pwCur').value = $('pwNew').value = '';
    setMsg('pwMsg', 'Password changed. Other devices were logged out.', 'ok');
  } catch (err) { setMsg('pwMsg', err.message, 'err'); }
};

$('deleteAccount').onclick = async () => {
  if (!confirm('Really delete your account and all scheduled posts?')) return;
  try {
    await api('me', 'DELETE', { password: $('delPw').value });
    showAuth();
  } catch (err) { setMsg('delMsg', err.message, 'err'); }
};

// ---------- Admin ----------

async function loadAdmin() {
  if (!me.isAdmin) return;
  try {
    const { users, billingEnabled } = await api('admin/users');
    const pro = users.filter((u) => u.plan === 'pro').length;
    const paying = users.filter((u) => ['active', 'trialing', 'past_due'].includes(u.subscription)).length;
    $('adminSummary').textContent = `${users.length} account${users.length === 1 ? '' : 's'}${billingEnabled ? ` · ${pro} on Pro · ${paying} paying` : ' · billing is off, everyone has Pro'}`;
    const waDot = { connected: 'on', connecting: 'wait', pairing: 'wait' };
    $('adminTable').innerHTML = `<tr><th>Account</th><th>Plan</th><th>WhatsApp</th><th>Posts</th><th></th></tr>` +
      users.map((u) => `<tr data-id="${u.id}">
        <td><b>${escapeHtml(u.email)}</b>${u.isAdmin ? ' <span class="chip c-green">Admin</span>' : ''}${u.disabled ? ' <span class="chip c-red">Disabled</span>' : ''}<br>
          <span class="muted">${escapeHtml(u.name || '')} · joined ${new Date(u.createdAt).toLocaleDateString()}${u.lastLoginAt ? ` · seen ${new Date(u.lastLoginAt).toLocaleDateString()}` : ''}</span></td>
        <td><span class="chip ${u.plan === 'pro' ? 'c-violet' : 'c-gray'}">${escapeHtml(u.plan === 'pro' ? 'Pro' : 'Free')}</span>${u.subscription ? ` <span class="muted">${escapeHtml(u.subscription)}</span>` : ''}<br>
          <select class="inline" data-act="plan" aria-label="Plan override" style="margin-top:8px">
            <option value="" ${u.planOverride ? '' : 'selected'}>auto</option>
            <option value="pro" ${u.planOverride === 'pro' ? 'selected' : ''}>give Pro</option>
            <option value="free" ${u.planOverride === 'free' ? 'selected' : ''}>force Free</option>
          </select></td>
        <td><span style="display:inline-flex;align-items:center;gap:8px"><span class="dot ${waDot[u.whatsapp] || 'off'}"></span>${escapeHtml(u.whatsapp.replace('_', ' '))}</span><br><span class="muted">${u.targets} target${u.targets === 1 ? '' : 's'}</span></td>
        <td>${u.pending} waiting<br><span class="muted">${u.postsThisMonth} this month</span></td>
        <td><div class="lbtns">
          <button type="button" data-act="reset">Reset password</button>
          ${u.isAdmin ? '' : `<button type="button" data-act="disable">${u.disabled ? 'Enable' : 'Disable'}</button>`}
        </div></td>
      </tr>`).join('');
  } catch (err) { setMsg('adminMsg', err.message, 'err'); }
}

$('adminTable').onchange = async (e) => {
  if (e.target.dataset.act !== 'plan') return;
  const id = e.target.closest('tr').dataset.id;
  try { await api(`admin/users/${id}`, 'POST', { planOverride: e.target.value || null }); setMsg('adminMsg', 'Plan updated', 'ok'); loadAdmin(); }
  catch (err) { setMsg('adminMsg', err.message, 'err'); }
};
$('adminTable').onclick = async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const email = tr.querySelector('b').textContent;
  try {
    if (btn.dataset.act === 'reset') {
      if (!confirm(`Reset the password for ${email}? They'll be logged out everywhere.`)) return;
      const { tempPassword } = await api(`admin/users/${tr.dataset.id}/reset-password`, 'POST');
      prompt(`Temporary password for ${email} — send it to them, they can change it under Account:`, tempPassword);
    } else {
      const disable = btn.textContent === 'Disable';
      if (!confirm(`${disable ? 'Disable' : 'Enable'} ${email}?${disable ? ' Their scheduled posts stop until re-enabled.' : ''}`)) return;
      await api(`admin/users/${tr.dataset.id}`, 'POST', { disabled: disable });
    }
    loadAdmin();
  } catch (err) { setMsg('adminMsg', err.message, 'err'); }
};

// ---------- Polling + boot ----------

let timers = [];
function startPolling() {
  stopPolling();
  timers = [setInterval(loadWhatsApp, 4000), setInterval(loadPosts, 30000)];
}
function stopPolling() {
  timers.forEach(clearInterval);
  timers = [];
}

cfg = await fetch('api/config').then((r) => r.json()).catch(() => ({}));
$('authTitle').textContent = cfg.appName || 'Auto Poster';
document.title = cfg.appName || 'Auto Poster';
if (!cfg.signupsOpen) $('tabSignup').hidden = true;
try {
  me = (await api('me')).user;
  showApp();
} catch {
  setAuthTab(location.hash === '#/signup' && cfg.signupsOpen);
  showAuth();
}
