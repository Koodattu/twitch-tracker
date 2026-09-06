UPDATE chat_messages AS message
SET shared_chat_source_channel_id = substring(
      split_part(raw.raw_line, ' ', 1) FROM '(?:^@|;)source-room-id=([0-9]+)(?:;|$)'
    ),
    updated_at = now()
FROM raw_irc_messages AS raw
WHERE message.raw_irc_message_id = raw.id
  AND message.shared_chat_source_channel_id IS NULL
  AND message.chatter_user_id IS NOT NULL
  AND raw.raw_line LIKE '@%'
  AND split_part(raw.raw_line, ' ', 1) ~ '(?:^@|;)source-room-id=[0-9]+(?:;|$)';
