CREATE INDEX "chat_messages_received_idx" ON "chat_messages" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "chat_messages_stream_received_idx" ON "chat_messages" USING btree ("twitch_stream_id","received_at");
