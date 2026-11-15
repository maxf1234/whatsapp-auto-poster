// Server-rendered public pages: terms, privacy and the search-engine landing
// pages. They share the site's stylesheet and take the app's name from config.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const LANDINGS = {
  'schedule-whatsapp-messages': {
    title: 'Schedule WhatsApp messages to groups and channels',
    lead: 'Write your message now and have it sent later, from your own number, to any group or channel you post in.',
    points: [
      ['Pick the exact time', 'Choose a date and time, or send in 30 minutes. Times follow your own time zone.'],
      ['Repeat without retyping', 'Daily, weekdays, weekly or monthly reminders go out on their own.'],
      ['Send to many places at once', 'One message can go to several groups, channels and your Status.'],
    ],
    faq: [
      ['Can WhatsApp schedule messages by itself?', 'WhatsApp has no built-in scheduler for groups or channels. {app} links to your account as a device, the same way WhatsApp Web does, and sends at the time you chose.'],
      ['Does my phone have to be online?', 'No. Once linked, messages are sent for you. Your phone only needs to connect now and then to keep the link active.'],
    ],
  },
  'whatsapp-channel-scheduler': {
    title: 'A scheduler for WhatsApp Channels',
    lead: 'Plan a week of channel updates in one sitting. Posts go out on time, with images, from the channel you already run.',
    points: [
      ['A queue that drips posts', 'Load up posts and send one every few hours, only inside the hours your followers are awake.'],
      ['See it before it goes', 'A live preview shows WhatsApp formatting exactly as followers will see it.'],
      ['Know what worked', 'Tracked links count clicks, so you learn which posts and which hours do best.'],
    ],
    faq: [['Which channels can I post to?', 'Channels your number owns or is an admin of.']],
  },
  'for/deal-channels': {
    title: 'Auto-post deals to your WhatsApp channel',
    lead: 'Run a deals or coupon channel without living in WhatsApp. Queue deals in bulk, or connect a feed and let new deals post themselves.',
    points: [
      ['Post from a feed', 'Connect an RSS feed of deals and each new item is added to your queue automatically.'],
      ['Bulk upload', 'Paste a list or upload a spreadsheet to schedule a whole day of deals in a minute.'],
      ['Count the clicks', 'Tracked links show which deals people actually open.'],
    ],
    faq: [['Will my followers be flooded?', 'No. The queue spaces posts out, and only sends inside the hours you set.']],
  },
  'for/real-estate': {
    title: 'WhatsApp scheduling for real-estate agents',
    lead: 'Keep buyers and your Status up to date with new listings and open houses, posted on schedule while you are out showing homes.',
    points: [
      ['Listings on your Status', 'Post photos and details to your WhatsApp Status at the times clients are looking.'],
      ['Open-house reminders', 'Schedule the reminder when you book the open house, then forget about it.'],
      ['Templates', 'Save your listing format once and reuse it for every property.'],
    ],
    faq: [['Do clients see a different number?', 'No. Everything is sent from your own WhatsApp number.']],
  },
  'for/communities': {
    title: 'Scheduled announcements for community groups',
    lead: 'For congregations, schools, clubs and neighbourhood groups: weekly notices and reminders that go out on time, every time.',
    points: [
      ['Weekly notices on repeat', 'Set the weekly reminder once and it goes out every week at the same time.'],
      ['Several groups at once', 'Send the same announcement to every group you manage in one go.'],
      ['Share the work', 'Write a month of announcements in advance, so nobody has to remember on the day.'],
    ],
    faq: [['Is it hard to set up?', 'No. Link your WhatsApp with a code, pick your groups, and write your first post.']],
  },
};

