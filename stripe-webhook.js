import Stripe from 'stripe'
export const runtime = 'nodejs'
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

export async function POST(request) {
  try {
    const { customerId } = await request.json()
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.APP_URL,
    })
    return Response.json({ url: session.url })
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 })
  }
}
