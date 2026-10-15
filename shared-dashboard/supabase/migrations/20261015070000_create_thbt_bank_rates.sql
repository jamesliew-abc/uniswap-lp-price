-- Applied to "jamesliew-abc's Project" (terfvnsyvtccujglklrq) on 2026-10-15.
-- Bank of Thailand daily average mid rates (THB per 1 unit), used to work out the deviation
-- at each 6-hour mark. Written by the uniswap-lp-price Cloudflare Worker.
create table public.thbt_bank_rates (
  rate_date  date        not null,
  currency   text        not null check (currency in ('USD', 'EUR', 'SGD', 'AUD')),
  mid_rate   numeric     not null check (mid_rate > 0),
  fetched_at timestamptz not null default now(),
  primary key (currency, rate_date)
);

comment on table public.thbt_bank_rates is
  'Bank of Thailand Daily Average Exchange Rate mid rate per business day. A rate dated D is treated as published at 18:00 Bangkok time on D.';

alter table public.thbt_bank_rates enable row level security;
revoke all on public.thbt_bank_rates from anon, authenticated;
