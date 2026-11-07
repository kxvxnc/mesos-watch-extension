# Mesos Watch Alerts

A Chrome extension that watches item prices on mesos.watch and alerts you when something hits your target.

## Install
1. Unzip this folder somewhere permanent (Chrome loads it from there).
2. Go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `mesos-alerts` folder.
4. Pin the extension from the puzzle-piece menu so the icon is visible.

## Use
1. Open https://mesos.watch in a tab and **pin the tab** (right-click the tab > Pin).
2. Click the extension icon, then **⚙** (or right-click the icon > Options) to open the settings page in its own tab.
3. Search for an item by name (or type its 7-digit ID) and press Enter, then type a target in "alert at or under" (`500k`, `1.2m`, `2b` all work).

You get an alert for each new listing at or under the target, as the price each. Listings already up when you set the target show on the settings page but don't alert.

**The popup** lists new alerts, newest first: price, channel, room, seller and when it was listed. Click × to dismiss one or **Clear all**. An alert whose listing is gone is grayed out. The badge shows how many alerts are waiting; clicking an alert or a notification jumps to the mesos.watch tab.

**Settings page:** your items and what's under target right now, check interval (30 s minimum, 60 s default), an optional "X% under typical price" alert for every item, notifications on/off, and a CSV export of the price log (one row each time an item's cheapest price changes).

## How it works
It runs inside your open mesos.watch tab and calls the site's own helpers, so requests go through the site's normal session, Turnstile check and renewal. Each check makes one summary request for up to 60 items. For items that may have a listing under the target, it also fetches all of that item's listings on every channel, and alerts once for each new listing at or under the target: price each, bundle size, channel, room and seller. With several mesos.watch tabs open, only one does the checking.

## If the badge says "off"
- No mesos.watch tab is open, or Chrome put it to sleep. In `chrome://settings/performance`, add `mesos.watch` under "Always keep these sites active".
- After reloading or updating the extension, reload the mesos.watch tab too.
- If the site changes its code and `LIVE` goes away, the popup will show an error saying so.

Targets are compared with the price **each**: a bundle of 100 for 5m counts as 50k.
