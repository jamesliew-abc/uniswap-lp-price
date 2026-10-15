-- Applied to "jamesliew-abc's Project" (terfvnsyvtccujglklrq) on 2026-10-15.
-- THBT pool prices at fixed 6-hour marks (09:00, 15:00, 21:00, 03:00 ICT), written by the
-- uniswap-lp-price Cloudflare Worker. Only the Worker's secret key reads or writes it.
create table public.thbt_price_marks (
  mark_at        timestamptz not null,
  symbol         text        not null check (symbol in ('USDT', 'USDC', 'EURC', 'XSGD', 'AUDD')),
  pool_id        text,
  thbt_per_token numeric check (thbt_per_token is null or thbt_per_token > 0),
  price_as_of    timestamptz,
  source         text        not null check (source in ('scheduled', 'backfill')),
  captured_at    timestamptz not null default now(),
  primary key (mark_at, symbol)
);

comment on table public.thbt_price_marks is
  'THBT per 1 token for each Uniswap v4 pool at each 6-hour mark (02/08/14/20 UTC). Price is the pool price after the last swap before mark_at; null when the pool had not traded yet.';
comment on column public.thbt_price_marks.price_as_of is 'Time of the swap that set this price.';

create index thbt_price_marks_symbol_mark_idx on public.thbt_price_marks (symbol, mark_at);

-- Row level security on with no policies: the anon and authenticated roles get nothing.
alter table public.thbt_price_marks enable row level security;
revoke all on public.thbt_price_marks from anon, authenticated;
