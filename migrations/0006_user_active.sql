-- Removing a family member switches their access off but keeps their files.
alter table users add column active integer not null default 1;
