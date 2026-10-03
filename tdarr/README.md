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

**Dolby Vision Profile 5** (added 2026-10-03) is the one case that isn't about
the codec. P5 is HEVC Main 10, but its base layer is in Dolby's IPTPQc2 colour
space with no HDR10 fallback, so the Shield shows purple/green or Plex fails to
transcode it. Profiles 7 and 8.x carry an HDR10-compatible base layer and are
left alone. A P5 video stream (detected from the `DOVI configuration record`
in ffprobe's `side_data_list`) is converted to plain HDR10 HEVC: libplacebo
applies the RPU and converts to BT.2020/PQ on the iGPU via Vulkan, and
`hevc_qsv` encodes at 18 Mbps VBR. Audio and subtitles are still copied. This
needs `/dev/dri` in the tdarr-node containers (see `compose.yml`); without it
Vulkan silently falls back to lavapipe on the CPU at ~3 fps. With it, a 50-min
4K episode takes ~2 h (~10 fps; decode stays on the CPU because the P630 has
no Vulkan video decode). DV is lost -- the output is HDR10 only -- which is the
trade for it playing everywhere. Sonarr's `DV without HDR10 fallback
(Profile 5)` custom format (-1000) keeps these from being grabbed when any
other release of the same quality exists, and upgrades the ones that slip
through; this conversion is the fallback for when nothing else is available.

It runs on the **Flow** engine, not Tdarr's classic plugin stack. The classic
engine's implicit "replace original file" step turned out to be unreliable on
this install (ffmpeg would succeed but the file was never actually replaced --
see git history / session notes from 2026-09-16 for the debugging trail). The
Flow engine's explicit `Replace Original File` node does the move/copy with
proper cross-filesystem fallback and doesn't have that problem.

A file with none of those tracks used to still be run through `Execute` and
`Replace Original File` anyway -- a no-op remux-and-swap that wastes a full
transcode slot and a full-size temp file in `/temp` for a file that needed no
change. `Route If Should Process` (added 2026-09-20) skips that: it checks
`ffmpegCommand.shouldProcess` right after the check plugin and only continues
to `Execute` when something was actually flagged.

## Files

- `plugins/video/checkFixIncompatiblePlayback/1.0.0/index.js` -- the custom
  Flow plugin. Deployed on the live server at
  `/tank/tdarr/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/video/checkFixIncompatiblePlayback/1.0.0/index.js`.
  Must run after "Begin Command" (`ffmpegCommandStart`) and before "Execute"
  (`ffmpegCommandExecute`) in the flow graph -- it works by mutating
  `args.variables.ffmpegCommand.streams[*].outputArgs` for the streams that
  need fixing, and leaves the rest as `removed: false` / empty `outputArgs`,
  which `ffmpegCommandExecute` defaults to stream copy.

- `plugins/video/routeIfShouldProcess/1.0.0/index.js` -- router plugin.
  Deployed on the live server at
  `/tank/tdarr/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/video/routeIfShouldProcess/1.0.0/index.js`.
  Runs right after "Check And Fix Incompatible Playback" and reads
  `args.variables.ffmpegCommand.shouldProcess`: output 1 (still needs a fix)
  continues to "Execute"; output 2 (no VC-1/AV1/VP9/DV-P5/TrueHD streams found) has
  no outgoing edge, so the file is left untouched instead of being run through
  a no-op remux + Replace Original File.

- `flow-jp-fix-incompatible-playback.json` -- export of the Flow definition
  itself (`FlowsJSONDB` doc id `jp01fixflow`), which wires these plugins into:
  `Input File -> Begin Command -> Check And Fix Incompatible Playback -> Route If Should Process -> Execute -> Replace Original File`.
  Assigned to the TV library via its `flowId` field, with
  `decisionMaker.settingsFlows: true` / `settingsPlugin: false`.

- `flow-jp-movies-dv5.json` -- the Movies library's Flow (`FlowsJSONDB` doc
  id `jp02moviesdv5`, added 2026-10-03). Same graph, but the check plugin's
  `fixLegacyCodecs` input is `false`, so only DV Profile 5 is converted.
  The full fix set would have rewritten 171 movies (~5.1 TB), turning
  TrueHD/Atmos remuxes into lossy EAC3 without Atmos and re-encoding VC-1
  to H.264 -- all things the Shield plays natively.

Both libraries set `foldersToIgnore: ".tdarr_cache"`. The cache lives inside
each library (see step 4 below), and without this the hourly scan picked up
an in-progress transcode's temp file and queued it as a library file.

The server-side scan currently stores only a lean `ffProbeData` (codec,
type, size -- no `index`, no `side_data_list`) for records it creates, so
the DB alone can't be used to find DV Profile 5 files. That doesn't affect
processing: each transcode worker re-scans the file on the node before the
flow runs, and the plugins see full ffprobe data.

## Redeploying from scratch

If `tank/tdarr` is ever lost without a ZFS snapshot to restore from:

1. Copy `plugins/video/checkFixIncompatiblePlayback/1.0.0/index.js` and
   `plugins/video/routeIfShouldProcess/1.0.0/index.js` to the same paths under
   Tdarr's `Plugins/FlowPlugins/LocalFlowPlugins/` on the server, then
   `POST /api/v2/sync-plugins` so they're picked up.
2. Recreate the Flow: `POST /api/v2/cruddb` with
   `{"data":{"collection":"FlowsJSONDB","mode":"insert","docID":"jp01fixflow","obj":<contents of flow-jp-fix-incompatible-playback.json, minus the array wrapper>}}`.
3. On the TV library (`LibrarySettingsJSONDB`), set `flowId: "jp01fixflow"` and
   `decisionMaker.settingsFlows: true` / `settingsPlugin: false`. Same for the
   Movies library with `flowId: "jp02moviesdv5"` (recreate that Flow from
   `flow-jp-movies-dv5.json` as in step 2). Set `foldersToIgnore:
   ".tdarr_cache"` on both.
4. Point each library's `cache`/`output` at a folder *inside* that library's
   own media path (e.g. `/media/tv/.tdarr_cache`) rather than `/temp` --
   `/temp` is a different filesystem (the host's `/var`, not `tank`), and a
   cross-filesystem rename throws `EXDEV` in Node, which is not handled
   gracefully by every code path. Note this only covers the folder-to-folder
   `cache`/`output` fields -- the Flow engine's own scratch work directory for
   a transcode still comes from the node's configured temp path (`/temp`,
   i.e. `/var/tdarr` on the host), which stays a different filesystem from
   `tank/tv`/`tank/movies` regardless of this setting. See session notes from
   2026-09-20 for a `/temp` (host `/var`, ~246G) ENOSPC incident that caused
   this same "cache file vanished before the move step" symptom.
5. Set worker limits (`healthcheckcpu`/`transcodecpu`) on each node via
   `POST /api/v2/update-node` -- these reset to 0 on a node's first boot with
   an empty config volume (which is why `tdarr-node-1`/`-2` in `compose.yml`
   each get their own persistent `/app/configs` volume: so this step is only
   ever needed once per node, not once per restart).
