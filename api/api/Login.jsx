import { useState } from 'react'
import { supabase } from './supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (!email.trim()) return
    setBusy(true); setErr(null)
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    })
    setBusy(false)
    if (error) setErr(error.message); else setSent(true)
  }

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.mark}>▲ TRAINER<span style={{ color: '#2743F0' }}>OS</span></div>
        {sent ? (
          <>
            <h1 style={S.h1}>Check your email</h1>
            <p style={S.p}>We sent a one-tap sign-in link to <b>{email}</b>. Open it on this device to log in.</p>
          </>
        ) : (
          <>
            <h1 style={S.h1}>Sign in</h1>
            <p style={S.p}>Enter your email and we'll send a secure login link — no password needed.</p>
            <input style={S.input} type="email" placeholder="you@email.com" value={email}
              onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
            {err && <div style={S.err}>{err}</div>}
            <button style={S.btn} onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send login link'}</button>
          </>
        )}
      </div>
    </div>
  )
}

const S = {
  wrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#E7E9ED', fontFamily: 'Inter, system-ui, sans-serif', padding: 20 },
  card: { background: '#fff', border: '1px solid #DCDFE6', borderRadius: 18, padding: 34, width: '100%', maxWidth: 380 },
  mark: { fontWeight: 700, letterSpacing: 1, marginBottom: 20, color: '#15171C' },
  h1: { fontSize: 26, margin: '0 0 8px', color: '#15171C' },
  p: { fontSize: 14, color: '#6A7180', lineHeight: 1.5, margin: '0 0 18px' },
  input: { width: '100%', border: '1px solid #DCDFE6', borderRadius: 10, padding: 12, fontSize: 15, marginBottom: 12 },
  btn: { width: '100%', background: '#2743F0', color: '#fff', border: 0, borderRadius: 10, padding: 13, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  err: { color: '#B4530A', fontSize: 13, marginBottom: 10 },
}
