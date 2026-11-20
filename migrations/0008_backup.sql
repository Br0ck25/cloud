-- Which stored objects already have a copy in the backup bucket, and how the last backup run went.
create table backed_up (
  key text primary key,
  size integer not null,
  at integer not null
);
create table backup_status (
  id integer primary key check (id = 1),
  ran_at integer not null,
  failed integer not null,
  too_big integer not null
);
