# nzb

The usenet/media-automation stack, run as Docker containers under a single
systemd unit: **sabnzbd**, **sonarr**, **radarr**, **tdarr** (plus two
transcode nodes), and **ombi**.

## Layout

| File | Role |
| --- | --- |
| `install` | Idempotent installer. Run it for the first deploy and after every change. |
| `compose.yml` | All six containers plus the bind-mounted volumes. |
| `nzb.service` | Owns the stack. Pulls images on start (see below), then `up --remove-orphans`. |

## Users, uids, and the media group

`install` creates one service user per app and the shared `media` group:

| User | uid | Dataset |
| --- | --- | --- |
| `ombi` | 2000 | `tank/ombi` |
| `sonarr` | 2001 | `tank/sonarr` |
| `radarr` | 2002 | `tank/radarr` |
| `sabnzbd` | 2003 | `tank/sabnzbd` |
| — | gid 1500 | group `media` |

`sonarr`, `radarr` and `sabnzbd` are added to `media`; `ombi` is not, and does
not need to be — it mounts only its own `/config` and talks to the others over
HTTP.

**Everything under `/export/{tv,movies,music}` must be group `media`.** That is
how Plex reads the library — it owns none of those files. A download that lands
outside the group is invisible to Plex with no error anywhere.

## Storage

| Path | What | Replicated |
| --- | --- | --- |
| `/tank/{sonarr,radarr,sabnzbd,ombi}` | App config + databases | **yes** — monthly, 12 kept |
| `/tank/downloads` | Download scratch, `sabnzbd:media` | no |
| `/tank/tdarr` | tdarr server/config/logs | no |
| `/var/tdarr` | tdarr transcode scratch | no — NVMe, ext4 |
| `/export/{tv,movies}` | Library, written by sonarr/radarr | separate datasets |

The four app-config datasets are opted into replication
(`com.sun:auto-snapshot:monthly=true`); scratch and transcode space is not,
deliberately. Replication is opt-in per dataset on this pool.

## Recreating on a fresh machine

Prerequisites: Docker with the compose plugin, ZFS with a pool named `tank`,
systemd.

```bash
sudo git clone https://github.com/jpansarasa/nzb.git /opt/nzb
sudo /opt/nzb/install
```

`install` creates the four users, the `media` group, the datasets, registers
the unit, and starts the stack. Restore `/tank/{sonarr,radarr,sabnzbd,ombi}`
from backup to get the app databases, indexers, and API keys back; without
them you get four freshly-configured apps.

## Day-to-day

```bash
# Apply a compose.yml or unit change (bounces the stack; see the warning below)
sudo /opt/nzb/install

# Just restart without re-running the installer
sudo systemctl restart nzb.service

docker compose --file /opt/nzb/compose.yml --project-name nzb ps
```

`install` is idempotent and safe to run repeatedly, from any working
directory.

## Two things to know before running `install`

**It restarts the stack.** That interrupts in-progress sabnzbd downloads and
tdarr transcodes. Check the queue first if that matters.

**It pulls `:latest` for all six images.** `nzb.service` has
`ExecStartPre=-… pull`, so every start fetches the newest images and the
restart then runs them. `sudo ./install` is therefore also an unattended
upgrade of all six containers.

## Notes

- Healthchecks hit each app's own endpoint. `/ping` is unauthenticated on Sonarr and Radarr, so no API key is needed.
- `tdarr-node` runs with `replicas: 2`, so those two containers are named `nzb-tdarr-node-1/2` rather than getting a fixed `container_name`.
- Real API keys live in each app's own config under `/tank/<app>`, never here.
