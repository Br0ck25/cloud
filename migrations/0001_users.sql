create table users (
  id integer primary key,
  email text not null unique collate nocase,
  role text not null check (role in ('admin', 'member')),
  created_at integer not null default (unixepoch())
);
