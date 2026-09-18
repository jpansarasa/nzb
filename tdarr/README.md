# Tdarr custom Flow: fix incompatible playback tracks

Reference copy of Tdarr application state that isn't managed by `compose.yml` --
it lives in Tdarr's own SQLite DB and plugin folder on `tank/tdarr`, covered by
ZFS snapshots but with no git history of its own until now. This directory is
not consumed by `docker compose`; nothing here is mounted or read by the
running stack. It exists purely as a source-of-truth backup and change log.

## What this fixes

Some TV files fail to play on certain Plex clients because of legacy/rare
tracks: VC-1, AV1 or VP9 video, and TrueHD/Atmos audio. This flow re-encodes
only those specific tracks (video -> H.264, TrueHD audio -> EAC3 5.1) and
stream-copies everything else, so the fix is narrow -- it never touches files
that don't have one of these tracks.

It runs on the **Flow** engine, not Tdarr's classic plugin stack. The classic
engine's implicit "replace original file" step turned out to be unreliable on
this install (ffmpeg would succeed but the file was never actually replaced --
see git history / session notes from 2026-09-16 for the debugging trail). The
Flow engine's explicit `Replace Original File` node does the move/copy with
proper cross-filesystem fallback and doesn't have that problem.

## Files

- `plugins/video/checkFixIncompatiblePlayback/1.0.0/index.js` -- the custom
  Flow plugin. Deployed on the live server at
  `/tank/tdarr/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/video/checkFixIncompatiblePlayback/1.0.0/index.js`.
  Must run after "Begin Command" (`ffmpegCommandStart`) and before "Execute"
  (`ffmpegCommandExecute`) in the flow graph -- it works by mutating
  `args.variables.ffmpegCommand.streams[*].outputArgs` for the streams that
  need fixing, and leaves the rest as `removed: false` / empty `outputArgs`,
  which `ffmpegCommandExecute` defaults to stream copy.

- `flow-jp-fix-incompatible-playback.json` -- export of the Flow definition
  itself (`FlowsJSONDB` doc id `jp01fixflow`), which wires this plugin into:
  `Input File -> Begin Command -> Check And Fix Incompatible Playback -> Execute -> Replace Original File`.
  Assigned to the TV and Movies libraries via each library's `flowId` field,
  with `decisionMaker.settingsFlows: true` / `settingsPlugin: false`.

## Redeploying from scratch

If `tank/tdarr` is ever lost without a ZFS snapshot to restore from:

1. Copy `plugins/video/checkFixIncompatiblePlayback/1.0.0/index.js` to the
   same path under Tdarr's `Plugins/FlowPlugins/LocalFlowPlugins/` on the
   server, then `POST /api/v2/sync-plugins` so it's picked up.
2. Recreate the Flow: `POST /api/v2/cruddb` with
   `{"data":{"collection":"FlowsJSONDB","mode":"insert","docID":"jp01fixflow","obj":<contents of flow-jp-fix-incompatible-playback.json, minus the array wrapper>}}`.
3. On each library (`LibrarySettingsJSONDB`), set `flowId: "jp01fixflow"` and
   `decisionMaker.settingsFlows: true` / `settingsPlugin: false`.
4. Point each library's `cache`/`output` at a folder *inside* that library's
   own media path (e.g. `/media/tv/.tdarr_cache`) rather than `/temp` --
   `/temp` is a different filesystem (the host's `/var`, not `tank`), and a
   cross-filesystem rename throws `EXDEV` in Node, which is not handled
   gracefully by every code path.
5. Set worker limits (`healthcheckcpu`/`transcodecpu`) on each node via
   `POST /api/v2/update-node` -- these reset to 0 on a node's first boot with
   an empty config volume (which is why `tdarr-node-1`/`-2` in `compose.yml`
   each get their own persistent `/app/configs` volume: so this step is only
   ever needed once per node, not once per restart).
