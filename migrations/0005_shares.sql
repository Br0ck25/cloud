-- Public link shares. Whoever holds the token can view and download the item; no sign-in.
create table shares (
  id integer primary key,
  node_id integer not null references nodes(id),
  created_by integer not null references users(id),
  token text not null unique,
  expires_at integer,           -- null = never
  created_at integer not null default (unixepoch())
);
create index shares_node on shares (node_id);
