import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const TIER_LABELS = {
  essential: 'Essential (4 sessions/month)',
  committed: 'Committed (8 sessions/month)',
  elite: 'Elite (12 sessions/month)',
  champion: 'Champion (20 sessions/month)',
  eliteplus: 'Elite Plus (8 double sessions/month)',
}

export async function POST(request) {
  try {
    const { email, name, tier } = await request.json()
    if (!email) return Response.json({ error: 'Email required' }, { status: 400 })

    // Make sure an auth user exists for this email (ignore "already registered")
    await supabase.auth.admin.createUser({ email, email_confirm: true }).catch(() => {})

    // Generate a one-click login (magic) link that lands them in the app
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: process.env.APP_URL },
    })
    if (error) return Response.json({ error: error.message }, { status: 500 })

    const loginUrl = (data && data.properties && data.properties.action_link) || process.env.APP_URL
    const firstName = (name || '').split(' ')[0] || 'there'
    const planLabel = TIER_LABELS[tier] || 'your membership'

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#15171C">
        <h2 style="color:#15171C">Welcome to Next Step Boxing &amp; Fitness, ${firstName}!</h2>
        <p>You're all set up on the <b>${planLabel}</b> plan. Let's get you training.</p>
        <p>Click below to log in — no password needed:</p>
        <p style="text-align:center;margin:28px 0">
          <a href="${loginUrl}" style="background:#2743F0;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:bold;display:inline-block">Log in &amp; get started</a>
        </p>
        <p>Once you're in, tap <b>Set up autopay</b> to add your card and lock in your spot.</p>
        <p style="color:#6A7180;font-size:13px;margin-top:24px">If that button has expired, just go to
          <a href="${process.env.APP_URL}">${process.env.APP_URL}</a> and sign in with this email (${email}).</p>
        <p style="color:#6A7180;font-size:13px">— Health Is True Wealth</p>
      </div>`

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Next Step Boxing & Fitness <noreply@nextstepboxingnfitness.com>',
        to: [email],
        subject: `Welcome to Next Step Boxing & Fitness, ${firstName}!`,
        html,
      }),
    })

    if (!resendRes.ok) {
      const t = await resendRes.text()
      return Response.json({ error: 'Email failed: ' + t }, { status: 500 })
    }
    return Response.json({ sent: true })
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 })
  }
}
