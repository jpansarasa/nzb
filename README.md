# nzb

The acquisition stack — sabnzbd, sonarr, radarr, tdarr (server + 2 nodes) and
ombi — run as Docker containers under one systemd unit.

## Layout

| File | Role |
| --- | --- |
| `install` | Idempotent installer. Run it for the first deploy and after every change. |
| `compose.yml` | The six service definitions and ten bind volumes. |
| `nzb.service` | Owns the stack. Does **not** pull on start. |
| `check-update` | Pulls the configured tags, compares to what is running, **stages** (never applies). |
| `apply-update` | Applies a staged update to **one** service, snapshotting its dataset first. |
| `nzb-update.{service,timer}` | Daily update check, off the boot critical path. |
| `health-check` | Per-service liveness. Exists because six services share one unit. |
| `nzb-health.{service,timer}` | Runs the above every 5 minutes. |

Paths are pinned: the unit hardcodes `/opt/nzb`, and `install` refuses to run
from anywhere else.

## What is not in this repo

`/tank/nzb/images.env` — the bind address and the five image pins. Not secret,
but deployment-specific. `install` seeds it and refuses to converge until
`NZB_BIND_ADDR` is filled in.

It lives on the dataset so it travels with the pool, and `install` renders a
**filtered** copy to `/etc/nzb/images.env`, which is the only one systemd reads.
That split is not decoration: systemd opens `EnvironmentFile=` in **PID 1
itself**, and `tank` is `failmode=wait`, so a file on the pool lets a faulted
pool wedge PID 1. The filter matters too — `EnvironmentFile=` is applied *after*
`Environment=`, so an unfiltered file could redefine anything in the unit.

The real credentials — the Usenet provider login in `/tank/sabnzbd/sabnzbd.ini`,
and the API keys in `/tank/{sonarr,radarr}/config.xml` — belong to the apps and
have never been in this repo. `.gitignore` is deliberately broad about
credential-shaped names, and `install` additionally refuses to run if it finds
one sitting in the repo directory, because no pattern list catches every name
someone might use while debugging.

## Updates are staged, not applied

**This unit used to pull on start.** `ExecStartPre=-… docker compose … pull` ran
on every start, which meant every `systemctl restart`, every `sudo ./install`,
and every 30-second retry of a crash loop silently adopted whatever upstream had
published — for six services at once. Sonarr and Radarr migrate their databases
*forward* on startup and do not migrate down, so a routine restart was an
unattended, irreversible upgrade of a library database with no rollback point.

Now `check-update` runs daily, compares each running container against the tag it
would actually start, and writes `/run/nzb-update-available` listing only the
services whose image moved. Nothing is recreated. Apply one at a time:

```bash
cat /run/nzb-update-available
sudo /opt/nzb/apply-update sonarr
```

`apply-update` snapshots that service's dataset first and then recreates **only**
that service with `--no-deps`, so taking a Sonarr update does not also kill a
three-hour transcode or an eighty-percent-complete download. The snapshot is what
makes a forward-only migration reversible.

> If you edit `nzb.service` on an older host and the pull seems to come back:
> there was an untracked drop-in at
> `/etc/systemd/system/nzb.service.d/pull-not-on-boot.conf` that reset
> `ExecStartPre=` and re-added a gated pull. `install` removes it. While it
> existed, deleting the pull from the unit appeared to do nothing.

### Pinning a bad release

```bash
sudo sed -i 's|^SONARR_TAG=.*|SONARR_TAG=4.0.15.2941|' /tank/nzb/images.env
sudo /opt/nzb/install
```

Tags are per service, because six images from two registries move independently
— except tdarr and tdarr-node, which share `TDARR_TAG` because they are released
as a matched pair and must never be pinned apart.

## Ports bind one address

Every published port binds `NZB_BIND_ADDR`, and the compose fallback is
loopback, which is fail-closed.

This matters most for **tdarr, which has no authentication of any kind**.
Measured on this host before the change: `GET /api/v2/get-nodes` returned live
node configuration with no credential, and `/api/v2/cruddb` — a generic database
read/write endpoint — answered 200, in a process holding `/export/tv` and
`/export/movies` read-write. Sonarr, radarr and sabnzbd *do* enforce
authentication (401, 401 and 403 respectively when probed without a key), so for
them the scoping is defence in depth rather than a hole being closed.

tdarr's port 8266 is no longer published at all. It is the node API, and
tdarr-node reaches it as `tdarr` over the compose network, so publishing it
exposed an unauthenticated endpoint for no benefit.

Note Docker publishes ports by DNAT ahead of the INPUT chain, so a host firewall
does not cover these without an explicit `DOCKER-USER` rule. Binding one address
is the control that actually applies.

## Identities

Every service has its own host account, and the container `PUID`/`PGID` match it
exactly. `PGID` is the shared `media` group (1500) for everything that touches
the media or download trees; ombi uses its own group because it touches neither.

