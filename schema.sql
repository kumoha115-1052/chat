-- Friends Board schema for Supabase
-- Run this entire file in Supabase SQL Editor.
-- IMPORTANT: Create your first account through the app, then run the bootstrap-admin
-- statement at the bottom with that account's UUID.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'メンバー' check (char_length(display_name) between 1 and 30),
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('member','admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  created_by uuid not null references auth.users(id),
  used_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_at timestamptz
);

create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 100),
  body text not null check (char_length(body) between 1 and 5000),
  author_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  parent_post_id uuid references public.posts(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 3000),
  author_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists threads_created_at_idx on public.threads(created_at desc);
create index if not exists posts_thread_created_idx on public.posts(thread_id, created_at);
create index if not exists invitations_expires_idx on public.invitations(expires_at);

-- Create profile after Supabase Auth creates a user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'display_name',''), split_part(new.email,'@',1)));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.is_board_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.memberships m where m.user_id = (select auth.uid()));
$$;

create or replace function public.is_board_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.memberships m where m.user_id = (select auth.uid()) and m.role = 'admin');
$$;

-- Redeem a one-use invitation. A code is stored only as a SHA-256 hash.
create or replace function public.redeem_invitation(p_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation_id uuid;
begin
  if auth.uid() is null then
    raise exception 'ログインが必要です';
  end if;
  if exists (select 1 from public.memberships where user_id = auth.uid()) then
    return true;
  end if;
  select id into v_invitation_id
  from public.invitations
  where code_hash = encode(digest(trim(p_code), 'sha256'), 'hex')
    and used_by is null
    and expires_at > now()
  for update;
  if v_invitation_id is null then
    raise exception '招待コードが無効、使用済み、または期限切れです';
  end if;
  update public.invitations
  set used_by = auth.uid(), used_at = now()
  where id = v_invitation_id;
  insert into public.memberships(user_id, role) values (auth.uid(), 'member');
  return true;
end;
$$;

create or replace function public.create_invitation()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if not public.is_board_admin() then
    raise exception '管理者のみ実行できます';
  end if;
  v_code := upper(encode(gen_random_bytes(6), 'hex'));
  insert into public.invitations(code_hash, created_by)
  values (encode(digest(v_code, 'sha256'), 'hex'), auth.uid());
  return v_code;
end;
$$;

alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.invitations enable row level security;
alter table public.threads enable row level security;
alter table public.posts enable row level security;

-- Profiles: members can see member profiles; users can update only their own display name.
create policy "members can read profiles" on public.profiles
for select to authenticated using (public.is_board_member());
create policy "users update own profile" on public.profiles
for update to authenticated using (id = (select auth.uid()) and public.is_board_member())
with check (id = (select auth.uid()) and public.is_board_member());

-- Membership list is visible only to members. Only admins can change memberships directly.
create policy "members read memberships" on public.memberships
for select to authenticated using (public.is_board_member());
create policy "admins manage memberships" on public.memberships
for all to authenticated using (public.is_board_admin()) with check (public.is_board_admin());

-- Invitations are never directly readable from the client. Use RPC functions.
-- Threads
create policy "members read threads" on public.threads
for select to authenticated using (public.is_board_member());
create policy "members create threads" on public.threads
for insert to authenticated with check (public.is_board_member() and author_id = (select auth.uid()));
create policy "authors or admins delete threads" on public.threads
for delete to authenticated using (public.is_board_member() and (author_id = (select auth.uid()) or public.is_board_admin()));
create policy "authors or admins update threads" on public.threads
for update to authenticated using (public.is_board_member() and (author_id = (select auth.uid()) or public.is_board_admin()))
with check (public.is_board_member() and (author_id = (select auth.uid()) or public.is_board_admin()));

-- Posts
create policy "members read posts" on public.posts
for select to authenticated using (public.is_board_member());
create policy "members create posts" on public.posts
for insert to authenticated with check (
  public.is_board_member()
  and author_id = (select auth.uid())
  and exists (select 1 from public.threads t where t.id = thread_id)
);
create policy "authors or admins delete posts" on public.posts
for delete to authenticated using (public.is_board_member() and (author_id = (select auth.uid()) or public.is_board_admin()));
create policy "authors or admins update posts" on public.posts
for update to authenticated using (public.is_board_member() and (author_id = (select auth.uid()) or public.is_board_admin()))
with check (public.is_board_member() and (author_id = (select auth.uid()) or public.is_board_admin()));

grant usage on schema public to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.threads to authenticated;
grant select, insert, update, delete on public.posts to authenticated;
grant select, insert, update, delete on public.memberships to authenticated;
grant execute on function public.redeem_invitation(text) to authenticated;
grant execute on function public.create_invitation() to authenticated;
grant execute on function public.is_board_member() to authenticated;
grant execute on function public.is_board_admin() to authenticated;

-- FIRST ADMIN SETUP:
-- 1) Sign up the first account in the app (you can temporarily disable email confirmation
--    in Supabase Authentication settings for easier setup).
-- 2) Find its UUID in Authentication > Users.
-- 3) Run this statement, replacing the UUID:
-- insert into public.memberships(user_id, role)
-- values ('PASTE-FIRST-USER-UUID-HERE', 'admin')
-- on conflict (user_id) do update set role = 'admin';

-- NOTE: Keep email confirmation enabled for normal use. Never expose a service_role key.
