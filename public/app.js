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
// An error from the server; plan-limit errors get a link to the plans.
function showErr(id, err) {
  setMsg(id, err.message, 'err');
  if (err.status === 402 && cfg.billingEnabled) $(id).insertAdjacentHTML('beforeend', ' <a href="#/account/plan">See plans →</a>');
}

const icon = (name) => `<svg class="i"><use href="#i-${name}"/></svg>`;
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Auth ----------

let signup = false;
let authMode = 'login'; // login | signup | forgot | reset
let resetToken = null;
function setAuthMode(mode) {
  authMode = mode;
  signup = mode === 'signup';
  const tabs = mode === 'login' || mode === 'signup';
  $('tabLogin').parentElement.hidden = !tabs;
  $('tabLogin').setAttribute('aria-pressed', String(mode === 'login'));
  $('tabSignup').setAttribute('aria-pressed', String(signup));
  $('nameWrap').hidden = !signup;
  $('emailWrap').hidden = mode === 'reset';
  $('aEmail').disabled = mode === 'reset';
  $('pwWrap').hidden = mode === 'forgot';
  $('aPw').disabled = mode === 'forgot';
  $('aPwLabel').textContent = mode === 'reset' ? 'New password' : 'Password';
  $('aPw').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('forgotLink').hidden = mode !== 'login' || !cfg.mailEnabled;
  $('backToLogin').hidden = tabs;
  $('termsNote').hidden = !signup;
  $('authBtn').textContent = { login: 'Log in', signup: 'Create account', forgot: 'Email me a reset link', reset: 'Save new password' }[mode];
  $('authHeading').textContent = { login: 'Welcome back', signup: 'Create your account', forgot: 'Reset your password', reset: 'Choose a new password' }[mode];
  $('authSub').textContent = {
    login: 'Log in to your account.',
    signup: cfg.trialDays ? `Every Pro feature free for ${cfg.trialDays} days. No card needed.` : 'Free to start. No card needed.',
    forgot: 'Enter your email and we’ll send you a link.',
    reset: 'At least 8 characters.',
  }[mode];
  setMsg('authMsg', '');
}
const setAuthTab = (isSignup) => setAuthMode(isSignup ? 'signup' : 'login');
$('forgotLink').onclick = (e) => { e.preventDefault(); setAuthMode('forgot'); };
$('backToLogin').onclick = (e) => { e.preventDefault(); history.replaceState(null, '', location.pathname); setAuthMode('login'); };

// A referral link (?ref=code) is remembered until the visitor signs up.
const refParam = new URLSearchParams(location.search).get('ref');
if (refParam) store.set('ref', refParam);

