-- gone_at: when the original stopped existing (its backup copy is pruned 30 days later). checked_at: last time the copy was confirmed present.
alter table backed_up add column gone_at integer;
alter table backed_up add column checked_at integer;
alter table backup_status add column repaired integer not null default 0;
