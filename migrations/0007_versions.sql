-- Earlier contents of a file. The nodes row always holds the current content; each row here is a previous one.
alter table nodes add column content_at integer;
update nodes set content_at = created_at;
create table versions (
  id integer primary key,
  node_id integer not null references nodes(id),
  blob_key text not null,
  thumb_key text,
  size integer not null,
  mime text not null,
  content_at integer not null    -- when this content was saved
);
create index versions_node on versions (node_id);