// Landing-page buttons jump to the form on the right tab.
function goAuth(isSignup) {
  if (isSignup && !cfg.signupsOpen) { setAuthTab(false); setMsg('authMsg', 'Sign-ups are closed right now.', 'warn'); }
  else setAuthTab(isSignup);
  $('authPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $(isSignup && cfg.signupsOpen ? 'aName' : 'aEmail').focus({ preventScroll: true });
}
$('navLogin').onclick = () => goAuth(false);
$('navSignup').onclick = () => goAuth(true);
$('finalSignup').onclick = () => goAuth(true);

const planFeatures = (p, paid = p.recurring) => `<ul>
    <li>${p.postsPerMonth.toLocaleString()} posts a month</li>
    <li>${p.maxPending.toLocaleString()} waiting at once</li>
    <li>${p.maxTargets} groups, channels or Status</li>
    <li class="${p.recurring ? '' : 'no'}">${p.recurring ? 'Repeating posts (daily to monthly)' : 'No repeating posts'}</li>
    <li class="${paid ? '' : 'no'}">Link click tracking${cfg.aiEnabled ? ' and AI writer' : ''}</li>
    <li class="${paid ? '' : 'no'}">Post from an RSS feed</li>
    ${cfg.freeBranding ? `<li class="${paid ? '' : 'no'}">${paid ? 'No' : 'Adds a'} “Sent with ${escapeHtml(cfg.appName || '')}” line</li>` : ''}
  </ul>`;

function drawLanding() {
  const name = cfg.appName || 'Auto Poster';
  $('authTitle').textContent = $('footTitle').textContent = name;
  const plans = cfg.plans || {};
  $('promo').hidden = !cfg.promoText;
  $('promo').textContent = cfg.promoText || '';
  if (cfg.demoVideoUrl) {
    $('demo').hidden = false;
    $('demoFrame').innerHTML = /\.(mp4|webm)(\?|$)/.test(cfg.demoVideoUrl)
      ? `<video controls preload="metadata" src="${escapeHtml(cfg.demoVideoUrl)}"></video>`
      : `<iframe src="${escapeHtml(cfg.demoVideoUrl)}" title="Demo video" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
  }
  if (!cfg.billingEnabled || !plans.free) {
    $('pricingSub').textContent = `Everything is free while ${name} is in beta.`;
    $('landingPlans').innerHTML = plans.pro ? `<div class="plan featured"><h3>Beta <span class="badge pro">Everything unlocked</span></h3>
      <div class="price">Free <small>during the beta</small></div>${planFeatures(plans.pro)}
      <button class="btn primary" type="button" data-go>Create your free account</button></div>` : '';
  } else {
    $('landingPlans').innerHTML = `<div class="plan"><h3>${escapeHtml(plans.free.label)}</h3>
        <div class="price">$0 <small>forever</small></div>${planFeatures(plans.free)}
        <button class="btn ghost" type="button" data-go>Start free</button></div>
      <div class="plan featured"><h3>${escapeHtml(plans.pro.label)} <span class="badge pro">Most popular</span></h3>
        <div class="price">${escapeHtml(cfg.priceLabels?.pro.month || cfg.proPriceLabel || '')}</div>${cfg.yearly?.pro ? `<div class="muted">or ${escapeHtml(cfg.priceLabels.pro.year)}</div>` : ''}${planFeatures(plans.pro, true)}
        <button class="btn pro" type="button" data-go>${cfg.trialDays ? `Try free for ${cfg.trialDays} days` : `Get ${escapeHtml(plans.pro.label)}`}</button></div>` +
      (plans.business ? `<div class="plan"><h3>${escapeHtml(plans.business.label)}</h3>
        <div class="price">${escapeHtml(cfg.priceLabels.business.month)}</div>${cfg.yearly?.business ? `<div class="muted">or ${escapeHtml(cfg.priceLabels.business.year)}</div>` : ''}${planFeatures(plans.business, true)}
        <button class="btn ghost" type="button" data-go>Start free</button></div>` : '');
    if (plans.business) $('landingPlans').style.maxWidth = '1072px';
  }
  for (const b of $('landingPlans').querySelectorAll('[data-go]')) b.onclick = () => goAuth(true);
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
    if (authMode === 'forgot') {
      await api('forgot', 'POST', { email: $('aEmail').value });
      return setMsg('authMsg', 'If that email has an account, a reset link is on its way.', 'ok');
    }
    let data;
    if (authMode === 'reset') {
      data = await api('reset', 'POST', { token: resetToken, password: $('aPw').value });
      history.replaceState(null, '', `${location.pathname}#/`);
    } else {
      const body = { email: $('aEmail').value, password: $('aPw').value };
      if (signup) Object.assign(body, { name: $('aName').value, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ref: store.get('ref') || undefined });
      data = await api(signup ? 'signup' : 'login', 'POST', body);
    }
    $('aPw').value = '';
    me = data.user;
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
  applyPrefs(null);
  $('appView').hidden = true;
  $('authView').hidden = false;
}

// ---------- Views ----------

const SECTIONS = ['overview', 'profile', 'posting', 'appearance', 'plan', 'refer', 'security', 'data'];
let section = 'overview';

function route() {
  if (!me) return; // logged out: the hash is just a link within the landing page
  const [view, sub] = location.hash.replace(/^#\/?/, '').split('/');
  const name = ['account', 'admin'].includes(view) ? view : 'dash';
  section = name === 'account' && SECTIONS.includes(sub) ? sub : 'overview';
  $('dashView').hidden = name !== 'dash';
  $('accountView').hidden = name !== 'account';
  $('adminView').hidden = name !== 'admin';
  for (const a of document.querySelectorAll('nav a[data-view]')) {
    a.toggleAttribute('aria-current', a.dataset.view === name);
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
  }
  if (name === 'account') drawAccount();
  if (name === 'admin') loadAdmin();
  if (name !== lastView) window.scrollTo(0, 0);
  lastView = name;
}
let lastView = null;
window.addEventListener('hashchange', route);

function showApp() {
  $('authView').hidden = true;
  $('appView').hidden = false;
  if (!/^#\//.test(location.hash)) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  const dw = me.prefs?.defaultWhen;
  if (dw && dw !== 'last') when = dw;
  drawMe();
  route();
  loadPosts();
  loadWhatsApp();
  loadLinks();
  clearImage();
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
  try { me = (await api('me')).user; drawMe(); if (!$('accountView').hidden) drawAccount(); } catch {}
}

const initials = (u) => ((u.name || u.email || '?').trim().split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();

// Theme and density follow the account; mirrored locally so the next page
// load paints correctly before the account has loaded.
function applyPrefs(prefs) {
  const theme = prefs?.theme ?? store.get('theme') ?? 'system';
  const compact = prefs ? !!prefs.compact : store.get('compact') === '1';
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  if (compact) document.documentElement.dataset.density = 'compact';
  else delete document.documentElement.dataset.density;
  if (prefs) { store.set('theme', theme); store.set('compact', compact ? '1' : '0'); }
}

function drawMe() {
  document.title = cfg.appName || 'Auto Poster';
  $('appName').textContent = cfg.appName || 'Auto Poster';
  $('adminLink').hidden = !me.isAdmin;
  $('planBadge').hidden = !cfg.billingEnabled;
  $('planBadge').textContent = me.limits.label;
  $('planBadge').className = `badge ${me.paid ? 'pro' : ''}`;
  // Trial countdown, or a heads-up when this month's posts are nearly used.
  const left = me.trialEndsAt ? Math.max(1, Math.ceil((me.trialEndsAt - Date.now()) / 864e5)) : 0;
  const used = me.usage.created / me.limits.postsPerMonth;
  $('trialBar').hidden = !cfg.billingEnabled || !(left || (used >= 0.8 && me.plan !== 'business'));
  $('trialText').textContent = left ? `Your free Pro trial ends in ${left} day${left === 1 ? '' : 's'}.`
    : `You’ve used ${me.usage.created} of ${me.limits.postsPerMonth.toLocaleString()} posts this month.`;
  drawTemplates();
  $('aiBtn').hidden = !cfg.aiEnabled;
  $('trackPro').hidden = me.paid;
  $('avatar').textContent = initials(me);
  $('avatar').title = me.email;
  applyPrefs(me.prefs);
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
  if ($('pollOn').checked) return text;
  return [text, me?.footer, me?.branding].filter(Boolean).join('\n\n');
}

function renderPreview() {
  const cap = caption();
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const picked = me ? me.targets.filter((t) => selected.has(t.id)) : [];
  const statusOnly = !imageData && picked.length > 0 && picked.every((t) => t.kind === 'status');
  $('preview').classList.toggle('status-bubble', statusOnly);
  $('preview').style.setProperty('--status-bg', (editingStatus && statusColor) || picked[0]?.color || '#128c7e');
  const pollOpts = $('pollOn').checked ? $('pollOpts').value.split('\n').map((x) => x.trim()).filter(Boolean) : [];
  $('trackWrap').hidden = !/https?:\/\//.test($('text').value);
  $('preview').innerHTML =
    (imageData?.startsWith('data:image/') ? `<img src="${imageData}" alt="Post image" />` : imageData ? `<div class="cap"><span class="file-chip">${icon('image')}${escapeHtml(fileName || 'Attachment')}</span></div>` : '') +
    `<div class="cap">${waFormat(cap) || '<span style="opacity:.5">Your post…</span>'}</div>` +
    (pollOpts.length ? `<div class="cap">${pollOpts.map((o) => `◯ ${escapeHtml(o)}`).join('<br>')}</div>` : '') +
    `<div class="time">${time}</div>`;
  $('count').textContent = `${cap.length} characters`;
}

// Image: pick / drop / paste, resized client-side (max 1600px JPEG).
let fileName = null;
async function loadImage(file) {
  if (!file) return;
  if (file.type === 'video/mp4' || file.type === 'application/pdf') {
    if (file.size > 16 * 1024 * 1024) return setMsg('msg', 'That file is too big (max 16 MB)', 'err');
    imageData = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    fileName = file.name;
    $('dropInner').innerHTML = `<div><span class="file-chip">${icon('image')}${escapeHtml(file.name)}</span><br><small>Tap to change · <a href="#" id="rmImg">Remove</a></small></div>`;
    $('rmImg').onclick = (e) => { e.preventDefault(); e.stopPropagation(); clearImage(); };
    return renderPreview();
  }
  if (!file.type.startsWith('image/')) return;
  fileName = null;
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
  fileName = null;
  $('dropInner').innerHTML = `<span class="drop-ic">${icon('image')}</span><span><b>Add an image, video or PDF</b> · tap, drop or paste<br><small>Optional · JPEG, PNG, WebP, MP4 or PDF, up to 16 MB</small></span>`;
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
  } catch (err) { showErr('targetMsg', err); }
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
  if (!me.limits.recurring) { $('repeat').value = 'none'; showErr('msg', Object.assign(new Error('Repeating posts are on the Pro plan.'), { status: 402 })); }
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
  if (when === 'now' && me.prefs?.confirmNow !== false && !confirm(`Post this to ${targets.length} group${targets.length === 1 ? '' : 's'}/channel${targets.length === 1 ? '' : 's'} right now?`)) return;

  $('submit').disabled = true;
  setMsg('msg', when === 'now' ? 'Posting…' : 'Saving…');
  try {
    const poll = $('pollOn').checked ? { options: $('pollOpts').value.split('\n'), multi: $('pollMulti').checked } : undefined;
    const data = await api('posts', 'POST', {
      text: $('text').value, image: imageData, fileName, targets, when: w, repeat: $('repeat').value, poll,
      track: !$('trackWrap').hidden && $('trackOn').checked,
    });
    if (when === 'now') {
      data.sent ? setMsg('msg', 'Posted!', 'ok') : setMsg('msg', `Couldn't send yet: ${data.error}. It will retry every 5 minutes (see Scheduled).`, 'warn');
    } else {
      setMsg('msg', `${when === 'queue' ? 'Added to the queue' : 'Scheduled'} · goes out ${fmtWhen(data.eta)}`, 'ok');
    }
    $('text').value = '';
    $('pollOn').checked = false;
    $('pollOpts').value = '';
    $('pollBox').hidden = true;
    saveDraft();
    clearImage();
    drawPosts(data);
    refreshMe();
    loadLinks();
  } catch (err) {
    showErr('msg', err);
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
const REPEAT_LABEL = { daily: 'Daily', weekdays: 'Weekdays', every2: 'Every 2 days', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };

function postItem(p, i, list, isQueue) {
  const repeat = p.repeat && p.repeat !== 'none' ? `<span class="chip c-violet">${icon('repeat')}${REPEAT_LABEL[p.repeat] ?? p.repeat}</span>` : '';
  const kind = p.poll ? '<span class="chip c-teal">Poll</span>' : p.media === 'video' ? '<span class="chip c-gray">Video</span>' : p.media === 'file' ? `<span class="chip c-gray">${escapeHtml(p.fileName || 'PDF')}</span>` : '';
  const state = p.status === 'failed' ? `<span class="chip c-red">Failed</span><span class="err">${escapeHtml(p.error)}</span>`
    : p.error ? `<span class="chip c-amber">Retrying</span><span class="err">${escapeHtml(p.error)}</span>`
    : isQueue && me.queue.paused ? '<span class="chip c-gray">Paused</span>'
    : `<span class="chip ${isQueue ? 'c-violet' : 'c-blue'}">${icon('clock')}${escapeHtml(cap1(fmtWhen(p.eta)))}</span>`;
  return `<li data-id="${p.id}">
    ${p.hasImage ? `<img class="thumb" alt="" src="api/posts/${p.id}/image" loading="lazy" />` : '<div class="thumb">Aa</div>'}
    <div class="lbody">
      <div class="lwhen">${isQueue ? `<span class="chip c-gray">#${i + 1}</span>` : ''}${state}${repeat}${kind}<span>→ ${escapeHtml(p.targets.join(', ') || 'nowhere')}</span></div>
      <div class="ltext">${escapeHtml(summary(p.text))}</div>
      <div class="lbtns">
        ${isQueue ? `<button type="button" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button type="button" data-act="down" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>` : ''}
        <button type="button" data-act="send">Send now</button>
        <button type="button" data-act="copy" title="Copy this text into a new post">Copy</button>
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
  drawCalendar();
}

// ---------- Calendar ----------

const calMonth = new Date();
calMonth.setDate(1);
function drawCalendar() {
  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  $('calTitle').textContent = calMonth.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const all = [...posts.scheduled.map((p) => ({ ...p, q: false })), ...posts.queue.map((p) => ({ ...p, q: true }))].filter((p) => p.eta);
  const days = new Date(y, m + 1, 0).getDate();
  const today = new Date();
  const dow = [...Array(7).keys()].map((d) => `<div class="dow">${new Date(2024, 0, 7 + d).toLocaleDateString([], { weekday: 'short' })}</div>`).join('');
  let cells = '<div class="day out"></div>'.repeat(new Date(y, m, 1).getDay());
  for (let d = 1; d <= days; d++) {
    const list = all.filter((p) => { const e = new Date(p.eta); return e.getFullYear() === y && e.getMonth() === m && e.getDate() === d; }).sort((a, b) => a.eta - b.eta);
    const isToday = today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;
    cells += `<div class="day ${list.length ? 'has' : ''} ${isToday ? 'today' : ''}"><b>${d}</b>${
      list.slice(0, 2).map((p) => `<span class="ev ${p.q ? 'q' : ''}" title="${escapeHtml(summary(p.text))}">${new Date(p.eta).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${escapeHtml(summary(p.text))}</span>`).join('')
    }${list.length > 2 ? `<span class="more">+${list.length - 2} more</span>` : ''}</div>`;
  }
  $('cal').innerHTML = dow + cells;
}
$('calPrev').onclick = () => { calMonth.setMonth(calMonth.getMonth() - 1); drawCalendar(); };
$('calNext').onclick = () => { calMonth.setMonth(calMonth.getMonth() + 1); drawCalendar(); };

// ---------- Templates, AI writer, polls ----------

function drawTemplates() {
  const t = me.templates ?? [];
  $('tplSelect').innerHTML = `<option value="">Templates${t.length ? ` (${t.length})` : ''}</option>` + t.map((x) => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
  $('tplSelect').disabled = !t.length;
}
$('tplSelect').onchange = () => {
  const t = (me.templates ?? []).find((x) => x.id === $('tplSelect').value);
  $('tplSelect').value = '';
  if (!t) return;
  $('text').value = t.text;
  saveDraft();
  renderPreview();
};
$('tplSave').onclick = async () => {
  if (!$('text').value.trim()) return setMsg('msg', 'Write the text to save first', 'err');
  const name = prompt('Name this template:', $('text').value.trim().split('\n')[0].slice(0, 40));
  if (name === null) return;
  try { me = (await api('templates', 'POST', { name, text: $('text').value })).user; drawTemplates(); setMsg('msg', 'Template saved', 'ok'); }
  catch (err) { showErr('msg', err); }
};
$('aiBtn').onclick = () => {
  $('aiBox').hidden = !$('aiBox').hidden;
  if (!$('aiTone').options.length) $('aiTone').innerHTML = (cfg.aiTones ?? []).map((x) => `<option value="${x}">${cap1(x)}</option>`).join('');
  if (!$('aiBox').hidden) $('aiPrompt').focus();
};
$('aiGo').onclick = async () => {
  $('aiGo').disabled = true;
  setMsg('msg', 'Writing…');
  try {
    $('text').value = (await api('ai/caption', 'POST', { prompt: $('aiPrompt').value, tone: $('aiTone').value })).text;
    saveDraft();
    renderPreview();
    setMsg('msg', 'Written. Edit it as you like.', 'ok');
  } catch (err) { showErr('msg', err); } finally { $('aiGo').disabled = false; }
};
$('aiPrompt').onkeydown = (e) => { if (e.key === 'Enter') $('aiGo').click(); };
$('pollOn').onchange = () => { $('pollBox').hidden = !$('pollOn').checked; renderPreview(); };
$('pollOpts').oninput = renderPreview;

// ---------- Bulk add ----------

$('bulkBtn').onclick = () => { $('bulkBox').hidden = !$('bulkBox').hidden; setMsg('bulkMsg', ''); };
$('bulkCancel').onclick = () => { $('bulkBox').hidden = true; };
$('bulkFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) $('bulkText').value = (await f.text()).replace(/\r/g, '');
  e.target.value = '';
};
$('bulkGo').onclick = async () => {
  const targets = [...selected].filter((id) => me.targets.some((t) => t.id === id));
  if (!targets.length) return setMsg('bulkMsg', 'Tick where to post under “Send to” first', 'err');
  const items = [];
  for (const [i, raw] of $('bulkText').value.split('\n').entries()) {
    const line = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!line) continue;
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})\s*[|,;]\s*(.+)$/.exec(line);
    if (!m) { items.push({ text: line.replace(/\\n/g, '\n') }); continue; }
    const at = new Date(`${m[1]}T${m[2].padStart(5, '0')}`).getTime();
    if (!Number.isFinite(at)) return setMsg('bulkMsg', `Line ${i + 1}: that date isn’t valid`, 'err');
    items.push({ text: m[3].replace(/^"(.*)"$/, '$1').replace(/\\n/g, '\n'), at });
  }
  if (!items.length) return setMsg('bulkMsg', 'Nothing to add', 'err');
  $('bulkGo').disabled = true;
  try {
    const data = await api('posts/bulk', 'POST', { items, targets });
    drawPosts(data);
    $('bulkText').value = '';
    $('bulkBox').hidden = true;
    setMsg('msg', `Added ${data.added} post${data.added === 1 ? '' : 's'}`, 'ok');
    refreshMe();
  } catch (err) { showErr('bulkMsg', err); } finally { $('bulkGo').disabled = false; }
};

// ---------- Link clicks ----------

async function loadLinks() {
  try {
    const d = await api('links');
    $('linksCard').hidden = !d.links.length;
    $('linksTotal').textContent = `${d.total} click${d.total === 1 ? '' : 's'}`;
    $('bestHours').textContent = d.bestHours.length
      ? `Your audience clicks most around ${d.bestHours.map(fmtHour).join(', ')}. Try scheduling then.`
      : 'After 10 clicks, this shows the hours your audience is most active.';
    $('linksList').innerHTML = d.links.slice(0, 8).map((l) => `<li class="mid"><span class="count-pill" style="margin:0">${l.clicks}</span>
      <div class="lbody"><div class="ltext" style="margin:0">${escapeHtml(l.url.replace(/^https?:\/\//, ''))}</div><div class="lwhen" style="margin-top:3px">${escapeHtml(summary(l.label))}</div></div></li>`).join('');
  } catch {}
}

async function loadPosts() {
  try { drawPosts(await api('posts')); } catch {}
}

async function postAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const act = btn.dataset.act;
  if (act === 'copy') {
    const p = [...posts.scheduled, ...posts.queue].find((x) => x.id === id);
    if (p) { $('text').value = p.text; saveDraft(); renderPreview(); window.scrollTo({ top: 0, behavior: 'smooth' }); $('text').focus(); }
    return;
  }
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
  $('ovWa').innerHTML = $('waStatus').innerHTML;
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

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} minutes ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? '' : 's'} ago`;
  return fmtDate(ms);
}
const tile = (k, v, sub = '') => `<div class="tile"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div>${sub ? `<div class="s">${escapeHtml(sub)}</div>` : ''}</div>`;

function drawAccount() {
  for (const el of document.querySelectorAll('#accountView .sec')) el.hidden = el.dataset.sec !== section;
  for (const a of $('accountNav').querySelectorAll('a')) {
    if (a.dataset.sec === section) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }

  // Overview
  $('ovAvatar').textContent = initials(me);
  $('ovName').textContent = me.name || me.email.split('@')[0];
  $('ovEmail').textContent = me.email;
  $('ovChips').innerHTML =
    (cfg.billingEnabled ? `<span class="chip ${me.plan === 'pro' ? 'c-violet' : 'c-gray'}">${escapeHtml(me.limits.label)} plan</span>` : '<span class="chip c-green">Beta · everything unlocked</span>') +
    (me.isAdmin ? `<span class="chip c-green">${icon('shield')}Admin</span>` : '') +
    `<span class="chip c-gray">Joined ${fmtDate(me.createdAt)}</span>`;
  $('ovTiles').innerHTML =
    tile('Posts this month', me.usage.created.toLocaleString(), `of ${me.limits.postsPerMonth.toLocaleString()}`) +
    tile('Waiting to send', (me.stats?.pending ?? 0).toLocaleString(), `of ${me.limits.maxPending.toLocaleString()}`) +
    tile('Places to post', String(me.targets.length), `of ${me.limits.maxTargets}`) +
    tile('Sent all time', (me.stats?.sentTotal ?? 0).toLocaleString());

  // Profile + posting + appearance (don't overwrite a field being typed in)
  const fill = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  fill('sName', me.name || '');
  fill('sFooter', me.footer || '');
  $('emNew').placeholder = me.email;
  const zones = Intl.supportedValuesOf?.('timeZone') ?? [me.timeZone];
  if (!zones.includes(me.timeZone)) zones.unshift(me.timeZone);
  $('sTz').innerHTML = zones.map((z) => `<option ${z === me.timeZone ? 'selected' : ''}>${escapeHtml(z)}</option>`).join('');
  const prefs = me.prefs ?? {};
  $('pWhen').value = prefs.defaultWhen ?? 'last';
  $('pConfirm').checked = prefs.confirmNow !== false;
  $('pCompact').checked = !!prefs.compact;
  for (const btn of $('pTheme').querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.dataset.theme === (prefs.theme ?? 'system')));
  if (section === 'security') loadSessions();

  drawPosting();
  $('refLink').value = `${location.origin}${location.pathname}?ref=${me.referral.code}`;
  $('refTiles').innerHTML = tile('Friends signed up', String(me.referral.signups)) + tile('Upgraded', String(me.referral.paid)) + tile('Free months earned', String(me.referral.paid));
  $('refNote').textContent = me.proUntil ? `You have free Pro until ${fmtDate(me.proUntil)}.`
    : cfg.billingEnabled ? 'When someone signs up with your link and upgrades, you get 30 days of Pro free.' : 'Rewards start once paid plans are switched on.';

  $('billingCard').hidden = false;
  if (!cfg.billingEnabled) {
    $('planInfo').innerHTML = `<div class="beta"><span class="t-ic">${icon('star')}</span><div>
      <b>Everything is unlocked, free,</b> while ${escapeHtml(cfg.appName)} is in beta.<br>
      <span class="muted">This month: ${me.usage.created} post${me.usage.created === 1 ? '' : 's'}.</span></div></div>`;
    $('plans').innerHTML = '';
    $('planInterval').hidden = $('manageBilling').hidden = true;
    return;
  }
  const pct = Math.min(100, Math.round((me.usage.created / me.limits.postsPerMonth) * 100));
  const note = me.billing ? `billed ${me.billing.interval === 'year' ? 'yearly' : 'monthly'}${me.subscription === 'past_due' ? ' · payment failed, please update your card' : ''}`
    : me.trialEndsAt ? `free trial until ${fmtDate(me.trialEndsAt)}` : me.proUntil ? `free until ${fmtDate(me.proUntil)}` : '';
  $('planInfo').innerHTML = `You're on <b>${escapeHtml(me.limits.label)}</b>${note ? ` <span class="muted">(${escapeHtml(note)})</span>` : ''}.
    <div class="usage"><div class="usage-bar"><span style="width:${pct}%"></span></div>
    <span class="muted">${me.usage.created} of ${me.limits.postsPerMonth.toLocaleString()} posts used this month</span></div>`;
  const anyYearly = cfg.yearly?.pro || cfg.yearly?.business;
  $('planInterval').hidden = !anyYearly || Boolean(me.billing);
  for (const b of $('planInterval').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.interval === planInterval));
  const current = me.billing?.plan ?? (me.paid ? null : 'free');
  $('plans').innerHTML = Object.entries(cfg.plans).map(([id, p]) => {
    const yearly = planInterval === 'year' && cfg.yearly?.[id];
    const price = id === 'free' ? 'Free forever' : cfg.priceLabels[id][yearly ? 'year' : 'month'];
    const button = id === 'free' || me.billing ? '' : `<button class="btn ${id === 'pro' ? 'pro' : 'ghost'}" type="button" data-plan="${id}" data-interval="${yearly ? 'year' : 'month'}">Choose ${escapeHtml(p.label)}</button>`;
    return `<div class="plan ${id === current ? 'current' : id === 'pro' ? 'featured' : ''}">
      <h3>${escapeHtml(p.label)} ${id === current ? '<span class="badge">Current</span>' : id === 'pro' ? '<span class="badge pro">Most popular</span>' : ''}</h3>
      <div class="price">${escapeHtml(price)}</div>${planFeatures(p, id !== 'free')}${button}</div>`;
  }).join('');
  $('manageBilling').hidden = !me.canManageBilling;
}

let planInterval = 'month';
$('planInterval').onclick = (e) => {
  const b = e.target.closest('button[data-interval]');
  if (!b) return;
  planInterval = b.dataset.interval;
  drawAccount();
};
$('plans').onclick = async (e) => {
  const b = e.target.closest('button[data-plan]');
  if (!b) return;
  b.disabled = true;
  try { location.href = (await api('billing/checkout', 'POST', { plan: b.dataset.plan, interval: b.dataset.interval })).url; }
  catch (err) { setMsg('billingMsg', err.message, 'err'); b.disabled = false; }
};
$('refCopy').onclick = async () => {
  $('refLink').select();
  try { await navigator.clipboard.writeText($('refLink').value); } catch { document.execCommand('copy'); }
  $('refCopy').textContent = 'Copied';
  setTimeout(() => { $('refCopy').textContent = 'Copy'; }, 1500);
};

// Templates and feeds, on the Posting section.
function drawPosting() {
  const t = me.templates ?? [];
  $('tplList').innerHTML = t.length
    ? t.map((x) => `<li class="mid" data-id="${x.id}"><div class="lbody"><div class="ltext" style="margin:0">${escapeHtml(x.name)}</div><div class="lwhen" style="margin-top:3px">${escapeHtml(summary(x.text))}</div></div><div class="lbtns"><button type="button" data-act="del">Delete</button></div></li>`).join('')
    : '<li class="empty">No templates yet. In the composer, write a post and press Save.</li>';
  const f = me.feeds ?? [];
  $('feedPro').hidden = !cfg.billingEnabled || me.paid;
  $('feedList').innerHTML = f.map((x) => `<li class="mid" data-id="${x.id}"><div class="lbody"><div class="ltext" style="margin:0">${escapeHtml(x.url.replace(/^https?:\/\//, ''))}</div>
    <div class="lwhen" style="margin-top:3px">→ ${escapeHtml(x.targets.map((id) => me.targets.find((y) => y.id === id)?.name).filter(Boolean).join(', ') || 'nowhere')}${x.error ? ` · <span class="err">${escapeHtml(x.error)}</span>` : ''}</div></div>
    <div class="lbtns"><button type="button" data-act="del">Remove</button></div></li>`).join('');
  const picked = new Set([...$('feedTargets').querySelectorAll('input:checked')].map((i) => i.value));
  $('feedTargets').innerHTML = me.targets.length
    ? me.targets.map((x) => `<label><input type="checkbox" value="${x.id}" ${picked.has(x.id) ? 'checked' : ''} /> ${escapeHtml(x.name)}</label>`).join('')
    : '<div class="hint">Add a group or channel on the dashboard first.</div>';
}
async function removeItem(kind, e, msgId) {
  const btn = e.target.closest('button[data-act="del"]');
  if (!btn) return;
  try { me = (await api(`${kind}/${btn.closest('li').dataset.id}`, 'DELETE')).user; drawMe(); drawAccount(); }
  catch (err) { setMsg(msgId, err.message, 'err'); }
}
$('tplList').onclick = (e) => removeItem('templates', e, 'tplMsg');
$('feedList').onclick = (e) => removeItem('feeds', e, 'feedMsg');
$('feedAdd').onclick = async () => {
  $('feedAdd').disabled = true;
  setMsg('feedMsg', 'Checking the feed…');
  try {
    const targets = [...$('feedTargets').querySelectorAll('input:checked')].map((i) => i.value);
    const data = await api('feeds', 'POST', { url: $('feedUrl').value, template: $('feedTpl').value, targets });
    me = data.user;
    $('feedUrl').value = '';
    drawAccount();
    setMsg('feedMsg', `Connected. Found ${data.found} existing item${data.found === 1 ? '' : 's'}; new ones will be queued.`, 'ok');
  } catch (err) { showErr('feedMsg', err); } finally { $('feedAdd').disabled = false; }
};

$('manageBilling').onclick = async () => {
  try { location.href = (await api('billing/portal', 'POST')).url; }
  catch (err) { setMsg('billingMsg', err.message, 'err'); }
};

async function saveSettings(body, msgId, okText = 'Saved') {
  try {
    me = (await api('me/settings', 'POST', body)).user;
    drawMe();
    drawAccount();
    setMsg(msgId, okText, 'ok');
    return true;
  } catch (err) { setMsg(msgId, err.message, 'err'); return false; }
}
$('saveProfile').onclick = async () => { if (await saveSettings({ name: $('sName').value, timeZone: $('sTz').value }, 'profileMsg')) loadPosts(); };
$('saveFooter').onclick = () => saveSettings({ footer: $('sFooter').value }, 'footerMsg');
$('pWhen').onchange = async () => {
  const v = $('pWhen').value;
  if (await saveSettings({ prefs: { defaultWhen: v } }, 'postingMsg') && v !== 'last') { when = v; drawWhen(); }
};
$('pConfirm').onchange = () => saveSettings({ prefs: { confirmNow: $('pConfirm').checked } }, 'postingMsg');
$('pCompact').onchange = () => saveSettings({ prefs: { compact: $('pCompact').checked } }, 'appearanceMsg');
$('pTheme').onclick = (e) => {
  const b = e.target.closest('button[data-theme]');
  if (b) saveSettings({ prefs: { theme: b.dataset.theme } }, 'appearanceMsg');
};

$('changeEmail').onclick = async () => {
  try {
    me = (await api('me/email', 'POST', { email: $('emNew').value, password: $('emPw').value })).user;
    $('emNew').value = $('emPw').value = '';
    drawMe();
    drawAccount();
    setMsg('emailMsg', `Email changed to ${me.email}`, 'ok');
  } catch (err) { setMsg('emailMsg', err.message, 'err'); }
};

$('changePw').onclick = async () => {
  if ($('pwNew').value !== $('pwNew2').value) return setMsg('pwMsg', 'The two new passwords don’t match', 'err');
  try {
    await api('me/password', 'POST', { current: $('pwCur').value, next: $('pwNew').value });
    $('pwCur').value = $('pwNew').value = $('pwNew2').value = '';
    setMsg('pwMsg', 'Password changed. Other devices were logged out.', 'ok');
    loadSessions();
  } catch (err) { setMsg('pwMsg', err.message, 'err'); }
};

// Devices
async function loadSessions() {
  try {
    const { sessions } = await api('me/sessions');
    $('revokeOthers').hidden = sessions.length < 2;
    $('sessionList').innerHTML = sessions.map((x) => `<li class="mid" data-id="${escapeHtml(x.id)}">
      <span class="t-ic ${x.current ? 'c-green' : 'c-gray'}">${icon('device')}</span>
      <div class="lbody"><div class="ltext" style="margin:0">${escapeHtml(x.device)}${x.current ? ' <span class="chip c-green">This device</span>' : ''}</div>
        <div class="lwhen" style="margin-top:3px">${x.current ? 'Active now' : `Last active ${escapeHtml(ago(x.lastSeenAt))}`} · signed in ${escapeHtml(fmtDate(x.createdAt))}</div></div>
      ${x.current ? '' : '<div class="lbtns"><button type="button" data-act="end">Log out</button></div>'}</li>`).join('');
  } catch (err) { setMsg('sessionMsg', err.message, 'err'); }
}
$('sessionList').onclick = async (e) => {
  const btn = e.target.closest('button[data-act="end"]');
  if (!btn) return;
  try { await api(`me/sessions/${btn.closest('li').dataset.id}`, 'DELETE'); setMsg('sessionMsg', 'Logged out that device', 'ok'); loadSessions(); }
  catch (err) { setMsg('sessionMsg', err.message, 'err'); }
};
$('revokeOthers').onclick = async () => {
  if (!confirm('Log out every other device?')) return;
  try {
    const { ended } = await api('me/sessions/revoke-others', 'POST');
    setMsg('sessionMsg', `Logged out ${ended} other device${ended === 1 ? '' : 's'}`, 'ok');
    loadSessions();
  } catch (err) { setMsg('sessionMsg', err.message, 'err'); }
};

$('deleteAccount').onclick = async () => {
  if (!confirm('Really delete your account and all scheduled posts?')) return;
  try {
    await api('me', 'DELETE', { password: $('delPw').value });
    showAuth();
  } catch (err) { setMsg('delMsg', err.message, 'err'); }
};

// ---------- Admin ----------

let adminUsers = [];
async function loadAdmin() {
  if (!me.isAdmin) { location.hash = '#/'; return; }
  try {
    const { users, billingEnabled, stats } = await api('admin/users');
    adminUsers = users;
    $('adminSummary').textContent = billingEnabled ? 'Accounts, plans and activity.' : 'Billing is off, so everyone has Pro for free.';
    $('adminTiles').innerHTML =
      tile('Accounts', stats.accounts.toLocaleString(), `${stats.newThisWeek} new this week`) +
      tile('Active this week', stats.activeThisWeek.toLocaleString(), `${stats.linked} with WhatsApp linked`) +
      tile('Posts this month', stats.postsThisMonth.toLocaleString(), `${stats.waiting} waiting to send`) +
      (billingEnabled ? tile('Monthly revenue', `$${stats.mrr.toLocaleString()}`, `${stats.paying} paying · ${stats.conversion}% of accounts`)
        + tile('On trial', stats.trials.toLocaleString(), `${stats.pro} with paid features`)
        + tile('At risk', (stats.pastDue + stats.canceled).toLocaleString(), `${stats.pastDue} failed payment · ${stats.canceled} cancelled`) : '');
    const max = Math.max(1, ...stats.signupsByWeek);
    $('adminChart').innerHTML = stats.signupsByWeek.map((n, i) => `<div><span>${n}</span><i style="height:${Math.round((n / max) * 70)}px"></i><span>${i === 7 ? 'now' : `-${7 - i}w`}</span></div>`).join('');
    drawAdmin();
  } catch (err) { setMsg('adminMsg', err.message, 'err'); }
}

function drawAdmin() {
  const q = $('adminSearch').value.trim().toLowerCase();
  const f = $('adminFilter').value;
  const match = {
    all: () => true, admin: (u) => u.isAdmin, pro: (u) => u.plan !== 'free', free: (u) => u.plan === 'free',
    linked: (u) => u.whatsapp === 'connected', disabled: (u) => u.disabled,
  }[f];
  const users = adminUsers.filter((u) => match(u) && (!q || u.email.toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q)));
  const waDot = { connected: 'on', connecting: 'wait', pairing: 'wait' };
  $('adminTable').innerHTML = `<tr><th>Account</th><th>Plan</th><th>WhatsApp</th><th>Posts</th><th>Actions</th></tr>` +
    (users.map((u) => `<tr data-id="${u.id}" data-email="${escapeHtml(u.email)}">
      <td><b>${escapeHtml(u.email)}</b>${u.isYou ? ' <span class="chip c-gray">You</span>' : ''}${u.isAdmin ? ' <span class="chip c-green">Admin</span>' : ''}${u.disabled ? ' <span class="chip c-red">Disabled</span>' : ''}<br>
        <span class="muted">${escapeHtml(u.name || 'No name')} · joined ${fmtDate(u.createdAt)}${u.lastLoginAt ? ` · seen ${escapeHtml(ago(u.lastLoginAt))}` : ''}</span></td>
      <td><span class="chip ${u.plan !== 'free' ? 'c-violet' : 'c-gray'}">${cap1(u.plan)}</span>${u.trialEndsAt ? ' <span class="chip c-amber">Trial</span>' : ''}${u.subscription ? ` <span class="muted">${escapeHtml(u.subscription)}</span>` : ''}<br>
        <select class="inline" data-act="plan" aria-label="Plan override" style="margin-top:8px">
          <option value="" ${u.planOverride ? '' : 'selected'}>Automatic</option>
          <option value="pro" ${u.planOverride === 'pro' ? 'selected' : ''}>Give Pro</option>
          <option value="business" ${u.planOverride === 'business' ? 'selected' : ''}>Give Business</option>
          <option value="free" ${u.planOverride === 'free' ? 'selected' : ''}>Force Free</option>
        </select></td>
      <td><span style="display:inline-flex;align-items:center;gap:8px;white-space:nowrap"><span class="dot ${waDot[u.whatsapp] || 'off'}"></span>${escapeHtml(cap1(u.whatsapp.replace('_', ' ')))}</span><br><span class="muted">${u.targets} place${u.targets === 1 ? '' : 's'}</span></td>
      <td style="white-space:nowrap">${u.postsThisMonth} this month<br><span class="muted">${u.pending} waiting · ${u.sentTotal ?? 0} sent</span></td>
      <td><div class="lbtns" style="margin:0">
        <button type="button" data-act="reset">Reset password</button>
        ${u.isYou || u.adminByConfig ? '' : `<button type="button" data-act="admin" data-on="${u.isAdmin ? '' : '1'}">${u.isAdmin ? 'Remove admin' : 'Make admin'}</button>`}
        ${u.isAdmin ? '' : `<button type="button" data-act="disable" data-on="${u.disabled ? '' : '1'}">${u.disabled ? 'Enable' : 'Disable'}</button>`}
        ${u.isYou ? '' : '<button type="button" data-act="delete">Delete</button>'}
      </div></td>
    </tr>`).join('') || '<tr><td colspan="5" class="none">No accounts match.</td></tr>');
}
$('adminSearch').oninput = drawAdmin;
$('adminFilter').onchange = drawAdmin;

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
  const { id, email } = tr.dataset;
  const act = btn.dataset.act;
  const on = !!btn.dataset.on;
  try {
    if (act === 'reset') {
      if (!confirm(`Reset the password for ${email}? They'll be logged out everywhere.`)) return;
      const { tempPassword } = await api(`admin/users/${id}/reset-password`, 'POST');
      prompt(`Temporary password for ${email} — send it to them, they can change it under Account:`, tempPassword);
    } else if (act === 'admin') {
      if (!confirm(on ? `Make ${email} an admin? They'll be able to see and manage every account.` : `Remove admin access from ${email}?`)) return;
      await api(`admin/users/${id}`, 'POST', { isAdmin: on });
      setMsg('adminMsg', on ? `${email} is now an admin` : `${email} is no longer an admin`, 'ok');
    } else if (act === 'disable') {
      if (!confirm(`${on ? 'Disable' : 'Enable'} ${email}?${on ? ' Their scheduled posts stop until re-enabled.' : ''}`)) return;
      await api(`admin/users/${id}`, 'POST', { disabled: on });
      setMsg('adminMsg', `${email} ${on ? 'disabled' : 'enabled'}`, 'ok');
    } else if (act === 'delete') {
      if (!confirm(`Delete ${email} for good? Their posts are removed and WhatsApp is unlinked. This can't be undone.`)) return;
      await api(`admin/users/${id}`, 'DELETE');
      setMsg('adminMsg', `${email} deleted`, 'ok');
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
drawLanding();
document.title = cfg.appName || 'Auto Poster';
if (!cfg.signupsOpen) $('tabSignup').hidden = true;
try {
  me = (await api('me')).user;
  showApp();
} catch {
  const reset = /^#\/reset\/([\w-]+)$/.exec(location.hash);
  if (reset) { resetToken = reset[1]; setAuthMode('reset'); } else setAuthTab((location.hash === '#/signup' || !!refParam) && !!cfg.signupsOpen);
  showAuth();
}
