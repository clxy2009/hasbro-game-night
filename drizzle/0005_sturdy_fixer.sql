PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_rsvps` (
	`event_id` text NOT NULL,
	`player_id` text NOT NULL,
	`request_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `player_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_rsvps`("event_id", "player_id", "request_id", "created_at")
SELECT "event_id", "player_id",
  COALESCE(NULLIF("request_id", ''), lower(hex(randomblob(16)))), "created_at"
FROM `rsvps`;--> statement-breakpoint
DROP TABLE `rsvps`;--> statement-breakpoint
ALTER TABLE `__new_rsvps` RENAME TO `rsvps`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_rsvps_player_event` ON `rsvps` (`player_id`,`event_id`);
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
