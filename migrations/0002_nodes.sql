-- A node is a file or folder. owner_id is the person who owns it, or NULL for the shared Family space.
-- Children always have the same owner as their parent, so one column decides access.
create table nodes (
  id integer primary key,
  parent_id integer references nodes(id),
  owner_id integer references users(id),
  name text not null,
  kind text not null check (kind in ('file', 'folder')),
  size integer,
  mime text,
  blob_key text,
  trashed_at integer,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch())
);
-- No two live items with the same name in one folder.
create unique index nodes_unique_name on nodes (ifnull(parent_id, 0), ifnull(owner_id, 0), name collate nocase) where trashed_at is null;
create index nodes_parent on nodes (parent_id);

insert into nodes (name, kind) values ('Family', 'folder');
