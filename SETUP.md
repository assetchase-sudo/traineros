# TrainerOS — Backend Setup

This turns the app from "runs on my screen" into a shared system: one database
everyone reads from, magic-link logins for clients, and live Stripe auto-billing.

You'll set up three accounts — **Supabase** (database + logins), **Stripe**
(billing), and **Vercel** (hosting). All have free tiers. Do them in order.

> Note: these dashboards change their button labels and layouts over time. The
> steps below describe *what* to do; if a screen looks different, search the
> current Supabase/Stripe/Vercel docs for the exact spot. Nothing here needs a
> developer, but take it one step at a time.

---

## 1. Supabase — database + logins

1. Create a free account at supabase.com and start a new project. Pick a strong
   database password and save it.
2. Open the project's **SQL Editor**, paste in everything from
   `supabase/schema.sql`, and run it. This creates your `members`, `sessions`,
   and `admins` tables with the security rules that keep each client's data
   private.
3. Go to **Project Settings → API** and copy three values — you'll paste them
   into Vercel later:
   - Project URL
   - `anon` public key
   - `service_role` secret key (keep this one private)
4. Under **Authentication → Providers**, confirm **Email** is enabled. Magic
   links work out of the box. Under **Authentication → URL Configuration**, set
   the Site URL to your Vercel URL once you have it (step 3).

---

## 2. Stripe — billing (from scratch)

1. Create an account at stripe.com. You'll start in **Test mode** (a toggle in
   the dashboard) — stay in test mode until everything works, then flip to live.
2. Create three **recurring monthly** products, one per plan. For each:
   Products → add product → recurring → monthly.
   - **Essential** — $500.00 / month
   - **Committed** — $920.00 / month
   - **Elite** — $1,260.00 / month
3. For each product, copy its **Price ID** (looks like `price_xxx`). You'll have
   three — these map to `STRIPE_PRICE_ESSENTIAL / _COMMITTED / _ELITE`.
4. Go to **Developers → API keys** and copy your **Secret key** (`sk_...`).
5. Set up the webhook (this is what makes billing automatic):
   Developers → Webhooks → add endpoint.
   - Endpoint URL: `https://YOUR-APP.vercel.app/api/stripe-webhook`
     (you'll have this URL after step 3 — you can add the webhook then)
   - Select these events: `checkout.session.completed`, `invoice.paid`,
     `invoice.payment_failed`, `customer.subscription.deleted`
   - After creating it, copy the **Signing secret** (`whsec_...`) →
     `STRIPE_WEBHOOK_SECRET`.
6. Turn on the **Customer Portal** (Settings → Billing → Customer portal) so
   clients can update their own card.

---

## 3. Vercel — deploy everything together

1. Push this project folder to a GitHub repo, then import it at vercel.com.
   Vercel auto-detects Vite and serves the `/api` functions alongside the app.
2. In the Vercel project's **Settings → Environment Variables**, add every line
   from `.env.example` with your real values:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (from Supabase step 3)
   - `SUPABASE_URL` (same URL), `SUPABASE_SERVICE_ROLE_KEY` (the secret one)
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_PRICE_ESSENTIAL`, `STRIPE_PRICE_COMMITTED`, `STRIPE_PRICE_ELITE`
   - `APP_URL` = your Vercel URL
3. Deploy. Copy your live URL, then go back and fill it into the Supabase Site
   URL (step 1.4) and the Stripe webhook endpoint (step 2.5).

---

## 4. Make yourself the admin

1. Open your live URL and sign in with **your** email (the magic link).
2. Back in Supabase → SQL Editor, run this once (use the email you signed in
   with):

   ```sql
   insert into admins (auth_user_id, email)
   select id, email from auth.users where email = 'you@youremail.com';
   ```

   That flips your account to full access — you see and manage every client,
   while each client sees only their own plan and sessions.

---

## What's built vs. what's next

**Built and ready to deploy (this package):**
- Database schema with per-client privacy rules
- Magic-link login screen
- Stripe checkout, customer portal, and the billing webhook that resets each
  client's monthly sessions when their payment goes through

**Next step (once your Supabase project is live):**
- Wiring each screen of the app — dashboard, calendar, client view — to read and
  write from Supabase instead of the browser. This is done against your live
  project so every piece is tested as it's connected.
