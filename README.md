# Monster Energy tracker

A DSH bundle that keeps a durable count of the Monster Energy cans you have consumed.

## Use it

- `/monster` logs one can.
- `/monster 2` logs two cans.
- `/monster status` shows the total and today's count.
- `/monster undo` removes the most recently logged entry; a multi-can log such as `/monster 3` counts as one entry.
- Or talk to the agent: "I just drank a Monster" or "How many Monsters have I had today?" — it calls the `monster_energy` tool.

Both the command and the tool update the same ledger, so either entry point shows the same figures.

## The floating can

A small can card floats over the interface, starting at the bottom-left. Drag it anywhere with a mouse, pen, or finger; its position is saved in this browser and restored on reload. Double-click (or press Enter) to reset it to the default corner. When focused, the arrow keys nudge it 10 px and Shift+arrow 40 px.

The card shows a simple inline-SVG energy-drink can, today's count, and the running total. It polls the read-only `GET /monster-tracker/state` route every three seconds and refreshes when the page becomes visible or focused. Zero cans shows a dimmed can. On narrow screens the card stays within the viewport.

The card is a Web Client plugin; after changing [client.js](client.js), refresh the page. The can is drawn inline as SVG, so it needs no image file, asset route, or build step.

## Where the data lives

The ledger is `$DSH_HOME/monster-tracker.json` (by default `~/.dsh/monster-tracker.json`). It is a small JSON file that survives restarts, plugin removal, and DSH upgrades. Deletes only happen when you use `undo` or delete the file yourself. Today's count uses the host's local time zone.

If the file cannot be read, it is renamed to `monster-tracker.json.corrupt-<timestamp>` instead of being overwritten, and the next result tells you where it went.

The plugin makes no network requests, adds no periodic model requests, and adds one tool definition to each model request while the bundle is enabled.

### Limits

The ledger is cached per running DSH process. Run one server against a given `$DSH_HOME`; two processes logging at the same time can replace each other's latest update.

## Install

From the DSH profile that should use it:

```sh
dsh plugin --profile <profile> add link:/root/plugins/monster_energy_plugin
```

or use **Plugins** > **Add plugin** with this directory.
