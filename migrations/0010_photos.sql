-- When a photo or video was taken (the phone's own file date), used to order the Photos timeline. Older rows fall back to their upload time.
alter table nodes add column taken_at integer;
update nodes set taken_at = content_at;
create index nodes_taken on nodes (taken_at desc, id desc);
alter table uploads add column taken_at integer;