| Service | uid | gid | Host account |
| --- | --- | --- | --- |
| ombi | 2000 | 2000 | ombi |
| sonarr | 2001 | 1500 | sonarr |
| radarr | 2002 | 1500 | radarr |
| sabnzbd | 2003 | 1500 | sabnzbd |
| tdarr, tdarr-node | 2005 | 1500 | tdarr |

(2004 is plex, in `/opt/plex`.)

**tdarr used to run as 2001 — sonarr's uid — with no `tdarr` account existing.**
Everything it wrote to the shared trees was therefore owned by `sonarr`, so
ownership could not distinguish the two. Sonarr's config dataset is not mounted
into tdarr, so its API key was never reachable; the problem was identity on the
shared trees, not config access. It now has uid 2005 and owns `/tank/tdarr` and
`/var/tdarr`.

`install` asserts every one of these rather than only creating them, because an
account at the wrong uid produces a container that cannot read its own config —
a failure that shows up at runtime rather than at deploy time.

## The media contract

This repo owns the services that **write** `/export/tv` and `/export/movies`, so
it owns the contract `/opt/plex` reads them through. Two mechanisms are in play
and they are easy to conflate:

**Within this stack, the `media` group (gid 1500) is load-bearing.** sabnzbd,
sonarr, radarr and tdarr all run with `PGID=1500` and hand files to each other
through it.

**For Plex, the group does nothing.** Plex's supplementary groups come from its
own image, so gid 1500 never reaches the process — `/opt/plex` measured this and
corrected its README accordingly. What Plex reads through is the **world** bits.

`UMASK_SET=002` is now set on every service that writes shared trees, not just
tdarr. That single value satisfies both requirements: `0775`/`0664` is
group-writable (this stack) *and* world-readable (Plex). Leaving it to the image
default made a contract two repos depend on into an accident of which image
happened to ship which default.

The umask is only half of it, though. Sonarr and Radarr both have
`setPermissionsLinux` enabled and apply their own `chmodFolder` on import, which
overrides whatever the umask produced — and the two were **set differently**:
Sonarr at `755`, Radarr at `775`. That is not cosmetic. Sonarr's setting strips
group-write, and it had produced 13,470 files on `/export/tv` at `0644` against
11,833 at `0664` — so roughly half the TV library could not be modified by any
other member of the `media` group. Radarr's `775` was correct. Sonarr is now
`775` to match, and the existing drift has been repaired. Both set `chownGroup`
to 1500, which was already right.

Check them together if either is ever changed; a umask and a `chmodFolder` that
disagree is a silent, slow divergence rather than an error.

### The download handoff tree

`/tank/downloads` is `2775` with the setgid bit, and `install` repairs group
ownership and group-write drift beneath it.

It used to run `chown -R sabnzbd:media /tank/downloads` on every run. That was
both expensive — 692 GB — and actively harmful: it rewrote the *owner* of files
sonarr and radarr had created, without touching modes, so any directory lacking
group-write became unwritable to everyone but sabnzbd. Sonarr logged 183
`UnauthorizedAccessException` failures across 51 log files against its recycle
bin as a direct result. What makes a shared tree work is the group plus setgid,
so new directories inherit `media`, not a uniform owner.

### A note on hardlinks

Both Sonarr and Radarr have `copyUsingHardlinks` enabled, and it never takes
effect. `/tank/downloads` and `/export/{tv,movies}` are separate ZFS datasets,
which are separate filesystems, so a hardlink across them fails `EXDEV` and both
apps silently fall back to a full copy — confirmed by test, and by the fact that
no file under `/export/tv` has a link count above 1.

It is left enabled deliberately: it costs nothing, and it would start working if
the layout ever changed. But be aware that every import copies the whole file
rather than linking it, which doubles the write and means a recycled file is a
full second copy rather than a reference.

## One unit, six services

They share a unit, and that is a real trade rather than an oversight. The cost is
specific and was measured: `docker compose up` runs attached and does not exit
while **any** service is still running, so killing radarr left `nzb.service` at
`active`, `Result=success`, `NRestarts=0`. Removing the compose `restart:`
policy was necessary — two supervisors made crash-loops invisible, as ntfy
`fdd3118` documents — but it does **not** make one service's death visible.

`health-check` closes that. Every five minutes it verifies each service is
running (including both tdarr-node replicas), logs anything missing at priority
`err`, and recreates it with `--no-deps`. That is the per-service equivalent of
the `Restart=always` the sibling repos get for free, and a service that keeps
dying produces a repeated journal entry rather than a silent gap.

It refuses to act within four minutes of the unit going active, because the unit
goes active the moment `compose up` is exec'd — long before six containers have
started — and a check firing in that window "fixes" services that were already
coming up. It was observed doing exactly that before the guard was added.

