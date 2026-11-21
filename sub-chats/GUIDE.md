# Sub-chats

One promptpipe chat can run across several site chats: when a site chat gets long or slow,
start a fresh one and keep going in the same promptpipe chat. The chat file stays one, with a
divider where each sub-chat starts.

## Using it

- **Sub-chats** (the chat's sheet) lists the chat's sub-chats: which site, how many messages,
  which one you're in now.
- **New sub-chat, on**: pick a provider; your next message opens a fresh site chat there. The
  chat's own profile and plugins keep running; the other provider only lends its site and model.
  With Memory on, the new site chat gets what came before.
- Tap an earlier sub-chat to send the next message back there.
- Until the message goes, a note under the last reply says where it will go, with **Cancel**.

## Branching from a reply

**New sub-chat here** (a reply's ⋯ sheet) starts a sub-chat that sees the chat up to that reply,
then only its own messages: what came after the reply elsewhere stays out of its memory. It's a
simple way to try another direction from any point.

## Notes

- A sub-chat is the run of messages that went to one site chat; the app knows it from each
  message's site chat address, so chats from before Sub-chats need nothing done.
- Sub-chats works through its block in the profile: turn the block off and messages go where the
  chat's link points, as without the plugin.