const LEGAL = {
  terms: ['Terms of Service', (a, c) => `
<p><i>This is a starting template. Have it checked for your country and business before you rely on it.</i></p>
<h2>1. The service</h2><p>${a} lets you schedule messages that are sent from your own WhatsApp account to groups, channels and Status that you are allowed to post in.</p>
<h2>2. Not affiliated with WhatsApp</h2><p>${a} is an independent tool. It is not made, endorsed or supported by WhatsApp or Meta. It connects to your account as a linked device. WhatsApp may limit or ban accounts that it believes break its own terms, including for automated or bulk messaging. <b>You use ${a} at your own risk and we are not responsible for any restriction or loss of your WhatsApp account.</b></p>
<h2>3. Acceptable use</h2><p>You agree to send messages only to groups, channels and people who expect to hear from you. You must not use ${a} for spam, unsolicited marketing, harassment, scams, illegal content, or anything that breaks WhatsApp's terms or the law. We may suspend accounts that do.</p>
<h2>4. Accounts</h2><p>Keep your password safe. You are responsible for what is sent from your account.</p>
<h2>5. Plans and payment</h2><p>Paid plans are billed in advance through Stripe and renew until cancelled. You can cancel any time from your account page; the plan stays active until the end of the period you paid for. Unless the law requires otherwise, payments are not refunded.</p>
<h2>6. Availability</h2><p>We work to keep ${a} running, but it is provided "as is", without a guarantee that every message will be delivered or delivered on time. Do not rely on it for anything where a missed message would cause harm.</p>
<h2>7. Liability</h2><p>To the extent the law allows, our total liability is limited to the amount you paid us in the three months before the claim.</p>
<h2>8. Changes</h2><p>We may update these terms. If the change is significant we will tell you by email or in the app.</p>
<h2>9. Contact</h2><p>${c}</p>`],
  privacy: ['Privacy Policy', (a, c) => `
<p><i>This is a starting template. Have it checked for your country and business before you rely on it.</i></p>
<h2>What we store</h2><ul>
<li><b>Your account:</b> email, name, time zone, a scrambled (hashed) password, and your settings.</li>
<li><b>Your WhatsApp link:</b> the keys that keep your number linked as a device, your phone number, and the names of the groups and channels you add. For Status posts, the contact numbers needed to deliver them.</li>
<li><b>Your posts:</b> text, images and files you schedule, until they are sent, plus a short history of recent sends.</li>
<li><b>Tracked links:</b> how many times each was clicked and at what hour. We do not record who clicked.</li>
<li><b>Billing:</b> handled by Stripe. We never see or store card numbers.</li></ul>
<h2>What we do not do</h2><p>We do not read your chats, sell your data, or message anyone on your behalf other than the posts you schedule.</p>
<h2>Other services</h2><p>Stripe processes payments. If you use the AI writer, the text you type into it is sent to our AI provider to generate the caption. Emails are sent through our email provider.</p>
<h2>Your choices</h2><p>You can download your data or delete your account at any time from the Account page. Deleting your account removes your posts and unlinks WhatsApp.</p>
<h2>Cookies</h2><p>One cookie keeps you logged in. Your browser also remembers your theme and draft. There are no advertising or tracking cookies.</p>
<h2>Contact</h2><p>${c}</p>`],
};

export const PAGE_PATHS = [...Object.keys(LEGAL), ...Object.keys(LANDINGS)];

function shell(cfg, { title, description, body, path }) {
  const app = esc(cfg.appName);
  const canonical = cfg.baseUrl ? `<link rel="canonical" href="${esc(cfg.baseUrl)}/${path}" />` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · ${app}</title><meta name="description" content="${esc(description)}" />${canonical}
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" /><link rel="stylesheet" href="/style.css" /></head>
<body><div class="landing"><header class="l-nav"><div class="l-nav-in"><a href="/" class="brand"><span class="logo">➤</span><span>${app}</span></a>
<div class="l-cta"><a class="btn ghost small" href="/">Log in</a><a class="btn primary small" href="/#/signup">Get started</a></div></div></header>
${body}
<footer class="l-foot"><span class="brand"><span class="logo sm">➤</span><span>${app}</span></span>
<span class="muted"><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · Not affiliated with WhatsApp or Meta.</span></footer></div></body></html>`;
}

export function renderPage(path, cfg) {
  const app = esc(cfg.appName);
  if (LEGAL[path]) {
    const [title, body] = LEGAL[path];
    const contact = cfg.supportEmail ? `Questions: <a href="mailto:${esc(cfg.supportEmail)}">${esc(cfg.supportEmail)}</a>` : 'Questions: contact the site owner.';
    return shell(cfg, { title, path, description: `${title} for ${cfg.appName}.`, body: `<article class="prose"><h1>${title}</h1>${body(app, contact)}</article>` });
  }
  const p = LANDINGS[path];
  if (!p) return null;
  const fill = (s) => esc(s).replaceAll('{app}', app);
  return shell(cfg, {
    title: p.title, description: p.lead, path,
    body: `<section class="hero solo"><div class="hero-copy"><h1>${fill(p.title)}</h1><p class="lead">${fill(p.lead)}</p>
<a class="btn primary lg" href="/#/signup">Start free</a></div></section>
<section class="l-section"><div class="f-grid">${p.points.map(([h, t]) => `<div class="f-card"><h3>${fill(h)}</h3><p>${fill(t)}</p></div>`).join('')}</div></section>
<section class="l-section alt"><div class="l-head"><h2>Questions</h2></div><div class="faq">${p.faq.map(([q, a]) => `<details open><summary>${fill(q)}</summary><p>${fill(a)}</p></details>`).join('')}</div></section>
<section class="l-final"><h2>Ready to stop posting by hand?</h2><a class="btn primary lg" href="/#/signup">Create your free account</a></section>`,
  });
}

export const sitemap = (cfg) => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
  ['', ...PAGE_PATHS].map((p) => `<url><loc>${esc(cfg.baseUrl)}/${p}</loc></url>`).join('')}</urlset>`;