```bash
journalctl -p err -u nzb-health -n 20     # what is actually down
```

## Backups

The six config datasets (`tank/{ombi,sonarr,radarr,sabnzbd,tdarr,nzb}`) carry
`com.sun:auto-snapshot:monthly=true` and are replicated nightly. `install` now
asserts that property **locally** on every run: they previously carried it with
source `received`, inherited from the sending side, which meant a rebuilt host
would have had no policy at all while `zfs get` still showed `true`.

`tank/downloads` is deliberately **not** snapshotted and **not** replicated, and
it is worth being precise about why, because it is not simply scratch. It is two
things: the handoff area between sabnzbd and sonarr/radarr, and the shared
**recycle bin** those two use for soft deletes. The recycle bin is the larger
part by a wide margin — 634 GB of the 692 GB, holding deletions going back to
August 2023.

It stays local because it is a convenience layer on top of protection that
already exists, not a backup in its own right. Anything deleted from the media
trees in the last 31 days is recoverable from the `tank/tv` and `tank/movies`
daily snapshots, which *are* replicated offsite. The recycle bin extends that
window locally and cheaply. Copying 634 GB of already-deleted media across the
WireGuard link, to duplicate coverage that is already there, would be cost
without safety.

Snapshotting it would also be actively unhelpful: it would pin every completed
download and every soft delete, so the dataset could only ever grow.

The three-year accumulation was **not** a missing setting, which is worth being
precise about because it looks like one. Both Sonarr and Radarr have Recycling
Bin Cleanup set to 7 days. Their `CleanUpRecycleBin` task ran on schedule and
failed on every single run:

```
Error occurred while executing task CleanUpRecycleBin
System.UnauthorizedAccessException: Access to the path '/downloads/recycle/...'
   at RecycleBinProvider.Cleanup()
```

That is the same `chown -R` defect described below, seen from the other end. The
183 logged exceptions were not incidental noise about a stray file — they were
the retention policy being unable to execute, for three years, behind a setting
that was correct the whole time. Fixing the permissions fixed the cleanup, which
is why roughly 620 GB became eligible for deletion the moment it was repaired.

The media itself (`tank/tv`, `tank/movies`) is snapshotted daily with 31 days
retained and replicated offsite — that is where the value is, and it is covered.
Worth knowing given these services hold it read-write: replication propagates
deletions, so the 31 days of snapshots, not the offsite copy, are what protect
against a misconfigured mass-delete.

## Recreating on a fresh machine

Prerequisites: Docker with the compose plugin, ZFS with a pool named `tank`,
systemd, `findmnt`, `curl`. The `media` group is created by this repo — `/opt/plex`
depends on it, so install this one first.

```bash
sudo git clone https://github.com/jpansarasa/nzb.git /opt/nzb
sudo /opt/nzb/install          # seeds /tank/nzb/images.env, then stops
sudo sed -i 's|^NZB_BIND_ADDR=.*|NZB_BIND_ADDR=10.0.0.5|' /tank/nzb/images.env
sudo /opt/nzb/install
```

`install` creates the four service accounts, the `media` group, every dataset
including `tank/tdarr` and its three subdirectories, `/var/tdarr`, and does not
exit 0 until all five endpoints answer. It previously created five of the nine
paths `compose.yml` binds, so this procedure did not actually work.

## Waiting, not skipping

Every prerequisite that can be *late* is checked in a way that **fails and
retries**, never one that skips. `Condition*` directives and a failed `Requires=`
abort the start *job*: the unit never enters start, `Restart=` is never armed, it
sits at `inactive (dead)` with `Result=success`, and nothing re-evaluates it.
This unit used to gate on four `ConditionPathIsDirectory` lines, which a **bare
mountpoint satisfies** — fail-open in exactly the case they appeared to guard —
and which covered only four of the nine bind sources.

The guards are now `ExecStartPre=`, covering the six config datasets, both media
datasets, and the existence of the sonarr and radarr databases. An unmounted
`tank/tv` is the one that matters most: sonarr and radarr would see the entire
library as missing and begin re-acquiring it.

```bash
systemctl is-active nzb            # "activating" while stuck
journalctl -p err -u nzb -n 20     # the guards log why, every cycle
```

## Removing this service

```bash
sudo systemctl disable --now nzb.service nzb-update.timer nzb-health.timer
sudo docker compose --file /opt/nzb/compose.yml --project-name nzb down
sudo rm -f /etc/systemd/system/nzb-update.service /etc/systemd/system/nzb-health.service
sudo systemctl daemon-reload
sudo rm -rf /opt/nzb /etc/nzb
# The datasets hold the libraries, queue state and credentials. Deliberate step:
# sudo zfs destroy -r tank/{sonarr,radarr,sabnzbd,ombi,tdarr,nzb}
```
