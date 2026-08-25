import React, { useState, useEffect } from "react";
import { supabase } from "./supabase";
import Login from "./Login";

/* ============================================================================
   TrainerOS — membership billing + scheduling for a solo personal trainer
   ----------------------------------------------------------------------------
   WHAT'S REAL IN THIS BUILD
   - Client roster, tiers, monthly session allowance + live session tracking
   - Built-in weekly calendar: book, complete, no-show / late-cancel, free-cancel
   - 24-hour cancellation rule enforced automatically
   - Billing engine: detects when a renewal is due, "processes" the renewal
     (resets the month's sessions, advances the billing date)
   - Persists across sessions (window.storage) with in-memory fallback
   - Two faces of the same data: Trainer (admin) and Client (what they see)

   THE ONE PIECE THAT NEEDS A SERVER (marked // STRIPE below)
   - Actually charging a saved card requires Stripe's Subscriptions API running
     on a small backend. This front-end is built to call it: every place a real
     charge would fire is marked. Swap the simulated renew for a Stripe call and
     the automation is live. The card number never touches this app.
   ========================================================================== */

const TIERS = {
  essential: { key: "essential", name: "Essential", sessions: 4,  price: 500,  per: 125 },
  committed: { key: "committed", name: "Committed", sessions: 8,  price: 920,  per: 115 },
  elite:     { key: "elite",     name: "Elite",     sessions: 12, price: 1260, per: 105 },
};

const WORK_START = 6;   // 6am
const WORK_END = 20;    // 8pm
const DAY_MS = 86400000;

/* ---- storage wrapper: real persistence, never breaks if unavailable ---- */
/* ---- map database rows <-> app shape ---- */
const fromMember = (r) => ({
  id: r.id, name: r.name, email: r.email, tier: r.tier,
  sessionsRemaining: r.sessions_remaining, billingDate: r.billing_date,
  cardOnFile: r.card_on_file, status: r.status, joined: r.joined_at,
  stripeCustomerId: r.stripe_customer_id,
});
const fromSession = (r) => ({ id: r.id, clientId: r.member_id, start: r.starts_at, status: r.status });

