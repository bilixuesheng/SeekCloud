<p align="center"><img src="apps/site/public/brand/whale.webp" width="120" alt="SeekCloud logo"></p>

# SeekCloud

[中文](README.md) | English

SeekCloud is a self-hostable cloud coding agent that works with DeepSeek models. Start a session from any device, such as a phone or a computer, and the agent reads and edits your repository and runs commands in a sandbox in the cloud, then pushes the changes to GitHub. Each deployment has a single admin account, for the person who deploys it.

This repository is the open-source, self-hosted trunk of the paid edition of SeekCloud. SeekCloud is an independent project and is not an official DeepSeek product.

## Status

**Early development. Not yet usable for real deployments.**

The agent can now run a complete turn in a sandbox: it clones the repository, edits the code, then commits and pushes to the session branch. This flow has been verified on the test machine with a simulated GitHub and model, but not yet with a real GitHub repository and DeepSeek. The main site can be deployed with the installer (see "Deployment" below); the sandbox host still has to be installed by hand. The interface is available in Chinese and English.

What is done:

- Main site: admin password login, linking GitHub and choosing a repository and branch, starting and viewing sessions, and data export. The interface is a PWA that can be added to a phone's home screen.
- Model gateway: the only way the sandbox can call a model; image uploads for the model, web search and web fetch go through it too; web fetch never connects to private or local addresses. It swaps in the DeepSeek API key the admin entered (stored encrypted), strips data the Agent attaches, streams responses through, and records usage for every call. Each session only sees the files it uploaded. When the upstream fails, the sandbox only sees a description, status code and reference ID; the raw upstream error is shown to the admin only.
- Sandbox host: the connection to the main site (authenticated with a host key; reconnects and resends automatically), the Git proxy (which only allows access to the session's own repositories and signs commits) and the GitHub tools service (MCP).

## Planned features

- Graphical web-based deployment: one command on Linux, one PowerShell command on Windows, and the remaining steps in a web wizard
- Multi-channel notifications: SMTP email, PWA push, Feishu, DingTalk and WeCom bots, and generic webhooks
- Windows support: both the main site and the sandbox host can be installed on Windows through WSL2
- Android app: enter the server address on first launch
- Update check and one-click update: check for new versions in Settings and update to the releases published in this repository with one click, without interrupting running sessions
- More agent features: enable the plugin market, the modes (such as Creator mode), the trajectory view and other features of the in-sandbox agent (dsh) that are not enabled yet
- AI labels on GitHub: by default, the signature at the end of issues, pull requests and comments and the commit message trailer mark the content as AI-generated; they can be turned off in settings

## Deployment

The main site (web interface and API), PostgreSQL and the Caddy reverse proxy run with Docker Compose, and the installer sets them up with one command. Supported systems: Ubuntu 22.04, 24.04 and Debian 12 (amd64 or arm64).

On the server, run as root:

```sh
curl -fsSLO https://github.com/bilixuesheng/SeekCloud/releases/latest/download/install.sh
curl -fsSLO https://github.com/bilixuesheng/SeekCloud/releases/latest/download/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS && sudo bash install.sh --lang en
```

These two files exist only after this repository publishes its first release. Until then, clone this repository, build the main site image yourself, then install:

```sh
docker build -f apps/site/Dockerfile -t seekcloud-site:dev .
sudo bash scripts/install.sh --image seekcloud-site:dev --lang en
```

The installer:

1. Checks the system, memory and disk. With less than 1 GB of memory it warns that this may not be enough. On a container such as LXC or OpenVZ the main site still installs, but the machine cannot be a sandbox host.
2. Installs Docker Engine from Docker's package source if Docker is missing, after checking the fingerprint of Docker's official signing key.
3. Generates `SEEKCLOUD_SECRET_KEY` and the database password and writes them to files only root can read, without showing them in the terminal.
4. Tests several public mirrors and the default registry, and pulls the images from the fastest one.
5. Starts everything, waits for the site's health check, and prints the web address.

After installing, **open the web page and set the admin password right away**: until then, anyone who opens the address can become the admin. Then enter a DeepSeek API key under "Settings → Model".

The installer can be run again: existing secrets and data are kept, and only missing parts are added.

| Option | Description |
|---|---|
| `--data-dir DIR` | Where data, secrets and the Compose file live. Defaults to `/var/lib/seekcloud` |
| `--no-caddy` | Do not install Caddy, for servers that already have a reverse proxy. The site then listens on `127.0.0.1:PORT` only, and your reverse proxy forwards to it |
| `--port PORT` | Port the site listens on with `--no-caddy`. Defaults to 3000 |
| `--proxy-hops N` | Number of reverse proxies in front of the site. Defaults to 1 |
| `--registry HOST` | Pull every image from this registry or mirror instead of testing public mirrors |
| `--image REF` | Image for the main site. Defaults to the published image of the same version as the installer |
| `--lang zh\|en` | Language of the messages |

Contents of the data directory:

| Location | Contents |
|---|---|
| `compose.yml`, `Caddyfile` | Generated by the installer and overwritten when it runs again |
| `site.env`, `postgres.env` | Secrets and the database password, readable by root only. **`SEEKCLOUD_SECRET_KEY` is not part of backups, so keep a separate copy of `site.env`**: without the key, the encrypted tokens and keys in the database cannot be used |
| `postgres/` | The database |
| `site/` | The main site's data directory (exported archives and agent session files) |
| `caddy/` | Caddy's certificates and configuration |

The database is only on Compose's internal network and is not exposed; the main site runs as a non-root user. Right after installing, open `http://<server address>/`; the domain and HTTPS will be configured in the setup wizard.

Common tasks (`<data dir>` defaults to `/var/lib/seekcloud`):

```sh
# Show logs
docker compose -f <data dir>/compose.yml logs -f site
# Forgot the admin password: prints a new random password and signs out all devices
docker compose -f <data dir>/compose.yml exec site node dist/server/reset-password.js
# Add a sandbox host: prints the host key (see "Connecting a sandbox host")
docker compose -f <data dir>/compose.yml exec site node dist/server/host.js create <name>
```

With `--no-caddy`, your reverse proxy must:

- append the client address to `X-Forwarded-For` and set `X-Forwarded-Proto`;
- forward WebSocket connections (sandbox hosts connect to the main site at `/api/hosts/connect`);
- not buffer `text/event-stream` responses (live updates on the session page).

If there is more than one reverse proxy in front of the site (for example a CDN plus your own proxy), set the number with `--proxy-hops`. Too high a number lets clients forge their address to bypass per-source rate limits; too low a number makes everyone appear to come from the same address.

If images cannot be pulled, configure a registry mirror for Docker in `/etc/docker/daemon.json` (`registry-mirrors`), run `systemctl restart docker`, then run the installer again. You can also pick a mirror with `--registry`.

## Development

### Requirements

- Node.js 22 or later
- pnpm 10
- PostgreSQL (CI uses 16)
- The sandbox host tests also need `git`, `openssl` and `ssh-keygen`

### Repository layout

| Path | Contents |
|---|---|
| `apps/site` | Main site: Hono API and React PWA |
| `apps/host` | Sandbox host daemon: Git proxy, commit signing, GitHub tools service |
| `apps/host/sandbox` | Git configuration, hooks and signing helper installed in the sandbox |
| `apps/android` | Android app (Kotlin, Jetpack Compose), a separate Gradle project outside the pnpm workspace. Run `./gradlew testDebugUnitTest lintDebug assembleDebug` in it; requires JDK 17 or later and the Android SDK. The API client is generated at build time from `apps/android/api/openapi.json`; when the main site's API changes, run `pnpm --filter @seekcloud/site openapi:export` at the repository root to export it again |
| `packages/protocol` | Protocol definitions shared by the main site and the sandbox host |
| `docs/adr` | Architecture decision records (in Chinese) |
| `docs/brand` | Logo, colors and interface copy guidelines (in Chinese) |
| `GLOSSARY.md` | Domain glossary (in Chinese) |

### Common commands

Run from the repository root:

```sh
pnpm install     # install dependencies
pnpm typecheck   # type check
pnpm lint        # Biome checks; pnpm format fixes them
pnpm test        # run the tests
pnpm build       # build
```

CI runs the last four.

### Test database

The main site tests need PostgreSQL. They connect to `postgres://postgres:postgres@localhost:5432/postgres` by default; set `TEST_DATABASE_URL` to use another server. The tests create and drop temporary databases on it, so the user needs permission to create databases.

### Running the main site locally

In `apps/site`, run each of these in its own terminal:

```sh
# API on port 3000; runs database migrations on startup
DATABASE_URL=postgres://<user>:<password>@localhost:5432/<database> \
SEEKCLOUD_SECRET_KEY=<key> \
pnpm dev:server

# Front end on port 5173, forwarding /api to port 3000
pnpm dev
```

Then open http://localhost:5173, set the admin password on the first visit, and enter a DeepSeek API key under "Settings → Model" (sessions cannot be started without one).

Main site environment variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection URL. Required |
| `SEEKCLOUD_SECRET_KEY` | 32-byte key (base64) for encrypting GitHub tokens. Required. Generate it once with `openssl rand -base64 32` and keep it safe; after it changes, stored tokens can no longer be decrypted |
| `PORT` | Port to listen on. Defaults to 3000 |
| `SEEKCLOUD_DATA_DIR` | Data directory for exported archives. Defaults to `./data` |
| `SEEKCLOUD_VERSION` | Version string returned by the health check endpoint `/api/health`. Defaults to `dev` |
| `PUBLIC_URL` | Public address of the main site, used for the GitHub callback and passkeys. When it starts with `https://`, the login cookie is sent over HTTPS only; when it is not set, this depends on whether each request arrived over HTTPS |
| `SEEKCLOUD_PROXY_HOPS` | Number of reverse proxies in front of the main site (0 to 5). Defaults to 1. 0 means the main site is exposed directly and clients are identified by the connection's source address; N means the Nth-from-last entry of `X-Forwarded-For` is used. This is only the initial value and can be changed later in settings. A wrong value either lets clients bypass per-source rate limits or makes them apply to everyone at once |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET` | GitHub App settings. Without them, GitHub features are unavailable |

`pnpm build` builds the front end (`apps/site/dist/client`) and the server (`apps/site/dist/server`); then run the built main site with `pnpm start` in `apps/site`.

If you forget the admin password, run `DATABASE_URL=... pnpm admin:reset-password` in `apps/site`. It prints a new random password and signs out all devices.

### Connecting a sandbox host

1. In `apps/site`, run `DATABASE_URL=... pnpm host:create <name>` (lowercase letters, digits and hyphens) and note the host key it prints. The key is shown only once; the main site stores only its hash.
2. On the host, in `apps/host`, run:

   ```sh
   SEEKCLOUD_SITE_URL=<public URL of the main site> SEEKCLOUD_HOST_KEY=<host key> pnpm start
   ```

   The host connects to the main site and reconnects automatically after a disconnect.
3. To retire a host, run `DATABASE_URL=... pnpm host:revoke <name>`. Its existing connection is closed within a few seconds.

When a host has been disconnected for longer than a set time (2 minutes by default, configurable under "Settings → Sessions"), its running sessions are marked as failed.

## License

This project is licensed under the [GNU Affero General Public License, version 3](LICENSE) (AGPL-3.0), with an additional attribution term under section 7(b) of the AGPL-3.0: SeekCloud and any modified version of it must preserve the attribution "基于 SeekCloud（https://github.com/bilixuesheng/SeekCloud）" (meaning "Based on SeekCloud") on the "开源声明" (Open Source Notices) page of the interface. See [NOTICE](NOTICE) for the exact terms.

Before contributing, please read [CONTRIBUTING.md](CONTRIBUTING.md).
