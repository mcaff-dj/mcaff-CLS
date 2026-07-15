-- CRM-PEP Supabase schema.
-- Run this once in the Supabase project's SQL editor (Database > SQL Editor).
-- Team members are managed as Supabase Auth users (Authentication > Users) - no
-- separate "users" table needed here.

create extension if not exists pgcrypto;

create table if not exists leads (
    id                     uuid primary key default gen_random_uuid(),
    source                 text not null check (source in ('ndr', 'rto')),
    shiprocket_order_id    text,
    shiprocket_shipment_id text,
    awb                    text,
    channel_order_id       text,
    customer_name          text,
    customer_phone         text,
    customer_address       text,
    courier_name           text,
    order_value            numeric,
    status                 text,
    reason                 text,
    attempts               integer default 0,
    raw_data               jsonb,
    lead_status            text not null default 'new'
                           check (lead_status in (
                               'new', 'attempted', 'callback_scheduled',
                               'resolved_reattempt', 'resolved_cancelled',
                               'unreachable', 'closed'
                           )),
    assigned_to            uuid references auth.users(id) on delete set null,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now(),
    last_synced_at         timestamptz not null default now(),
    unique (source, awb)
);

create index if not exists leads_lead_status_idx on leads (lead_status);
create index if not exists leads_assigned_to_idx on leads (assigned_to);
create index if not exists leads_source_idx on leads (source);

create table if not exists call_logs (
    id           uuid primary key default gen_random_uuid(),
    lead_id      uuid not null references leads(id) on delete cascade,
    called_by    uuid references auth.users(id) on delete set null,
    call_outcome text not null,
    notes        text,
    called_at    timestamptz not null default now()
);

create index if not exists call_logs_lead_id_idx on call_logs (lead_id);

-- keep leads.updated_at fresh on every update
create or replace function set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists leads_set_updated_at on leads;
create trigger leads_set_updated_at
    before update on leads
    for each row execute function set_updated_at();

-- Row Level Security. The Flask app talks to Supabase with the service-role key
-- (which bypasses RLS) and enforces login itself, so these policies are a
-- defense-in-depth baseline for any future direct-from-browser access.
alter table leads enable row level security;
alter table call_logs enable row level security;

drop policy if exists "leads_select_authenticated" on leads;
create policy "leads_select_authenticated" on leads
    for select to authenticated using (true);

drop policy if exists "leads_update_authenticated" on leads;
create policy "leads_update_authenticated" on leads
    for update to authenticated using (true) with check (true);

drop policy if exists "call_logs_select_authenticated" on call_logs;
create policy "call_logs_select_authenticated" on call_logs
    for select to authenticated using (true);

drop policy if exists "call_logs_insert_own" on call_logs;
create policy "call_logs_insert_own" on call_logs
    for insert to authenticated with check (called_by = auth.uid());
