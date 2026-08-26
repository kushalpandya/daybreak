# Daybreak

Daybreak fetches weather, Gmail, Google Calendar, GitHub, and GitLab data into one normalized JSON
document. It is the deterministic data layer for a personal morning brief.

## Requirements

- Deno 2.9 or newer for development (Temporal arrives via `@js-temporal/polyfill`; Deno does not
  expose the `Temporal` global at runtime, so `src/temporal.ts` supplies it)
- Google Workspace CLI (`gws`), authenticated once per configured Google account
- GitHub CLI (`gh`), authenticated for GitHub
- GitLab CLI (`glab`), authenticated for GitLab

The standard Daybreak configuration expects all three integration CLIs to be installed and
authenticated. Install them on macOS with Homebrew:

```sh
brew install --cask gcloud-cli
brew install googleworkspace-cli
brew install gh
brew install glab
```

The Google Cloud CLI is needed for the initial automated `gws auth setup`. Daybreak does not invoke
`gcloud` during normal fetches or deliveries.

Authenticate each CLI before running Daybreak:

```sh
# Google Cloud project and OAuth client setup
gcloud auth login
gws auth setup

# GitHub
gh auth login

# GitLab
glab auth login --hostname gitlab.com
```

Google account access needs one separate `gws auth login` per configured profile, as described in
[Google Authentication](#google-authentication). Verify all dependencies and credentials with:

```sh
deno task doctor
```

If an integration is explicitly disabled in `config.yml`, its corresponding CLI is not required for
that run.

## Google Authentication

Daybreak uses the Google Workspace CLI (`gws`) for Gmail and Calendar access. Each Google account
must use a separate `gws` configuration directory because signing in again within the same directory
replaces the previously stored account credentials.

### Configure The OAuth Client

Google requires an OAuth desktop client. Complete this once for the Google Cloud project used by all
of your Daybreak accounts:

1. Enable the Gmail API and Google Calendar API in Google Cloud Console.
2. Configure the Google Auth Platform consent screen.
3. Create an OAuth client with application type **Desktop app**.
4. Download its client configuration as `client_secret.json`.

With the Google Cloud CLI installed and authenticated as shown above, `gws` can automate the setup:

```sh
gws auth setup
```

This setup uses user OAuth for Gmail and Calendar. It does not require a service account.

### Create One Profile Per Account

Create an isolated directory for every account. Both profiles use the same OAuth client but will
store different encrypted refresh tokens:

```sh
mkdir -p \
  "$HOME/.config/daybreak/google/1" \
  "$HOME/.config/daybreak/google/2"

cp "/path/to/client_secret.json" \
  "$HOME/.config/daybreak/google/1/client_secret.json"

cp "/path/to/client_secret.json" \
  "$HOME/.config/daybreak/google/2/client_secret.json"
```

Authenticate each profile separately with read-only Gmail and Calendar scopes:

```sh
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/daybreak/google/1" \
  gws auth login --readonly -s gmail,calendar
```

```sh
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/daybreak/google/2" \
  gws auth login --readonly -s gmail,calendar
```

Select the corresponding Google account in each browser flow. Do not run both logins against the
same configuration directory, as the second login will replace the first account.

### Configure Daybreak

Reference the profile directories by a stable local alias in `config.yml`:

```yaml
google:
  enabled: true
  include_declined: false
  accounts:
    - id: 1
      address: primary@example.com
      config_dir: ~/.config/daybreak/google/1
      max_messages: 500
    - id: 2
      address: secondary@example.com
      config_dir: ~/.config/daybreak/google/2
      max_messages: 500
```

The numeric IDs and addresses appear in normalized output. Add more accounts by continuing the
sequence with `3`, `4`, and so on. Daybreak verifies during preflight that each configured address
matches the Google account authenticated in its `gws` profile.

### Verify Authentication

Check each `gws` profile directly:

```sh
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/daybreak/google/1" \
  gws auth status

GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/daybreak/google/2" \
  gws auth status
```

Then run Daybreak's preflight, which verifies every configured profile before collection starts:

```sh
deno task doctor
```

Keep `client_secret.json`, encrypted credentials, and exported tokens out of version control. The
OAuth client file can be reused on another machine, but each account should normally be
authenticated again there so `gws` creates machine-local encrypted credentials.

If the OAuth app has External audience and remains in Testing status, Google normally expires Gmail
and Calendar refresh tokens after seven days. Use an appropriate production OAuth configuration for
long-running unattended use, subject to Google's current verification and restricted-scope policies.

## Setup

Copy `config.example.yml` to `config.yml` and update the timezone, coordinates, Google profile
paths, and GitHub repositories.

Copy `.env.example` to `.env` and add secrets required by enabled integrations:

```sh
cp .env.example .env
```

Daybreak loads `.env` from the current working directory at startup. The local `.env` is ignored by
Git and must not be committed. Run Daybreak from the project directory when relying on this file.

GitHub and GitLab credentials are managed by `gh` and `glab` respectively. Do not add their tokens
to Daybreak's `.env`; authenticate the CLIs directly with `gh auth login` and `glab auth login`.

GitHub notifications and GitLab todos are collected as global provider feeds. Repository metrics,
authored work, assigned work, and review requests are restricted to the GitHub repositories and
GitLab projects explicitly listed in configuration.

Validate configuration and authentication:

```sh
deno task config:check
deno task doctor
```

Fetch all enabled sections:

```sh
deno task fetch --pretty
```

Fetch selected sections without changing metric history:

```sh
deno task fetch --section weather,github --pretty --no-write-state
```

`stdout` contains the JSON result. Diagnostics from third-party CLIs are captured and do not corrupt
the output.

## Agent Format

`--format agent` emits a compact, flat projection of the same run, intended for a language model
that writes the prose instead of the deterministic renderer:

```sh
deno task agent --pretty
deno task agent --max-items 8      # tighter, for a small local model
```

The default `json` format is a faithful dump of every upstream response and runs to roughly 180 KB,
most of it avatar URLs, project descriptions and long-tail backlog items. The agent projection is
about 7 KB at the default cap and 4 KB at `--max-items 5`.

The shape is built for a small, locally hosted model with a short context window that reasons poorly
over deep JSON, so it does the judging up front:

- **One flat `work` array** replaces five nested per-project buckets. Each entry carries `priority`,
  `source`, `kind`, `ref`, `title`, `url` and `why`.
- **Ranking is already applied.** Priority 1 is blocked or failing, 2 is waiting on you, 3 is in
  flight. Within a priority, reviews and your own merge requests outrank inbox-style todos. The
  narrator can read the array in order instead of judging urgency.
- **Reasons are pre-phrased in English.** `pipeline_failed` arrives as `"pipeline failed"`, and
  approvers are named, so no reason code has to be interpreted.
- **Every list is capped** by `--max-items` with an explicit `workOmitted` or `itemsOmitted` count,
  so a busy day cannot overflow the context window.
- **Filters and deduplication are applied**, and the counts of what was removed are reported so the
  narrator can say "the rest was newsletters" truthfully without being handed the newsletters.
- **Section health** is summarised under `health.collected` and `health.problems`.

The projection is lossy by design. Use the default format when you need the complete record.

## Filters

Mail and GitLab todos carry a lot of recurring noise. The optional `filters` block removes it for
both the Telegram renderer and the agent format:

```yaml
filters:
  mail_ignore_categories:
    - promotions
    - social
  mail_ignore_senders:
    - noreply@newsletter.example
  todo_ignore_titles:
    - Community contributions report
```

`mail_ignore_categories` matches Gmail's `CATEGORY_*` labels and defaults to promotions and social.
The other two lists default to empty and match case-insensitive substrings. Gmail's own `IMPORTANT`
flag is deliberately not used to select mail, because it fires on a large share of newsletters; a
read message reaches the brief only when its subject suggests a pending decision.

## Weekly Recap

Set `gitlab.recap` to collect merge requests you merged and issues you closed inside a lookback
window, alongside the open work:

```yaml
gitlab:
  recap: 7d
```

Omit the key to skip the extra API calls.

## Telegram Delivery

Create a bot through Telegram's `@BotFather`, then start a chat with the bot. Telegram bots cannot
initiate a private conversation until the recipient has contacted the bot.

Store the bot token in the project-local `.env`, outside `config.yml`:

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace-with-your-token
```

Find the numeric destination chat ID after sending a message to the bot:

```sh
deno task telegram:chats
```

This lists only chat IDs, types, and display names. Use the intended chat's `id` value in
`config.yml`:

Do not use the bot's own numeric user ID. The destination ID must come from a message sent by your
personal account, group, or channel to the bot.

```yaml
telegram:
  enabled: true
  chat_id: 123456789
  disable_link_previews: true
```

Validate the token and destination without sending a brief:

```sh
deno task doctor
```

Preview the deterministic Telegram text locally:

```sh
deno task deliver --dry-run
```

Fetch, render, and send the brief:

```sh
deno task deliver
```

Long briefs are split at paragraph boundaries to stay below Telegram's message-size limit. The
current renderer is deterministic. A local email summarizer can later replace only the email
selection and prose stage without changing Telegram delivery.

## Native Binary

```sh
mkdir -p dist
deno task compile
./dist/daybreak fetch --pretty
```

The compiled binary still requires enabled third-party CLIs to be installed and authenticated.

All commands automatically use `./config.yml` when `--config` is omitted. Use `--config PATH` when
running from another directory or selecting a different configuration file.

## Exit Codes

- `0`: command succeeded
- `1`: invalid arguments or configuration
- `2`: preflight dependency or authentication failure
- `3`: fetch completed but one or more collectors failed

## Merge Request Detail

GitLab's merge request list endpoint omits `head_pipeline` and reports `detailed_merge_status` as
`unchecked`. Pipeline status, real merge status and approvals are therefore fetched per merge
request, for the ones that reach the brief only, capped at 25 per project.

## State

GitHub and GitLab metric snapshots are stored in SQLite. A delta compares the current value to the
latest snapshot at or before the configured lookback boundary. The first run therefore reports
`null` deltas.

Use `--no-write-state` for previews and diagnostics.

## Development

Run the native TypeScript linter with Deno's recommended rules:

```sh
deno task lint
```

Apply safe automatic lint fixes:

```sh
deno task lint:fix
```

Run formatting checks, linting, type checking, and tests together:

```sh
deno task check
```

Daybreak uses `deno lint` instead of the deprecated TSLint package. The lint configuration is kept
in `deno.json` and currently enables Deno's recommended rule set.
