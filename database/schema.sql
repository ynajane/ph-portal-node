-- PH Portal schema (PostgreSQL 13+). Safe to run more than once.
-- Matches the requirements PDF, plus: attempts (OTP counter) and sessions.
create extension if not exists pgcrypto;
do $$ begin
  create type token_type as enum ('email_verify','mobile_otp','password_reset','account_unlock');
exception when duplicate_object then null; end $$;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  first_name varchar(50) not null,
  last_name varchar(50) not null,
  middle_initial varchar(2),
  birthday date not null,
  password_hash varchar(255) not null,
  email varchar(255) not null unique,
  email_verified_at timestamptz,
  mobile_number varchar(20) not null,
  mobile_verified boolean not null default false,
  failed_login_attempts int not null default 0,
  is_locked boolean not null default false,
  lockout_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists users_email_idx on users(email);

create table if not exists addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  house_street varchar(255) not null,
  country varchar(100) not null,
  city varchar(100) not null,
  state varchar(100) not null,
  zip_code varchar(20) not null
);

create table if not exists verification_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash varchar(255) not null,
  type token_type not null,
  expired_at timestamptz not null,
  attempts int not null default 0,          -- OTP wrong-entry counter (added)
  created_at timestamptz not null default now()
);
create index if not exists vt_lookup on verification_tokens(type, token_hash);

create table if not exists sessions (                      -- server-side sessions (added)
  token_hash varchar(64) primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);

-- Defense in depth: with RLS on and no policies, nobody can read these tables through a
-- public REST API (e.g. Supabase's). The app connects as the table owner, which bypasses RLS.
alter table users enable row level security;
alter table addresses enable row level security;
alter table verification_tokens enable row level security;
alter table sessions enable row level security;
