import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const TIER_SESSIONS = { essential: 4, committed: 8, elite: 12, champion: 20, eliteplus: 8 }

function send(to, subject, html) {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Next Step Boxing & Fitness <noreply@nextstepboxingnfitness.com>',
      to: [to], subject, html,
    }),
  })
}

export async function POST(request) {
  try {
    const { memberId } = await request.json()
    const { data: member } = await supabase.from('members').select('*').eq('id', memberId).single()
    if (!member) return Response.json({ error: 'Member not found' }, { status: 404 })

    const { data: admin } = await supabase.from('admins').select('email').limit(1).single()
    const trainerEmail = admin && admin.email
    const firstName = (member.name || '').split(' ')[0] || 'there'
    const sessions = TIER_SESSIONS[member.tier] || ''
    const renewDate = member.billing_date
      ? new Date(member.billing_date).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
      : 'your next renewal'

    // Email to the client (turns "out of sessions" into an add-on opportunity)
    const clientHtml = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#15171C">
        <h2>Nice work, ${firstName} — you've used all your sessions this month!</h2>
        <p>That's real commitment. Your membership renews on <b>${renewDate}</b> with a fresh ${sessions} sessions.</p>
        <p>Want to keep the momentum going before then? We can add extra sessions to carry you through.
           Just reply to this email and we'll set it up.</p>
        <p style="color:#6A7180;font-size:13px;margin-top:24px">— Health Is True Wealth</p>
      </div>`

    await send(member.email, `You're out of sessions this month, ${firstName}`, clientHtml)

    // Heads-up to the trainer
    if (trainerEmail) {
      const trainerHtml = `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#15171C">
          <p><b>${member.name}</b> (${member.email}) has used all ${sessions} sessions on the ${member.tier} plan this month.</p>
          <p>Renews ${renewDate}. Might be a good moment to reach out about add-on sessions.</p>
        </div>`
      await send(trainerEmail, `${member.name} used all their sessions`, trainerHtml)
    }

    return Response.json({ sent: true })
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 })
  }
}
