CREATE TABLE `invitation_flow` (
	`invitation_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`member_id` text NOT NULL,
	`registration_user_id` text,
	`accepting_user_id` text,
	`completed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitation_flow_member_id_unique` ON `invitation_flow` (`member_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invitation_pending_email_unique` ON `invitation` (`organization_id`,`email`) WHERE "invitation"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `member_organization_user_unique` ON `member` (`organization_id`,`user_id`);
--> statement-breakpoint
-- Better Auth accepts before creating the member. D1 cannot wrap those SDK calls
-- in one transaction; these triggers make the actual grant and its receipt atomic.
-- Keep CASE expressions parenthesized: remote D1's /query parser otherwise
-- mistakes the expression's END for the end of a trigger body.
CREATE TRIGGER invitation_member_guard BEFORE INSERT ON member
WHEN EXISTS (SELECT 1 FROM invitation_flow WHERE member_id = NEW.id)
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM invitation_flow AS flow
    JOIN invitation AS invite ON invite.id = flow.invitation_id
    JOIN user AS recipient ON recipient.id = NEW.user_id
    WHERE flow.member_id = NEW.id
      AND flow.accepting_user_id = NEW.user_id
      AND flow.organization_id = NEW.organization_id
      AND flow.completed_at IS NULL
      AND invite.organization_id = NEW.organization_id
      AND invite.status = 'accepted'
      AND invite.role = NEW.role
      AND invite.role IN ('member', 'admin')
      AND invite.expires_at > CAST(unixepoch('subsecond') * 1000 AS INTEGER)
      AND lower(invite.email) = lower(recipient.email)
      AND recipient.email_verified = 1
  ) THEN RAISE(ABORT, 'invitation_membership_not_authorized') END);
END;
--> statement-breakpoint
CREATE TRIGGER invitation_member_completed AFTER INSERT ON member
WHEN EXISTS (SELECT 1 FROM invitation_flow WHERE member_id = NEW.id)
BEGIN
  UPDATE invitation_flow
    SET completed_at = CAST(unixepoch('subsecond') * 1000 AS INTEGER)
    WHERE member_id = NEW.id;
END;
--> statement-breakpoint
-- A later SDK error may attempt accepted -> pending compensation. Once the member
-- was created, neither this compensation nor cancellation may reopen the grant.
CREATE TRIGGER invitation_completed_is_terminal BEFORE UPDATE OF status ON invitation
WHEN NEW.status <> 'accepted' AND EXISTS (
  SELECT 1 FROM invitation_flow WHERE invitation_id = OLD.id AND completed_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invitation_already_completed');
END;
