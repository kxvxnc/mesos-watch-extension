# Mesos Watch Alerts

A Chrome extension that watches item prices on mesos.watch and alerts you when something hits your target.

## Install
1. Unzip this folder somewhere permanent (Chrome loads it from there).
2. Go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `mesos-alerts` folder.
4. Pin the extension from the puzzle-piece menu so the icon is visible.

## Use
1. Open https://mesos.watch in a tab and **pin the tab** (right-click the tab > Pin).
2. Click the extension icon, search for an item by name (or type its 7-digit ID), and press Enter.
3. Type a target in "alert ≤" (`500k`, `1.2m`, `2b` all work). Leave it blank to just track the price.

The badge shows how many items are at or under target. Clicking a notification jumps to the mesos.watch tab.

**Settings:** check interval (30 s minimum, 60 s default), an optional "X% under typical price" alert that applies to every item, notifications on/off, and a CSV export of the price log (one row each time an item's cheapest price changes).

## How it works
It runs inside your open mesos.watch tab and calls the site's own `LIVE.summary(...)`, so requests go through the site's normal session, Turnstile check and renewal. Up to 60 items cost one request per check. With several mesos.watch tabs open, only one does the checking.

## If the badge says "off"
- No mesos.watch tab is open, or Chrome put it to sleep. In `chrome://settings/performance`, add `mesos.watch` under "Always keep these sites active".
- After reloading or updating the extension, reload the mesos.watch tab too.
- If the site changes its code and `LIVE` goes away, the popup will show an error saying so.

Note: "cheapest" is whatever the site's summary reports; for stackable items check on the site whether that's per item or per bundle before setting tight targets.
