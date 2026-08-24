import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const TIER_SESSIONS = { essential: 4, committed: 8, elite: 12 }

export async function POST(request) {
  const sig = request.headers.get('stripe-signature')
  const raw = await request.text()
  let event
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (e) {
    return new Response(`Webhook signature failed: ${e.message}`, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object
      await supabase.from('members')
        .update({ stripe_subscription_id: s.subscription, card_on_file: true, status: 'active' })
        .eq('stripe_customer_id', s.customer)
    }
    if (event.type === 'invoice.paid') {
      const inv = event.data.object
      const { data: member } = await supabase.from('members')
        .select('*').eq('stripe_customer_id', inv.customer).single()
      if (member) {
        const next = new Date(); next.setMonth(next.getMonth() + 1)
        await supabase.from('members').update({
          sessions_remaining: TIER_SESSIONS[member.tier],
          billing_date: next.toISOString(),
          status: 'active', card_on_file: true,
        }).eq('id', member.id)
      }
    }
    if (event.type === 'invoice.payment_failed') {
      const inv = event.data.object
      await supabase.from('members').update({ status: 'paused' }).eq('stripe_customer_id', inv.customer)
    }
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object
      await supabase.from('members').update({ status: 'cancelled' }).eq('stripe_customer_id', sub.customer)
    }
    return Response.json({ received: true })
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 })
  }
}
