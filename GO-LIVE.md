-- ============================================================
-- TrainerOS database schema  ·  run in Supabase → SQL Editor
-- ============================================================

-- Members = your clients. Linked to a login via auth_user_id.
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id) on delete set null,
  name text not null,
  email text not null unique,
  tier text not null default 'committed' check (tier in ('essential','committed','elite')),
  sessions_remaining int not null default 0,
  billing_date timestamptz,
  status text not null default 'active' check (status in ('active','paused','cancelled')),
  stripe_customer_id text,
  stripe_subscription_id text,
  card_on_file boolean not null default false,
  joined_at timestamptz not null default now()
);

-- Training sessions on the calendar.
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  starts_at timestamptz not null,
  status text not null default 'booked' check (status in ('booked','completed','noshow','cancelled')),
  created_at timestamptz not null default now()
);

-- Admins = you. After your first sign-in, add your row here (see SETUP.md).
create table if not exists admins (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  email text
);

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from admins where auth_user_id = auth.uid());
$$;

alter table members  enable row level security;
alter table sessions enable row level security;
alter table admins   enable row level security;

-- A client sees only their own member row; you (admin) see everyone.
create policy members_select on members for select
  using (auth_user_id = auth.uid() or is_admin());
create policy members_admin_all on members for all
  using (is_admin()) with check (is_admin());

-- Sessions: clients read/insert/update their own; you do everything.
create policy sessions_select on sessions for select
  using (is_admin() or member_id in (select id from members where auth_user_id = auth.uid()));
create policy sessions_client_insert on sessions for insert
  with check (is_admin() or member_id in (select id from members where auth_user_id = auth.uid()));
create policy sessions_client_update on sessions for update
  using (is_admin() or member_id in (select id from members where auth_user_id = auth.uid()))
  with check (is_admin() or member_id in (select id from members where auth_user_id = auth.uid()));
create policy sessions_admin_all on sessions for all
  using (is_admin()) with check (is_admin());

create policy admins_select on admins for select using (is_admin());
