# The reviewer experience

What the person giving feedback sees and can do. Reviewers never log in,
install nothing, and need no training — this page exists mostly so *you* know
what they have.

## Leaving a comment

1. Click the circular **Give feedback** button in the corner (keyboard: focus
   it and press Enter/Space).
2. The cursor becomes a crosshair and a hint bar appears: *"Click anywhere to
   leave a comment — Esc to cancel"* (on touch devices: *"Tap anywhere to
   leave a comment"*). Click the thing you want to talk about.
3. A numbered pin drops on that spot and the composer opens beside it. The
   chip at the top (e.g. `⌖ button "Search trips"`) names the element the pin
   is anchored to.
4. Type (up to 2000 characters, live counter), optionally add your name, and
   **Send** — or **Cmd/Ctrl+Enter**.
5. "✓ Sent — thank you" shows for a moment, the composer closes, and you're
   still in comment mode to leave the next one. **Done** (in the hint bar) or
   **Esc** leaves comment mode.

Details that make this forgiving:

- **Clicked the wrong spot?** While the composer is still empty, just click
  the right spot — the pin moves there. Once you've typed anything, clicks on
  the page are ignored (your text is protected).
- **Esc never destroys your words.** Esc closes the composer but keeps your
  draft — the next composer you open restores it. Only the explicit **Cancel**
  button discards text. Drafts also survive page reloads.
- **If sending fails** (bad network, dead webhook): the pin turns red, you get
  **Retry** and **Copy your comment**, and the unsent comment survives page
  reloads — it comes back with Retry/Discard buttons in the drawer.

## Pins

Pins are the reviewer's marks and they stay on the page — dimmed when nothing
is happening, full-strength while you're commenting or browsing them.

- **Hover** (or keyboard-focus) a pin to see its comment text in a tooltip.
- **Click** a pin to open its thread right there: the comment, any replies,
  and Follow up / Retry / Discard actions. Esc, clicking elsewhere, or
  clicking the pin again closes it.
- Badge colours: **accent** = delivered, **red** = not sent yet.
- Pins re-attach to the element they were about, so they stay accurate across
  window resizes and reloads (when the element still exists).

## The drawer

Once at least one comment exists, a small list button appears above the
trigger with a count badge (the badge turns **red** while anything is
unsent). It opens a right-hand drawer listing every comment:

- Click an entry to smooth-scroll to its pin and pulse it (the drawer gets out
  of the way if it would cover the pin).
- **Follow up** on any comment opens a reply composer — the reply joins that
  comment's thread, shown nested (↳) under it. Replies don't add new pins to
  the page; the original pin is the thread's marker, and it's highlighted
  while you compose the reply.
- Failed entries carry **Retry** (resends, keeping the original written-at
  time) and **Discard**.
- **Hide pins / Show pins** in the drawer header clears the page markers when
  they're in the way (entering comment mode always shows them again so you
  don't double-pin).
- **Esc** or **Close** dismisses the drawer.

## Keyboard reference

| Key | Where | Does |
| --- | --- | --- |
| Enter / Space | trigger focused | enter comment mode |
| Esc | composer open | close composer, **keep draft** |
| Esc | comment mode, no composer | leave comment mode |
| Esc | drawer or thread popover open | close it (focus returns) |
| Cmd/Ctrl+Enter | composer | send |
| Tab / Shift+Tab | composer | cycle fields (focus is trapped in the dialog) |

Focus is always returned where it came from (trigger, toggle, or pin), and
every control has a visible focus ring.

## Touch

Everything works with tap in place of click. On small screens (≤640px) the
composer becomes a bottom sheet and the drawer goes full-width.

## What reviewers never have to do

Create an account. Install anything. Grant permissions. Understand the tool.
The entire learning curve is "click the spot, type, send" — and the structured
context (which element, which section, which build, what errors were on the
page) is captured automatically without them knowing it exists.
