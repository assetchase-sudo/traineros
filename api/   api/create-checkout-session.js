import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const PRICES = {
  essential: process.env.STRIPE_PRICE_ESSENTIAL,
  committed: process.env.STRIPE_PRICE_COMMITTED,
  elite: process.env.STRIPE_PRICE_ELITE,
}

export async function POST(request) {
  try {
    const { memberId } = await request.json()
    const { data: member } = await supabase.from('members').select('*').eq('id', memberId).single()
    if (!member) return Response.json({ error: 'Member not found' }, { status: 404 })

    let customerId = member.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: member.email, name: member.name, metadata: { member_id: member.id },
      })
      customerId = customer.id
      await supabase.from('members').update({ stripe_customer_id: customerId }).eq('id', member.id)
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: PRICES[member.tier], quantity: 1 }],
      success_url: `${process.env.APP_URL}/?checkout=success`,
      cancel_url: `${process.env.APP_URL}/?checkout=cancel`,
      metadata: { member_id: member.id },
    })
    return Response.json({ url: session.url })
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 })
  }
}
