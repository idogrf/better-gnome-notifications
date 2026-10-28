# Better GNOME Notifications

A GNOME Shell extension that turns notification banners into a stack of narrow,
frosted cards in the corner you pick, tinted with each app's color. Each card
leaves when its own timer runs out; hovering the stack fans it out and pauses
every timer. Critical notifications get a red outline and glow.

It also replaces what Notification Configurator was used for here: rate
limiting banner bursts, filtering notifications by rule, and keeping one
notification-list entry per notification.

## Why this exists

GNOME's banners are wide, centered at the top, and show one at a time. A burst
of notifications queues up behind the first one, and anything past three
waiting is dropped from banners altogether. Extensions that restyle banners
mostly recolor that single slot.

This one takes the banner over entirely: position, look, timing and stacking.

## What it does

- **Stack.** Up to 5 cards (configurable, 1 to 5), newest in front, the older
  ones peeking out behind it. A full stack is 1.3 times the height of its front
  card, so more cards means thinner edges, not a taller stack. When a new
  notification goes past the limit, the oldest banner leaves early; the
  notification stays in the list.
- **Timers.** Each card counts down on its own: 5 seconds by default, 30 for
  critical notifications. An optional line on each card shrinks as its time runs
  out. Like GNOME's own banner, a timer doesn't start while you're away from the
  keyboard.
- **Hover.** Hovering the stack fans it out into a column and pauses every
  timer. The card under the pointer expands to show its full body and buttons.
  Right-clicking a card clears it, like its close button.
