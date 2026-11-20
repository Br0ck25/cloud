-- Resumable large uploads. R2 keeps the bytes; these tables remember which parts arrived.
create table uploads (
  id text primary key,
  user_id integer not null references users(id),
  parent_id integer,           -- destination folder, same meaning as nodes.parent_id
  owner_id integer,            -- destination space, same meaning as nodes.owner_id
  name text not null,
  size integer not null,
  mime text not null,
  blob_key text not null,
  upload_id text not null,     -- R2 multipart upload id
  created_at integer not null default (unixepoch())
);
-- One session per person, folder, name and size, so re-selecting the same file resumes it.
create unique index uploads_resume on uploads (user_id, ifnull(parent_id, 0), name, size);
create table upload_parts (
  upload_id text not null,
  part integer not null,
  etag text not null,
  primary key (upload_id, part)
);
