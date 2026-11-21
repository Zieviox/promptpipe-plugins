# Memory

A site chat only knows what was said in it. Memory puts the earlier conversation in front of
your message, so a fresh site chat (or another site) can carry on where the chat left off.

## What goes out

1. **Pinned facts**, first, always, never shortened. One per line works well.
2. **The earlier messages**: below the **max characters**, every message word for word.
3. Over the max: the **recent messages** stay word for word and older ones go in as
   **summaries**, coarser the older they are. A summary covers 10 messages (the part size);
   once there are 10 of those, they're summed up again, and so on. Each summary is made once.

It's wrapped as `[Memory: …]` … `[End of memory]`, so the AI knows it's context, not your
question. Anything in a chat that looks like memory's own labels is escaped, so a reply can't
pretend to be a summary.

## Summaries

- They're made in the background after a reply, a few messages before the max (**Start
  summarising this many messages before the max**), so sending never waits for them.
- Each one is a side request: a fresh, unsaved chat on the site, with the **Summary request**.
- **Your side and the AI's side apart** (the default) makes two requests per part, one with only
  your messages and one with only the AI's, so the two can't be mixed up. **One summary of both
  sides** makes one.
- **Run the profile's plugins on the summary request** sends it through the profile's blocks
  (e.g. Base64); off, it goes out as it is.
- **Clip older messages** instead of summarising: older messages are cut short and the oldest
  dropped. No side requests.

## Seeing and correcting them

The summaries are at the end of the chat's file, in a folded **Memory** section, one heading per
part. Edit the text in any editor; when the app asks about the outside change, **Keep the outside
change**, and your correction is what's sent from then on.

## Other settings

- **Send memory every N messages**: 1 is every message. A new site chat always gets it.
- **Only what this site chat hasn't seen** leaves out messages that already went to the site chat
  this message goes to (it has them), which saves room with Sub-chats.
- **Name the AI on each line** when the chat used more than one site.
- "At depth N" System prompts in the profile go among the recent messages, N from the end.
