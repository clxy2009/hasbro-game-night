PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_rsvps_after_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_rsvps_after_delete`;--> statement-breakpoint
CREATE TABLE `__new_rsvp_history` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`player_id` text NOT NULL,
	`action` text NOT NULL,
	`occurred_at` text NOT NULL,
	`request_id` text,
	`event_version` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rsvp_history_action_check" CHECK("__new_rsvp_history"."action" in ('reserved', 'canceled'))
);
--> statement-breakpoint
INSERT INTO `__new_rsvp_history`("id", "event_id", "player_id", "action", "occurred_at", "request_id", "event_version") SELECT "id", "event_id", "player_id", "action", "occurred_at", "request_id", "event_version" FROM `rsvp_history`;--> statement-breakpoint
DROP TABLE `rsvp_history`;--> statement-breakpoint
ALTER TABLE `__new_rsvp_history` RENAME TO `rsvp_history`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_rsvp_history_player_time` ON `rsvp_history` (`player_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_rsvp_history_event_time` ON `rsvp_history` (`event_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_rsvp_history_request` ON `rsvp_history` (`event_id`,`player_id`,`request_id`) WHERE "rsvp_history"."action" = 'reserved' and "rsvp_history"."request_id" is not null;
--> statement-breakpoint
CREATE TRIGGER `trg_rsvps_after_insert`
AFTER INSERT ON `rsvps`
BEGIN
  UPDATE events
  SET attendee_count = attendee_count + 1, version = version + 1
  WHERE id = NEW.event_id;
  INSERT INTO rsvp_history
    (id, event_id, player_id, action, occurred_at, request_id, event_version)
  SELECT lower(hex(randomblob(16))), NEW.event_id, NEW.player_id, 'reserved',
    NEW.created_at, NEW.request_id, version
  FROM events WHERE id = NEW.event_id;
  INSERT INTO outbox_events
    (event_id, event_type, event_version, occurred_at)
  SELECT NEW.event_id, 'capacity.changed', version, NEW.created_at
  FROM events WHERE id = NEW.event_id;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_rsvps_after_delete`
AFTER DELETE ON `rsvps`
BEGIN
  UPDATE events
  SET attendee_count = CASE WHEN attendee_count > 0 THEN attendee_count - 1 ELSE 0 END,
    version = version + 1
  WHERE id = OLD.event_id;
  INSERT INTO rsvp_history
    (id, event_id, player_id, action, occurred_at, request_id, event_version)
  SELECT lower(hex(randomblob(16))), OLD.event_id, OLD.player_id, 'canceled',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.request_id, version
  FROM events WHERE id = OLD.event_id;
  INSERT INTO outbox_events
    (event_id, event_type, event_version, occurred_at)
  SELECT OLD.event_id, 'capacity.changed', version,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM events WHERE id = OLD.event_id;
END;