/* ---- date helpers ---- */
const iso = (d) => new Date(d).toISOString();
const startOfWeek = (d) => { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setHours(0,0,0,0); x.setDate(x.getDate() - day); return x; };
const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY_MS);
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const fmtDay = (d) => new Date(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
const fmtFullDay = (d) => new Date(d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const fmtTime = (d) => new Date(d).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const money = (n) => "$" + n.toLocaleString();
const uid = () => Math.random().toString(36).slice(2, 10);

export default function TrainerOS() {
  const [authChecked, setAuthChecked] = useState(false);
  const [session, setSession] = useState(null);
  const [role, setRole] = useState(null);            // trainer | client | pending
  const [clients, setClients] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState("dashboard");
  const [weekAnchor, setWeekAnchor] = useState(iso(startOfWeek(new Date())));
  const [detailId, setDetailId] = useState(null);
  const [booking, setBooking] = useState(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState(null);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(null), 2800); };

  /* auth bootstrap */
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthChecked(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  /* on sign-in: link membership, find role, load data */
  useEffect(() => {
    if (!authChecked) return;
    if (!session) { setLoading(false); setRole(null); return; }
    (async () => {
      setLoading(true);
      try {
        await supabase.rpc("claim_membership");
        const { data: admin } = await supabase.rpc("is_admin");
        const isAdmin = admin === true;
        await load(isAdmin);
        if (isAdmin) setRole("trainer");
        if (typeof window !== "undefined" && window.location.search.includes("checkout=success")) {
          setTimeout(() => { load(isAdmin); }, 4000);
          window.history.replaceState({}, "", window.location.pathname);
        }
      } catch (e) { flash("Load error: " + (e.message || e)); }
      setLoading(false);
    })();
  }, [session, authChecked]);

  const load = async (isAdmin) => {
    const { data: m, error: em } = await supabase.from("members").select("*").order("joined_at", { ascending: true });
    const { data: s, error: es } = await supabase.from("sessions").select("*");
    if (em || es) { flash("Load error: " + ((em || es).message)); return; }
    const mapped = (m || []).map(fromMember);
    setClients(mapped);
    setSessions((s || []).map(fromSession));
    if (!isAdmin) setRole(mapped.length ? "client" : "pending");
  };

  const clientOf = (id) => clients.find((c) => c.id === id);
  const activeClients = clients.filter((c) => c.status === "active");
  const mrr = activeClients.reduce((sum, c) => sum + TIERS[c.tier].price, 0);
  const now = new Date();
  const completedThisMonth = sessions.filter((s) => {
    const d = new Date(s.start);
    return s.status === "completed" && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;
  const dueClients = activeClients.filter((c) => c.billingDate && new Date(c.billingDate) <= new Date());

  /* ---- actions (write to Supabase, then reload) ---- */
  const reload = () => load(role === "trainer");

  const addClient = async (data) => {
    const tier = TIERS[data.tier];
    const { error } = await supabase.from("members").insert({
      name: data.name.trim(), email: data.email.trim(), tier: data.tier,
      sessions_remaining: tier.sessions, billing_date: iso(addDays(new Date(), 30)),
      status: "active", card_on_file: false,
    });
    setAdding(false);
    if (error) return flash(error.message);
    flash(`${data.name} added on ${tier.name}`);
    reload();
  };

  const removeClient = async (id) => {
    const c = clientOf(id);
    const { error } = await supabase.from("members").delete().eq("id", id);
    setDetailId(null);
    if (error) return flash(error.message);
    flash(`${c?.name || "Client"} removed`);
    reload();
  };

  const toggleCard = async (id) => {
    const c = clientOf(id);
    const { error } = await supabase.from("members").update({ card_on_file: !c.cardOnFile }).eq("id", id);
    if (error) return flash(error.message);
    reload();
  };

  const processRenewal = async (id) => {
    const c = clientOf(id); if (!c) return;
    const tier = TIERS[c.tier];
    const { error } = await supabase.from("members").update({
      sessions_remaining: tier.sessions, billing_date: iso(addDays(new Date(), 30)), status: "active",
    }).eq("id", id);
    if (error) return flash(error.message);
    flash(`${c.name} renewed \u00b7 ${tier.sessions} sessions`);
    reload();
  };

  const changeTier = async (id, tierKey) => {
    const { error } = await supabase.from("members").update({ tier: tierKey }).eq("id", id);
    if (error) return flash(error.message);
    reload();
  };

  const book = async ({ clientId, start }) => {
    if (sessions.some((s) => s.status === "booked" && Math.abs(new Date(s.start) - new Date(start)) < 3600000)) {
      return flash("That time is already booked");
    }
    const { error } = await supabase.from("sessions").insert({ member_id: clientId, starts_at: iso(start), status: "booked" });
    setBooking(null);
    if (error) return flash(error.message);
    flash(`Booked ${clientOf(clientId)?.name || "session"} \u00b7 ${fmtDay(start)} ${fmtTime(start)}`);
    reload();
  };

  const setStatus = async (sid, status, consume, msg) => {
    const { error } = await supabase.rpc("set_session_status", { p_session: sid, p_status: status, p_consume: consume });
    if (error) return flash(error.message);
    flash(msg);
    reload();
  };
  const completeSession = (sid) => setStatus(sid, "completed", true, "Session completed \u2014 1 deducted");
  const noShow = (sid) => setStatus(sid, "noshow", true, "No-show / late cancel \u2014 counts as used");
  const cancelSession = (sid) => {
    const s = sessions.find((x) => x.id === sid); if (!s) return;
    const within = new Date(s.start) - new Date() < DAY_MS && new Date(s.start) > new Date();
    if (within) setStatus(sid, "noshow", true, "Inside 24h \u2014 counts as a used session");
    else setStatus(sid, "cancelled", false, "Cancelled \u2014 no session used");
  };

  const startCheckout = async (memberId) => {
    try {
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId }),
      });
      const data = await res.json();
      if (data.url) { window.location.href = data.url; }
      else { flash(data.error || "Could not start checkout"); }
    } catch (e) { flash("Checkout error: " + (e.message || e)); }
  };

  const signOut = async () => { await supabase.auth.signOut(); setRole(null); setClients([]); setSessions([]); };

  /* ---- render ---- */
  if (!authChecked) return <Shell><Splash text="Starting up\u2026" /></Shell>;
  if (!session) return <Login />;
  if (loading) return <Shell><Splash text="Loading your studio\u2026" /></Shell>;
  if (role === "pending") return <Shell><Splash text="You're signed in, but your trainer hasn't set up your membership yet. Once they add you, refresh this page." /></Shell>;

  if (role === "client") {
    const me = clients[0];
    return (
      <Shell>
        <TopBar role="client" name={me?.name} onSignOut={signOut} />
        <ClientView client={me} sessions={sessions.filter((s) => s.clientId === me.id)}
          onBook={() => setBooking({ clientId: me.id })} onCancel={cancelSession}
          onAutopay={() => startCheckout(me.id)} />
        {booking && <BookingModal booking={booking} clients={clients} clientOf={clientOf} onBook={book} onClose={() => setBooking(null)} />}
        {toast && <div className="tos-toast">{toast}</div>}
        <StyleTag />
      </Shell>
    );
  }

  return (
    <Shell>
      <TopBar role="trainer" mrr={mrr} onSignOut={signOut} />
      <div className="tos-body">
        <nav className="tos-nav">
          {[["dashboard","Dashboard"],["clients","Clients"],["calendar","Calendar"]].map(([k,label]) => (
            <button key={k} className={"tos-navbtn" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>

        {tab === "dashboard" && (
          <Dashboard mrr={mrr} activeCount={activeClients.length} completedThisMonth={completedThisMonth}
            dueClients={dueClients} clients={activeClients} sessions={sessions}
            onProcess={processRenewal} clientOf={clientOf} onOpen={(id) => { setDetailId(id); setTab("clients"); }} />
        )}
        {tab === "clients" && <Clients clients={clients} onAdd={() => setAdding(true)} onOpen={setDetailId} />}
        {tab === "calendar" && (
          <Calendar weekAnchor={weekAnchor} setWeekAnchor={setWeekAnchor} sessions={sessions} clientOf={clientOf}
            onSlot={(dateStr, hour) => setBooking({ dateStr, hour })}
            onComplete={completeSession} onNoShow={noShow} onCancel={cancelSession} />
        )}
      </div>

      {detailId && (
        <ClientDetail client={clientOf(detailId)} sessions={sessions.filter((s) => s.clientId === detailId)}
          onClose={() => setDetailId(null)} onRemove={removeClient} onCard={toggleCard}
          onProcess={processRenewal} onTier={changeTier} onComplete={completeSession}
          onNoShow={noShow} onCancel={cancelSession} onBook={() => setBooking({ clientId: detailId })} />
      )}
      {adding && <AddClient onAdd={addClient} onClose={() => setAdding(false)} />}
      {booking && <BookingModal booking={booking} clients={activeClients} clientOf={clientOf} onBook={book} onClose={() => setBooking(null)} />}
      {toast && <div className="tos-toast">{toast}</div>}
      <StyleTag />
    </Shell>
  );
}

function Splash({ text }) { return <div className="tos-splash">{text}</div>; }

function Shell({ children }) {
  return <div className="tos-root">{children}</div>;
}

function TopBar({ role, name, mrr, onSignOut }) {
  return (
    <header className="tos-top">
      <div className="tos-brand">
        <span className="tos-mark">▲</span>
        <span className="tos-word">TRAINER<em>OS</em></span>
        {role === "trainer" && mrr != null && <span className="tos-mrr">{money(mrr)}<i>/mo recurring</i></span>}
      </div>
      <div className="tos-rolewrap">
        {name && <span className="tos-hello">{name}</span>}
        <button className="tos-signout" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}

/* --- signature element: the session "tank" — discrete pips that deplete --- */
function Tank({ remaining, total, size = "md" }) {
  const pips = [];
  for (let i = 0; i < total; i++) pips.push(i < remaining);
  return (
    <div className={"tos-tank " + size} aria-label={`${remaining} of ${total} sessions left`}>
      {pips.map((full, i) => <span key={i} className={"tos-pip" + (full ? " full" : "")} />)}
    </div>
  );
}

function Stat({ label, value, sub, accent }) {
  return (
    <div className="tos-stat">
      <div className="tos-stat-label">{label}</div>
      <div className={"tos-stat-val" + (accent ? " accent" : "")}>{value}</div>
      {sub && <div className="tos-stat-sub">{sub}</div>}
    </div>
  );
}

function Dashboard({ mrr, activeCount, completedThisMonth, dueClients, clients, sessions, onProcess, clientOf, onOpen }) {
  const upcoming = sessions
    .filter((s) => s.status === "booked" && new Date(s.start) >= new Date())
    .sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, 6);
  const noCard = clients.filter((c) => !c.cardOnFile);
  const lowSessions = clients.filter((c) => c.sessionsRemaining <= 1);

  return (
    <div className="tos-page">
      <div className="tos-stats">
        <Stat label="Recurring revenue" value={money(mrr)} sub="guaranteed monthly" accent />
        <Stat label="Active members" value={activeCount} sub="on membership" />
        <Stat label="Sessions delivered" value={completedThisMonth} sub="this month" />
        <Stat label="Renewals due" value={dueClients.length} sub={dueClients.length ? "action needed" : "all current"} />
      </div>

      {(dueClients.length > 0 || noCard.length > 0 || lowSessions.length > 0) && (
        <section className="tos-card">
          <h3 className="tos-h3">Needs attention</h3>
          <div className="tos-alerts">
            {dueClients.map((c) => (
              <div key={c.id} className="tos-alert due">
                <div><b>{c.name}</b> · renewal due {fmtDate(c.billingDate)} · {money(TIERS[c.tier].price)}</div>
                <button className="tos-btn sm" onClick={() => onProcess(c.id)}>Process renewal</button>
              </div>
            ))}
            {noCard.map((c) => (
              <div key={c.id} className="tos-alert warn">
                <div><b>{c.name}</b> · no card on file — can't auto-charge</div>
                <button className="tos-btn ghost sm" onClick={() => onOpen(c.id)}>Open</button>
              </div>
            ))}
            {lowSessions.map((c) => (
              <div key={c.id} className="tos-alert soft">
                <div><b>{c.name}</b> · {c.sessionsRemaining} session{c.sessionsRemaining === 1 ? "" : "s"} left this month</div>
                <button className="tos-btn ghost sm" onClick={() => onOpen(c.id)}>Open</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="tos-card">
        <h3 className="tos-h3">Next sessions</h3>
        {upcoming.length === 0 ? (
          <div className="tos-empty">Nothing booked yet. Open the calendar to schedule.</div>
        ) : (
          <ul className="tos-agenda">
            {upcoming.map((s) => (
              <li key={s.id}>
                <span className="tos-agenda-time">{fmtDay(s.start)} · {fmtTime(s.start)}</span>
                <span className="tos-agenda-name">{clientOf(s.clientId)?.name || "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Clients({ clients, onAdd, onOpen }) {
  return (
    <div className="tos-page">
      <div className="tos-rowhead">
        <h3 className="tos-h3">Members</h3>
        <button className="tos-btn" onClick={onAdd}>+ Add member</button>
      </div>
      <div className="tos-table">
        <div className="tos-tr tos-th">
          <span>Name</span><span>Plan</span><span>Sessions left</span><span>Next charge</span><span>Card</span>
        </div>
        {clients.map((c) => {
          const t = TIERS[c.tier];
          return (
            <button key={c.id} className="tos-tr" onClick={() => onOpen(c.id)}>
              <span className="tos-cell-name">{c.name}<em>{c.email}</em></span>
              <span><span className={"tos-badge " + c.tier}>{t.name}</span></span>
              <span className="tos-cell-tank"><Tank remaining={c.sessionsRemaining} total={t.sessions} size="sm" /><i>{c.sessionsRemaining}/{t.sessions}</i></span>
              <span className="tos-mono">{fmtDate(c.billingDate)}</span>
              <span>{c.cardOnFile ? <em className="tos-dot ok">on file</em> : <em className="tos-dot no">missing</em>}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Calendar({ weekAnchor, setWeekAnchor, sessions, clientOf, onSlot, onComplete, onNoShow, onCancel }) {
  const start = new Date(weekAnchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const hours = Array.from({ length: WORK_END - WORK_START }, (_, i) => WORK_START + i);
  const [openId, setOpenId] = useState(null);

  const sessionAt = (day, hour) =>
    sessions.find((s) => s.status !== "cancelled" && sameDay(s.start, day) && new Date(s.start).getHours() === hour);

  return (
    <div className="tos-page">
      <div className="tos-rowhead">
        <h3 className="tos-h3">{fmtDate(days[0])} — {fmtDate(days[6])}</h3>
        <div className="tos-weeknav">
          <button className="tos-btn ghost sm" onClick={() => setWeekAnchor(iso(addDays(start, -7)))}>← Prev</button>
          <button className="tos-btn ghost sm" onClick={() => setWeekAnchor(iso(startOfWeek(new Date())))}>Today</button>
          <button className="tos-btn ghost sm" onClick={() => setWeekAnchor(iso(addDays(start, 7)))}>Next →</button>
        </div>
      </div>

      <div className="tos-cal">
        <div className="tos-cal-corner" />
        {days.map((d) => (
          <div key={d} className={"tos-cal-dayhead" + (sameDay(d, new Date()) ? " today" : "")}>{fmtDay(d)}</div>
        ))}

        {hours.map((h) => (
          <React.Fragment key={h}>
            <div className="tos-cal-hour">{h % 12 === 0 ? 12 : h % 12}{h < 12 ? "a" : "p"}</div>
            {days.map((d) => {
              const s = sessionAt(d, h);
              if (!s) {
                const slotDate = new Date(d); slotDate.setHours(h, 0, 0, 0);
                const past = slotDate < new Date();
                return <button key={d + "-" + h} className={"tos-cal-slot" + (past ? " past" : "")} disabled={past}
                  onClick={() => onSlot(iso(d), h)} aria-label="Book this slot" />;
              }
              const c = clientOf(s.clientId);
              return (
                <div key={d + "-" + h} className={"tos-cal-ev " + s.status} onClick={() => setOpenId(openId === s.id ? null : s.id)}>
                  <b>{c?.name?.split(" ")[0] || "—"}</b>
                  <i>{s.status === "booked" ? fmtTime(s.start) : s.status}</i>
                  {openId === s.id && s.status === "booked" && (
                    <div className="tos-evmenu" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { onComplete(s.id); setOpenId(null); }}>Completed</button>
                      <button onClick={() => { onNoShow(s.id); setOpenId(null); }}>No-show</button>
                      <button onClick={() => { onCancel(s.id); setOpenId(null); }}>Cancel</button>
                    </div>
                  )}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
      <p className="tos-hint">Tap an empty slot to book. Tap a booked session to complete, mark a no-show, or cancel. Cancelling inside 24 hours counts as a used session.</p>
    </div>
  );
}

function ClientDetail({ client, sessions, onClose, onRemove, onCard, onProcess, onTier, onComplete, onNoShow, onCancel, onBook }) {
  if (!client) return null;
  const t = TIERS[client.tier];
  const upcoming = sessions.filter((s) => s.status === "booked").sort((a,b)=> new Date(a.start)-new Date(b.start));
  const history = sessions.filter((s) => s.status === "completed" || s.status === "noshow").sort((a,b)=> new Date(b.start)-new Date(a.start)).slice(0,6);
  return (
    <div className="tos-scrim" onClick={onClose}>
      <div className="tos-drawer" onClick={(e) => e.stopPropagation()}>
        <button className="tos-x" onClick={onClose}>×</button>
        <h2 className="tos-h2">{client.name}</h2>
        <div className="tos-sub">{client.email} · member since {fmtDate(client.joined)}</div>

        <div className="tos-detailtank">
          <Tank remaining={client.sessionsRemaining} total={t.sessions} />
          <span className="tos-mono lg">{client.sessionsRemaining}<em>/{t.sessions} left</em></span>
        </div>

        <div className="tos-detailgrid">
          <div><label>Plan</label>
            <select className="tos-select full" value={client.tier} onChange={(e) => onTier(client.id, e.target.value)}>
              {Object.values(TIERS).map((x) => <option key={x.key} value={x.key}>{x.name} — {x.sessions}/mo · {money(x.price)}</option>)}
            </select>
          </div>
          <div><label>Monthly</label><div className="tos-mono lg">{money(t.price)}</div></div>
          <div><label>Next charge</label><div className="tos-mono">{fmtDate(client.billingDate)}</div></div>
          <div><label>Card on file</label>
            <button className={"tos-chip " + (client.cardOnFile ? "ok" : "no")} onClick={() => onCard(client.id)}>
              {client.cardOnFile ? "On file · tap to clear" : "Missing · tap to mark added"}
            </button>
          </div>
        </div>

        <div className="tos-detailactions">
          <button className="tos-btn" onClick={() => onProcess(client.id)}>Process renewal now</button>
          <button className="tos-btn ghost" onClick={onBook}>Book session</button>
        </div>

        <h3 className="tos-h3 mt">Upcoming</h3>
        {upcoming.length === 0 ? <div className="tos-empty">No sessions booked.</div> : (
          <ul className="tos-list">
            {upcoming.map((s) => (
              <li key={s.id}>
                <span>{fmtFullDay(s.start)} · {fmtTime(s.start)}</span>
                <span className="tos-listbtns">
                  <button onClick={() => onComplete(s.id)}>Done</button>
                  <button onClick={() => onNoShow(s.id)}>No-show</button>
                  <button onClick={() => onCancel(s.id)}>Cancel</button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {history.length > 0 && (<>
          <h3 className="tos-h3 mt">Recent</h3>
          <ul className="tos-list muted">
            {history.map((s) => (
              <li key={s.id}><span>{fmtDate(s.start)} · {fmtTime(s.start)}</span><em className={s.status === "noshow" ? "no" : "ok"}>{s.status === "noshow" ? "no-show" : "completed"}</em></li>
            ))}
          </ul>
        </>)}

        <button className="tos-remove" onClick={() => onRemove(client.id)}>Remove member</button>
      </div>
    </div>
  );
}

function AddClient({ onAdd, onClose }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [tier, setTier] = useState("committed");
  const ok = name.trim() && email.trim();
  return (
    <div className="tos-scrim" onClick={onClose}>
      <div className="tos-modal" onClick={(e) => e.stopPropagation()}>
        <button className="tos-x" onClick={onClose}>×</button>
        <h2 className="tos-h2">Add member</h2>
        <label className="tos-field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" /></label>
        <label className="tos-field"><span>Email</span><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@email.com" /></label>
        <label className="tos-field"><span>Plan</span>
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            {Object.values(TIERS).map((x) => <option key={x.key} value={x.key}>{x.name} — {x.sessions}/mo · {money(x.price)} (${x.per}/session)</option>)}
          </select>
        </label>
        <p className="tos-note">New members start with a full month of sessions and a first charge dated 30 days out. Add their card from the member panel to enable auto-billing.</p>
        <button className="tos-btn full" disabled={!ok} onClick={() => onAdd({ name, email, tier })}>Add member</button>
      </div>
    </div>
  );
}

function BookingModal({ booking, clients, clientOf, onBook, onClose }) {
  const [clientId, setClientId] = useState(booking.clientId || (clients[0] && clients[0].id) || "");
  const initDate = booking.dateStr ? new Date(booking.dateStr) : new Date();
  const [dateStr, setDateStr] = useState(new Date(initDate).toISOString().slice(0, 10));
  const [hour, setHour] = useState(booking.hour ?? 7);
  const submit = () => {
    const d = new Date(dateStr + "T00:00:00"); d.setHours(Number(hour), 0, 0, 0);
    onBook({ clientId, start: d });
  };
  const c = clientOf(clientId);
  const t = c && TIERS[c.tier];
  return (
    <div className="tos-scrim" onClick={onClose}>
      <div className="tos-modal" onClick={(e) => e.stopPropagation()}>
        <button className="tos-x" onClick={onClose}>×</button>
        <h2 className="tos-h2">Book a session</h2>
        {!booking.clientId && (
          <label className="tos-field"><span>Member</span>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {clients.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
        )}
        {c && t && (
          <div className="tos-bookinfo">
            <Tank remaining={c.sessionsRemaining} total={t.sessions} size="sm" />
            <span>{c.sessionsRemaining} of {t.sessions} left this month</span>
          </div>
        )}
        <label className="tos-field"><span>Date</span><input type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} /></label>
        <label className="tos-field"><span>Time</span>
          <select value={hour} onChange={(e) => setHour(e.target.value)}>
            {Array.from({ length: WORK_END - WORK_START }, (_, i) => WORK_START + i).map((h) => (
              <option key={h} value={h}>{(h % 12 === 0 ? 12 : h % 12) + ":00 " + (h < 12 ? "AM" : "PM")}</option>
            ))}
          </select>
        </label>
        <button className="tos-btn full" onClick={submit}>Confirm booking</button>
      </div>
    </div>
  );
}

function ClientView({ client, sessions, onBook, onCancel, onAutopay }) {
  if (!client) return <div className="tos-page"><div className="tos-empty">Select a member to preview their view.</div></div>;
  const t = TIERS[client.tier];
  const upcoming = sessions.filter((s) => s.status === "booked" && new Date(s.start) >= new Date()).sort((a,b)=> new Date(a.start)-new Date(b.start));
  return (
    <div className="tos-clientwrap">
      <div className="tos-hero">
        <div className="tos-hero-eyebrow">Your membership</div>
        <h1 className="tos-hero-name">{client.name.split(" ")[0]}</h1>
        <div className="tos-hero-plan"><span className={"tos-badge " + client.tier}>{t.name}</span> {money(t.price)}/mo · {t.sessions} sessions</div>
        <div className="tos-hero-tank">
          <Tank remaining={client.sessionsRemaining} total={t.sessions} />
          <div className="tos-hero-count"><span className="tos-mono xl">{client.sessionsRemaining}</span><em>sessions left this month</em></div>
        </div>
        <div className="tos-hero-bill">Next payment {fmtDate(client.billingDate)} · {client.cardOnFile ? "auto-charged to card on file" : "set up autopay to reserve your spot"}</div>
        <div className="tos-hero-actions">
          {!client.cardOnFile && <button className="tos-btn big autopay" onClick={onAutopay}>Set up autopay</button>}
          <button className="tos-btn big" onClick={onBook}>Book a session</button>
        </div>
      </div>

      <div className="tos-clientcard">
        <h3 className="tos-h3">Your upcoming sessions</h3>
        {upcoming.length === 0 ? (
          <div className="tos-empty">Nothing booked yet — grab a slot above.</div>
        ) : (
          <ul className="tos-list">
            {upcoming.map((s) => {
              const soon = new Date(s.start) - new Date() < DAY_MS;
              return (
                <li key={s.id}>
                  <span>{fmtFullDay(s.start)}<em>{fmtTime(s.start)}</em></span>
                  <button className="tos-cancel" onClick={() => onCancel(s.id)}>
                    {soon ? "Cancel (uses session)" : "Cancel"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="tos-policy">Cancellations need 24 hours' notice. Inside that window the session counts as used. Sessions don't roll over month to month.</p>
      </div>
    </div>
  );
}

/* =============================== styles =============================== */
function StyleTag() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap');

      .tos-root{ --ink:#15171C; --paper:#E7E9ED; --surface:#FFFFFF; --line:#DCDFE6; --muted:#6A7180;
        --accent:#2743F0; --accent-ink:#1B31C7; --ok:#0F7A54; --warn:#B4530A; --soft:#8A6D00;
        font-family:'Inter',system-ui,sans-serif; color:var(--ink); background:var(--paper);
        min-height:100vh; -webkit-font-smoothing:antialiased; }
      .tos-root *{ box-sizing:border-box; }
      .tos-mono{ font-family:'JetBrains Mono',monospace; font-variant-numeric:tabular-nums; }

      /* top bar */
      .tos-top{ display:flex; justify-content:space-between; align-items:center; gap:16px;
        padding:16px 24px; background:var(--ink); color:#fff; flex-wrap:wrap; }
      .tos-brand{ display:flex; align-items:center; gap:12px; }
      .tos-mark{ color:var(--accent); font-size:18px; transform:translateY(-1px); }
      .tos-word{ font-family:'Space Grotesk',sans-serif; font-weight:700; letter-spacing:1px; font-size:18px; }
      .tos-word em{ font-style:normal; color:var(--accent); }
      .tos-mrr{ font-family:'JetBrains Mono',monospace; font-size:13px; margin-left:14px; padding-left:14px;
        border-left:1px solid rgba(255,255,255,.2); color:#fff; }
      .tos-mrr i{ font-style:normal; color:rgba(255,255,255,.5); font-size:11px; margin-left:6px; }
      .tos-rolewrap{ display:flex; gap:10px; align-items:center; }
      .tos-toggle{ display:flex; background:rgba(255,255,255,.1); border-radius:8px; padding:3px; }
      .tos-toggle button{ border:0; background:transparent; color:rgba(255,255,255,.7); padding:7px 14px;
        border-radius:6px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; }
      .tos-toggle button.on{ background:#fff; color:var(--ink); }
      .tos-hello{ color:rgba(255,255,255,.85); font-size:14px; }
      .tos-signout{ border:1px solid rgba(255,255,255,.25); background:transparent; color:#fff; padding:7px 14px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; }
      .tos-signout:hover{ background:rgba(255,255,255,.1); }
      .tos-hero-actions{ display:flex; gap:10px; flex-wrap:wrap; }
      .tos-btn.big.autopay{ background:#0F7A54; }
      .tos-btn.big.autopay:hover{ background:#0c6344; }
      .tos-splash{ max-width:520px; margin:0 auto; padding:80px 24px; text-align:center; color:var(--muted); font-family:'Inter',sans-serif; line-height:1.6; font-size:15px; }

      .tos-select{ background:#fff; border:1px solid var(--line); border-radius:8px; padding:8px 10px;
        font-family:inherit; font-size:13px; color:var(--ink); }
      .tos-select.full{ width:100%; }

      /* nav */
      .tos-body{ max-width:1080px; margin:0 auto; padding:0 24px; }
      .tos-nav{ display:flex; gap:4px; padding:20px 0 0; }
      .tos-navbtn{ border:0; background:transparent; padding:10px 16px; font-family:'Space Grotesk',sans-serif;
        font-weight:600; font-size:15px; color:var(--muted); cursor:pointer; border-radius:8px; }
      .tos-navbtn.on{ color:var(--ink); background:var(--surface); box-shadow:0 1px 0 var(--line); }

      .tos-page{ padding:20px 0 60px; }
      .tos-card{ background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:20px; margin-bottom:16px; }
      .tos-h2{ font-family:'Space Grotesk',sans-serif; font-size:24px; margin:0; }
      .tos-h3{ font-family:'Space Grotesk',sans-serif; font-size:15px; text-transform:uppercase; letter-spacing:.08em;
        color:var(--muted); margin:0 0 14px; }
      .tos-h3.mt{ margin-top:24px; }
      .tos-sub{ color:var(--muted); font-size:13px; margin:4px 0 18px; }

      /* stats */
      .tos-stats{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px; }
      .tos-stat{ background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:18px; }
      .tos-stat-label{ font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
      .tos-stat-val{ font-family:'Space Grotesk',sans-serif; font-size:30px; font-weight:700; margin-top:6px; }
      .tos-stat-val.accent{ color:var(--accent); }
      .tos-stat-sub{ font-size:12px; color:var(--muted); margin-top:2px; }

      /* alerts */
      .tos-alerts{ display:flex; flex-direction:column; gap:8px; }
      .tos-alert{ display:flex; justify-content:space-between; align-items:center; gap:12px;
        padding:12px 14px; border-radius:10px; font-size:14px; border:1px solid var(--line); }
      .tos-alert.due{ background:#EEF1FF; border-color:#C9D2FF; }
      .tos-alert.warn{ background:#FFF3EA; border-color:#FFD9BC; }
      .tos-alert.soft{ background:#FCF7E3; border-color:#F0E4B0; }

      /* agenda */
      .tos-agenda{ list-style:none; margin:0; padding:0; }
      .tos-agenda li{ display:flex; gap:16px; padding:11px 0; border-bottom:1px solid var(--line); }
      .tos-agenda li:last-child{ border-bottom:0; }
      .tos-agenda-time{ font-family:'JetBrains Mono',monospace; font-size:13px; color:var(--accent-ink); min-width:120px; }
      .tos-agenda-name{ font-weight:500; }

      /* buttons */
      .tos-btn{ background:var(--accent); color:#fff; border:0; border-radius:10px; padding:11px 18px;
        font-family:inherit; font-weight:600; font-size:14px; cursor:pointer; }
      .tos-btn:hover{ background:var(--accent-ink); }
      .tos-btn:disabled{ opacity:.4; cursor:not-allowed; }
      .tos-btn.ghost{ background:transparent; color:var(--ink); border:1px solid var(--line); }
      .tos-btn.ghost:hover{ background:var(--paper); }
      .tos-btn.sm{ padding:7px 12px; font-size:13px; }
      .tos-btn.full{ width:100%; margin-top:8px; }
      .tos-btn.big{ padding:15px 26px; font-size:16px; border-radius:12px; margin-top:20px; }

      /* rowhead */
      .tos-rowhead{ display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
      .tos-rowhead .tos-h3{ margin:0; }
      .tos-weeknav{ display:flex; gap:6px; }

      /* table */
      .tos-table{ background:var(--surface); border:1px solid var(--line); border-radius:14px; overflow:hidden; }
      .tos-tr{ display:grid; grid-template-columns:2.2fr 1fr 1.4fr 1.2fr .9fr; align-items:center; gap:8px;
        width:100%; text-align:left; padding:14px 18px; background:transparent; border:0; border-bottom:1px solid var(--line);
        cursor:pointer; font-family:inherit; font-size:14px; color:var(--ink); }
      .tos-tr:last-child{ border-bottom:0; }
      .tos-tr:not(.tos-th):hover{ background:#FAFBFF; }
      .tos-th{ cursor:default; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; }
      .tos-cell-name{ display:flex; flex-direction:column; font-weight:600; }
      .tos-cell-name em{ font-style:normal; font-weight:400; font-size:12px; color:var(--muted); }
      .tos-cell-tank{ display:flex; align-items:center; gap:8px; }
      .tos-cell-tank i{ font-style:normal; font-family:'JetBrains Mono',monospace; font-size:12px; color:var(--muted); }

      .tos-badge{ display:inline-block; padding:3px 10px; border-radius:20px; font-size:12px; font-weight:600; }
      .tos-badge.essential{ background:#EAF0F1; color:#3A5257; }
      .tos-badge.committed{ background:#E7ECFF; color:#2743F0; }
      .tos-badge.elite{ background:#151720; color:#fff; }

      .tos-dot{ font-style:normal; font-size:12px; }
      .tos-dot.ok{ color:var(--ok); } .tos-dot.no{ color:var(--warn); }

      /* tank */
      .tos-tank{ display:flex; gap:3px; }
      .tos-pip{ width:10px; height:18px; border-radius:3px; background:var(--line); }
      .tos-pip.full{ background:var(--accent); }
      .tos-tank.sm .tos-pip{ width:6px; height:14px; }
      .tos-tank.md .tos-pip{ width:12px; height:22px; }

      /* calendar */
      .tos-cal{ display:grid; grid-template-columns:52px repeat(7,1fr); background:var(--surface);
        border:1px solid var(--line); border-radius:14px; overflow:hidden; }
      .tos-cal-corner{ background:var(--surface); border-bottom:1px solid var(--line); }
      .tos-cal-dayhead{ padding:10px 6px; text-align:center; font-size:12px; font-weight:600;
        border-bottom:1px solid var(--line); border-left:1px solid var(--line); color:var(--muted); }
      .tos-cal-dayhead.today{ color:var(--accent); background:#F4F6FF; }
      .tos-cal-hour{ font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--muted);
        padding:6px; text-align:right; border-bottom:1px solid var(--line); }
      .tos-cal-slot{ border:0; border-left:1px solid var(--line); border-bottom:1px solid var(--line);
        background:var(--surface); min-height:38px; cursor:pointer; }
      .tos-cal-slot:hover{ background:#F4F6FF; }
      .tos-cal-slot.past{ background:#F6F7F9; cursor:default; }
      .tos-cal-ev{ position:relative; border-left:1px solid var(--line); border-bottom:1px solid var(--line);
        background:var(--accent); color:#fff; padding:5px 6px; min-height:38px; cursor:pointer; font-size:11px; }
      .tos-cal-ev b{ display:block; font-size:12px; }
      .tos-cal-ev i{ font-style:normal; opacity:.8; }
      .tos-cal-ev.completed{ background:var(--ok); }
      .tos-cal-ev.noshow{ background:var(--warn); }
      .tos-evmenu{ position:absolute; top:100%; left:0; z-index:5; background:#fff; border:1px solid var(--line);
        border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.14); display:flex; flex-direction:column; min-width:120px; overflow:hidden; }
      .tos-evmenu button{ border:0; background:#fff; color:var(--ink); text-align:left; padding:9px 12px; font-size:13px; cursor:pointer; font-family:inherit; }
      .tos-evmenu button:hover{ background:var(--paper); }
      .tos-hint{ font-size:12px; color:var(--muted); margin-top:10px; }

      /* modals / drawer */
      .tos-scrim{ position:fixed; inset:0; background:rgba(20,22,28,.44); display:flex; justify-content:center;
        align-items:flex-start; padding:40px 16px; z-index:40; overflow:auto; }
      .tos-modal{ background:#fff; border-radius:16px; padding:26px; width:100%; max-width:420px; position:relative; }
      .tos-drawer{ background:#fff; border-radius:16px; padding:26px; width:100%; max-width:520px; position:relative; }
      .tos-x{ position:absolute; top:16px; right:16px; border:0; background:transparent; font-size:24px; line-height:1;
        color:var(--muted); cursor:pointer; }
      .tos-field{ display:block; margin:14px 0; }
      .tos-field span{ display:block; font-size:12px; font-weight:600; color:var(--muted); margin-bottom:6px; text-transform:uppercase; letter-spacing:.05em; }
      .tos-field input, .tos-field select{ width:100%; border:1px solid var(--line); border-radius:9px; padding:11px;
        font-family:inherit; font-size:14px; color:var(--ink); background:#fff; }
      .tos-note, .tos-policy, .tos-hint{ line-height:1.5; }
      .tos-note{ font-size:12px; color:var(--muted); margin:12px 0; }

      .tos-detailtank{ display:flex; align-items:center; gap:16px; margin:8px 0 20px; }
      .tos-mono.lg{ font-size:20px; } .tos-mono.xl{ font-size:52px; font-weight:600; }
      .tos-mono em{ font-style:normal; color:var(--muted); font-size:13px; margin-left:4px; }
      .tos-detailgrid{ display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:18px; }
      .tos-detailgrid label{ display:block; font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px; }
      .tos-chip{ border:1px solid var(--line); background:#fff; border-radius:8px; padding:9px 12px; font-family:inherit;
        font-size:13px; cursor:pointer; width:100%; text-align:left; }
      .tos-chip.ok{ border-color:#B7E0CE; color:var(--ok); background:#F0FAF5; }
      .tos-chip.no{ border-color:#FFD9BC; color:var(--warn); background:#FFF6EF; }
      .tos-detailactions{ display:flex; gap:10px; }
      .tos-detailactions .tos-btn{ flex:1; }

      .tos-list{ list-style:none; margin:0; padding:0; }
      .tos-list li{ display:flex; justify-content:space-between; align-items:center; gap:12px;
        padding:11px 0; border-bottom:1px solid var(--line); font-size:14px; }
      .tos-list li:last-child{ border-bottom:0; }
      .tos-list.muted li{ color:var(--muted); }
      .tos-list em{ font-style:normal; }
      .tos-list em.ok{ color:var(--ok); } .tos-list em.no{ color:var(--warn); }
      .tos-listbtns{ display:flex; gap:6px; }
      .tos-listbtns button, .tos-cancel{ border:1px solid var(--line); background:#fff; border-radius:7px;
        padding:6px 10px; font-size:12px; cursor:pointer; font-family:inherit; color:var(--ink); }
      .tos-listbtns button:hover, .tos-cancel:hover{ background:var(--paper); }
      .tos-remove{ margin-top:24px; border:0; background:transparent; color:var(--warn); font-size:13px; cursor:pointer; font-family:inherit; }

      .tos-empty{ padding:22px; text-align:center; color:var(--muted); font-size:14px;
        border:1px dashed var(--line); border-radius:12px; }

      /* client view */
      .tos-clientwrap{ max-width:600px; margin:0 auto; padding:28px 20px 60px; }
      .tos-hero{ background:var(--ink); color:#fff; border-radius:20px; padding:32px; }
      .tos-hero-eyebrow{ font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:rgba(255,255,255,.5); }
      .tos-hero-name{ font-family:'Space Grotesk',sans-serif; font-size:38px; margin:4px 0 10px; }
      .tos-hero-plan{ display:flex; align-items:center; gap:10px; color:rgba(255,255,255,.85); font-size:14px; }
      .tos-hero-tank{ display:flex; align-items:center; gap:20px; margin:26px 0 18px; }
      .tos-hero-tank .tos-pip{ background:rgba(255,255,255,.18); }
      .tos-hero-tank .tos-pip.full{ background:var(--accent); }
      .tos-hero-count{ display:flex; flex-direction:column; }
      .tos-hero-count em{ font-style:normal; font-size:12px; color:rgba(255,255,255,.55); }
      .tos-hero-bill{ font-size:13px; color:rgba(255,255,255,.6); border-top:1px solid rgba(255,255,255,.14); padding-top:16px; }
      .tos-clientcard{ background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:24px; margin-top:16px; }
      .tos-clientcard .tos-list span{ display:flex; flex-direction:column; }
      .tos-clientcard .tos-list em{ color:var(--muted); font-size:12px; }
      .tos-policy{ font-size:12px; color:var(--muted); margin-top:16px; padding-top:14px; border-top:1px solid var(--line); }
      .tos-bookinfo{ display:flex; align-items:center; gap:10px; font-size:13px; color:var(--muted); margin:6px 0 4px; }

      /* toast */
      .tos-toast{ position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:var(--ink);
        color:#fff; padding:13px 20px; border-radius:12px; font-size:14px; z-index:60; box-shadow:0 10px 30px rgba(0,0,0,.2);
        animation:tos-rise .3s ease; }
      @keyframes tos-rise{ from{ opacity:0; transform:translate(-50%,10px);} to{ opacity:1; transform:translate(-50%,0);} }

      :focus-visible{ outline:2px solid var(--accent); outline-offset:2px; }
      @media (prefers-reduced-motion:reduce){ *{ animation:none!important; transition:none!important; } }

      @media (max-width:860px){
        .tos-stats{ grid-template-columns:repeat(2,1fr); }
        .tos-tr{ grid-template-columns:1.6fr 1fr 1fr; }
        .tos-tr span:nth-child(4),.tos-tr span:nth-child(5){ display:none; }
        .tos-cal{ grid-template-columns:40px repeat(7,1fr); font-size:10px; }
        .tos-cal-ev b{ font-size:10px; }
      }
    `}</style>
  );
}
