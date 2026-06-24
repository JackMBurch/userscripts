# WhatsApp Collapsible Sidebars

Reclaim screen space in WhatsApp Web by collapsing the parts you don't need.

## What it does

Adds two small carets to the left edge of WhatsApp Web:

- **Top caret** — collapse/expand the **icon rail** (Chats, Status, Channels, Communities, Meta AI, settings/profile).
- **Bottom caret** (marked with a 💬 chat bubble) — collapse/expand the **chat list**.

Both panels slide away when collapsed, giving the open conversation the full width. Click a caret again to bring its panel back. Your collapsed/expanded choices are remembered between visits.

You can also **drag the right edge of the chat list** to resize how wide it is.

## How to use

1. Click the **top caret** to hide/show the icon rail.
2. Click the **bottom caret** (💬) to hide/show the chat list.
3. Drag the chat list's right edge to set its width.

That's it — it works automatically on [web.whatsapp.com](https://web.whatsapp.com/) after install.

## Prefer hover instead of a caret?

By default the chat list is controlled by its caret. If you'd rather have the chat list reveal automatically when you move your mouse to the left edge of the screen, open the script and set:

```js
const USE_CHATLIST_CARET = false;
```

The chat-list caret then disappears and the chat list shows on hover (with a short grace period so it doesn't vanish the instant you move away).

For layout debugging when WhatsApp changes its site, see [DEBUGGING.md](DEBUGGING.md).
