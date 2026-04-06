-- P13-T2: Add review_prompt_sent_at to trns_bookings so review SMS is sent only once per completed trip
ALTER TABLE trns_bookings ADD COLUMN review_prompt_sent_at INTEGER;