- **Look.** Front card frosted (a blurred view of what's behind it), cards
  behind it plain glass. Dark or light tone, two text sizes, width and corner
  radius. Banners slide in from the screen edge.
- **App rules.** Checked in order; the first match decides. A rule matches on
  the app name, title and body (case-insensitive regular expressions), gives the
  card its color, and can show the notification, put it in the list without a
  banner, or block it. Web apps match on body text, since browsers send every
  site's notifications under the browser's name.
- **Rate limit.** After a sender shows a banner, its next notifications skip the
  banner for 2 seconds (configurable) and only go to the list. A matched rule
  counts as its own sender, so a WhatsApp message doesn't hold up a Gmail one.
- **One entry per notification.** The notification list normally groups each
  app's notifications together; this turns that off. Configurable.
- **Matching list.** Entries in the date menu's notification list take the
  banners' look: app color, tone, glass, text size and corner radius. Frost
  shows as plain glass there, since the menu is solid behind them. The media
  player stays as GNOME draws it. Can be turned off.

Do Not Disturb and fullscreen still let only critical notifications through,
and banners hide while the notification list is open. Notifications that
arrive while the screen is locked show as banners once it unlocks; for that
the extension keeps running on the lock screen (without showing anything
there), since GNOME would otherwise queue them and show stock banners.

## Install

```bash
git clone https://github.com/idogrf/better-gnome-notifications.git \
    ~/.local/share/gnome-shell/extensions/better-gnome-notifications@idogr
cd ~/.local/share/gnome-shell/extensions/better-gnome-notifications@idogr
glib-compile-schemas schemas/
```

Log out and back in — a new extension directory is only discovered when the
shell starts — then enable it:

```bash
gnome-extensions enable better-gnome-notifications@idogr
```

Disable any other extension that moves or restyles banners (Notification
Configurator, Notification Banner Position, and the like); they'd fight over
the same banners.

## Settings

Open the gear icon in Extensions Manager, or `gnome-extensions prefs
better-gnome-notifications@idogr`.

Each page opens with a preview: a corner of your wallpaper with the stack
drawn in the chosen position, look and size, redrawn as you change settings.

- **Appearance:** position, material and tone as picture choices; text size,
  width, corner radius, color style and entrance.
- **Apps:** the rules, each with a color picker, an action and a **Test**
  button. The defaults cover Slack, WhatsApp, Gmail, Google Calendar, Claude
  Code and Gantry.
- **Behavior:** stack size, normal and critical timeouts, the countdown line,
  rate limit, grouping, and whether the notification list matches the banners.

**Send burst** (Appearance and Behavior) sends notifications from your first
few rules, then a critical one. A rule's **Test** sends one notification built
so the rule's patterns match it, and says when something will keep it from
showing a banner: an earlier rule matching first, the rule's action, Do Not
Disturb or the rate limit. For a pattern too complex to build a match from,
the button turns off. Tests go out through `notify-send` (from libnotify), so
they carry the app name the rule expects.

Rules are stored as JSON in the `rules` key, so they can also be set with
`gsettings`:

```json
[{"name": "Slack", "app": "^Slack$", "title": "", "body": "",
  "color": "#5b8def", "action": "show"}]
```

`action` is `show`, `silence` (list only, no banner) or `block`.

## Uninstall

```bash
gnome-extensions disable better-gnome-notifications@idogr
rm -rf ~/.local/share/gnome-shell/extensions/better-gnome-notifications@idogr
dconf reset -f /org/gnome/shell/extensions/better-gnome-notifications/
```

## How it works

The shell's message tray decides whether a notification gets a banner in
`_onNotificationRequestBanner`. The extension overrides that method and hands
the notification to its own stack (`deck.js`) instead of the tray's single
banner slot. Each card wraps the shell's own `NotificationMessage` widget, so
clicking, closing, expanding and action buttons behave as they do in GNOME.

Rules (`rules.js`, shared with the settings window so its tests match the same
way) and the rate limit run earlier, in `Source.addNotification`: marking a
notification acknowledged before the source asks for a banner skips the banner
while the notification still lands in the list.

The notification list's entries are the same `NotificationMessage` widget.
The extension styles each one as the list adds it (an override of
`NotificationMessageGroup._addNotification`), restyles them all when a setting
changes, and restores the stock look when turned off.

GNOME's background blur can't be given rounded corners: masking it needs an
offscreen pass, which hides the framebuffer the blur reads from. So the
frosted backdrop (`backdrop.js`) blurs a live clone of the window group,
offset to line up with the real desktop, and masks that with a small
rounded-rectangle shader.

Drop shadows come from a separate rounded layer under each card. On the banner
itself St draws the shadow square, because the banner's fill is a gradient or
see-through, and it shows around the corners and through the glass.

## Adding a color style or an entrance

The choices live in `options.js`. To add one, list it there, add it to the
key's `<choices>` in the schema, and implement it in `STYLES` (`look.js`) or
`ENTRANCES` (`deck.js`). The settings preview draws cards itself
(`Preview` in `prefs.js`), so a new color style needs drawing there too.

## Testing

Run it in a nested shell rather than your session, with its own settings and
extensions folder so nothing touches the real session:

```bash
export XDG_CONFIG_HOME=/tmp/bgn/config XDG_DATA_HOME=/tmp/bgn/data
mkdir -p $XDG_DATA_HOME/gnome-shell/extensions
ln -s "$PWD" $XDG_DATA_HOME/gnome-shell/extensions/better-gnome-notifications@idogr
dbus-run-session -- bash -c '
    dconf write /org/gnome/shell/enabled-extensions "[\"better-gnome-notifications@idogr\"]"
    gnome-shell --devkit --wayland'
```

Then send notifications on that session's bus with `notify-send`
(`-u critical` for a critical one). GNOME can't reload a changed extension, so
restart the nested shell after each change.

## Caveats

- **The message tray internals are private API.** `_onNotificationRequestBanner`,
  `Source.addNotification`, the notification daemon's source lookup and the
  notification list's internals carry no
  stability promise. A GNOME refactor could make banners stop appearing, or
  make the rules and rate limit inert, without anything being logged.
- **The frosted backdrop only blurs windows and the wallpaper.** Over the
  overview it would show the desktop instead of what's behind it, so banners
  that arrive there use plain translucent glass. The top bar and dock aren't
  part of the blur either.
- **Only the front card is frosted**, to keep the blur to one card's worth of
  work.
- **`shell-version` currently declares `50` only.** On a newer shell the
  extension silently stops loading until the version is added and it is
  re-verified.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
