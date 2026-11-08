<p align="center"><img src="apps/site/public/brand/whale.webp" width="120" alt="SeekCloud logo"></p>

# SeekCloud

[中文](README.md) | English

SeekCloud is a self-hostable cloud coding agent that works with DeepSeek models. Start a session from any device, such as a phone or a computer, and the agent reads and edits your repository and runs commands in a sandbox in the cloud, then pushes the changes to GitHub. Each deployment has a single admin account, for the person who deploys it.

SeekCloud is an independent open-source project and is not an official DeepSeek product.

## Status

**Early development. Not yet usable for real deployments.**

Agent execution is not implemented yet: the main site is not yet connected to the sandbox host, so new sessions stay queued. The interface is currently available in Chinese only.

What is done:

- Main site: admin password login, linking GitHub and choosing a repository and branch, starting and viewing sessions, and data export. The interface is a PWA that can be added to a phone's home screen.
- Sandbox host: the Git proxy (which only allows access to the session's own repositories and signs commits) and the GitHub tools service (MCP).

## Planned features

- Graphical web-based deployment: one command on Linux, one PowerShell command on Windows, and the remaining steps in a web wizard
- Multi-channel notifications: SMTP email, PWA push, Feishu, DingTalk and WeCom bots, and generic webhooks
- Windows support: both the main site and the sandbox host can be installed on Windows through WSL2
- Android app: enter the server address on first launch
- Update check and one-click update: check for new versions in the admin console, and the server pulls updates from this repository
- More agent features: enable the plugin market, the modes (such as Creator mode), the trajectory view and other features of the in-sandbox agent (dsh) that are not enabled yet
- AI labels on GitHub: by default, the signature at the end of issues, pull requests and comments and the commit message trailer mark the content as AI-generated; they can be turned off in settings

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

Then open http://localhost:5173 and set the admin password on the first visit.

Main site environment variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection URL. Required |
| `SEEKCLOUD_SECRET_KEY` | 32-byte key (base64) for encrypting GitHub tokens. Required. Generate it once with `openssl rand -base64 32` and keep it safe; after it changes, stored tokens can no longer be decrypted |
| `PORT` | Port to listen on. Defaults to 3000 |
| `SEEKCLOUD_DATA_DIR` | Data directory for exported archives. Defaults to `./data` |
| `SEEKCLOUD_VERSION` | Version string returned by the health check endpoint `/api/health`. Defaults to `dev` |
| `NODE_ENV` | When set to `production`, the login cookie is sent over HTTPS only |
| `PUBLIC_URL` | Public address of the main site, used for the GitHub callback |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET` | GitHub App settings. Without them, GitHub features are unavailable |

If you forget the admin password, run `DATABASE_URL=... pnpm admin:reset-password` in `apps/site`. It prints a new random password and signs out all devices.

## License

This project is licensed under the [Apache License 2.0](LICENSE). See also [NOTICE](NOTICE).
