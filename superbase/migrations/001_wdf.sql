-- Catálogo opcional del servidor.
-- El cliente NO sube audio/video. Solo registra el ID de la canción/mod.

create table if not exists public.wdf_song_catalog (
    song_id text primary key,
    title text not null,
    artist text not null default 'Unknown',
    created_at timestamptz not null default now()
);

alter table public.wdf_song_catalog enable row level security;

drop policy if exists "wdf songs are readable" on public.wdf_song_catalog;
create policy "wdf songs are readable"
on public.wdf_song_catalog
for select
to anon, authenticated
using (true);

grant select on public.wdf_song_catalog to anon, authenticated;
