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

**Settings page:** your items and what's under target right now, check interval (30 s minimum, 60 s default), an optional "X% under typical price" alert for every item, and notifications on/off.

**Equip stats:** each equip on the settings page has a stat filter. Pick a stat, type a minimum and click Add (for example W.ATK ≥ 20, then Slots ≥ 7): only listings that meet every minimum alert. Click × on a minimum to remove it. Alerts, notifications and Discord posts for equips show the listing's stats. Changing the filter works like changing the target: listings already up don't alert.

**Piece minimum:** items that stack (ETC, use, setup…) have an "Only alert with at least … pieces" box instead. A shop's offer alerts only if it has that many pieces in all at that price: its stacks are added up, so three stacks of 100 meet a minimum of 250. Leave it empty for any amount. Changing it works like changing the target.

**Pausing:** each item on the settings page has an on/off switch, and "Alerts on" at the top of the list (or the pause button in the popup) pauses everything. Targets are kept. While everything is paused the tab makes no requests. Listings that went up while paused don't alert when you resume.

**Any NX equip:** under Settings, "Alert for any NX equip listed at or under …" watches every NX equip without adding each one: the same items as the site's Live feed set to Equips › NX equips (NX hats, tops, capes, rings…; not NX weapons). Every new offer at or under that price each alerts, like a watched item's. It reads them on every check, like your watched items. The site sends the newest listings first, capped, so an offer counts as new only if it was listed after you turned this on. Items on your watchlist keep their own target instead. Empty turns it off.

**Sharing your list:** on the settings page, "Share your list" has **Copy list** (paste it in Discord or a note) and **Download file** (a small `.json`). On the other machine, or another player's, paste it into the Import box or click **Choose file…**. It shows what will change first, then **Add to my list** (adds new items; items you already watch take the imported target and keep their on/off) or **Replace my list** (your list becomes the imported one). Only items, targets, stat filters and piece minimums are shared: never your Discord webhook, or alerts. Listings already up when you import don't alert.

**Discord (optional):** paste a channel webhook URL on the settings page (Discord: channel settings > Integrations > Webhooks > New Webhook > Copy Webhook URL), click Save and allow Chrome to post to Discord, then "Send test". Each check with new alerts posts one message with a card per alert (up to 10 a message). The on/off switch in that section pauses Discord posts and keeps your webhook; clear the field and Save to remove it.

## How it works
It runs inside your open mesos.watch tab and calls the site's own helpers, so requests go through the site's normal session, Turnstile check and renewal. Each check makes one summary request for up to 60 items. For items that may have a listing under the target, it also fetches all of that item's listings on every channel, and alerts once for each new listing at or under the target: price each, bundle size, channel, room and seller. With several mesos.watch tabs open, only one does the checking.

## If the badge says "off"
- No mesos.watch tab is open, or Chrome put it to sleep. In `chrome://settings/performance`, add `mesos.watch` under "Always keep these sites active".
- After reloading or updating the extension, reload the mesos.watch tab too.
- If the site changes its code and `LIVE` goes away, the popup will show an error saying so.

Targets are compared with the price **each**: a bundle of 100 for 5m counts as 50k.
