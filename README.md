# WhatsApp Auto Poster

Schedule WhatsApp posts in advance. This is the multi-user version of the
NBA channel poster: anyone can create an account, link **their own** WhatsApp
number, and have posts go out to their groups and channels on schedule.

- **Accounts:** email and password sign-up. Passwords are hashed with scrypt,
  and sessions use an HttpOnly cookie. Each account only sees its own posts.
- **Own WhatsApp:** each account links its number once with a pairing code
  shown on the page, the same login the NBA poster uses.
- **Targets:** pick from the groups your number is in, or paste a group
  invite link or a channel link (`whatsapp.com/channel/…`). The resolving
  logic comes from the DealsPulse bot.
- **Posts:** text with WhatsApp formatting (live preview), an optional
  image, sent to one or many groups/channels at once, with an optional footer
  added to every post.
- **When:**
  - **Now**
  - **In…** N minutes / hours / days
  - **At a time:** a date and time
  - **Repeat:** every day or every week at the same local time, kept right
    across daylight-saving changes
  - **Queue:** the NBA poster's drip. One post every N hours, only inside
    your active hours (e.g. 9 AM – 11 PM), with reordering and pause.
- **Reliable sending:** if a send fails (phone offline, WhatsApp
  reconnecting), the post retries every 5 minutes. It never sends twice to a
  group it already reached. After a day of failures it is marked failed
  until you hit **Send now** or delete it.
- **Paid plans, off for now:** Free and Pro limits plus Stripe checkout are
  built in. They stay off until you set `BILLING_ENABLED=1`. Until then,
  everyone gets Pro for free.
- **Admin page:** see every account, give someone Pro, disable an account,
  or reset a password.

## Deploy on Railway

1. **New service** → this repo. It builds from the `Dockerfile` (the health
   check comes from `railway.json`).
2. **Add a volume** mounted at **`/data`**. It stores accounts, every
   WhatsApp login and all scheduled posts. Without it, a redeploy wipes
   everything.
3. Settings → Networking → **Generate Domain**.
4. **Variables** (all optional to start):

| Variable | Value |
|---|---|
| `BASE_URL` | The public URL, e.g. `https://poster.up.railway.app`. Set it once you have the domain. |
| `APP_NAME` | Name shown on the page. Default `Auto Poster`. |
| `ADMIN_EMAILS` | Emails that get the Admin page. The **first account created** is always an admin. |
| `SIGNUPS_OPEN` | `0` stops new sign-ups. Existing accounts keep working. |
| `DEFAULT_TIMEZONE` | For accounts whose browser doesn't send one. Each user can change theirs under Account. |
| `DRY_RUN` | `1` logs posts instead of sending them (for testing). |

5. Open the site and **create your account first**, so you become the admin.
   Under **WhatsApp**, enter your number → **Get pairing code** → on your
   phone: WhatsApp → Linked devices → Link a device → *Link with phone number
   instead* → type the code.

Posting to a **channel** needs the linked number to own or admin it. Posting
to a **group** needs it to be a member, and an admin if only admins can post.

## Switching on payments (later)

Nothing is charged until you do this:

1. In Stripe, create a product **Pro** with a monthly **price**, and copy its
   id (`price_…`).
2. In Stripe → Developers → **Webhooks**, add the endpoint
   `https://YOUR-SITE/api/billing/webhook` with these events:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
   Copy its signing secret (`whsec_…`).
3. Turn on the **customer portal** in Stripe (Settings → Billing → Customer
   portal), so users can cancel or change their card themselves.
4. Set these variables on Railway:

| Variable | Value |
|---|---|
| `BILLING_ENABLED` | `1` |
| `STRIPE_SECRET_KEY` | `sk_live_…` (or `sk_test_…` to try it first) |
| `STRIPE_PRICE_ID` | `price_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` |
| `PRO_PRICE_LABEL` | What the page shows, e.g. `$9 / month` |

The limits for each plan are in `PLANS` in `lib/billing.js`. Default Free:
30 posts a month, 10 waiting at once, 2 groups/channels, no repeats. Edit
that one object to change them.

When billing turns on, existing users drop to Free unless they subscribe.
That includes you, so give yourself (and anyone you want to comp) **Pro**
from the Admin page. An admin's plan choice overrides Stripe.

## How it's built

Plain Node with Baileys as the only dependency, the same as the NBA poster.
There is no database server: everything is a JSON file on the volume,
written atomically.

```
server.js           HTTP server: accounts, API, static files
lib/auth.js         password hashing, sessions, rate limiting
lib/db.js           data/db.json + data/images/<postId>
lib/whatsapp.js     one Baileys connection per account (data/wa/<userId>)
lib/scheduler.js    the 20-second tick that sends due posts for every account
lib/time.js         time zones, active hours, daily/weekly repeats, queue ETAs
lib/billing.js      plans, Stripe checkout/portal, webhook verification
public/             the page (vanilla JS)
```

All WhatsApp connections run in one process, which is fine for dozens of
accounts. Each linked number is a "linked device" on that person's phone.
WhatsApp can restrict numbers that send spammy volumes, so the queue's
spacing and active hours exist for a reason.

## Run locally

```bash
npm install
DRY_RUN=1 npm start   # http://localhost:3000
npm test
```

Locally everything is stored in `./data` (git-ignored).
