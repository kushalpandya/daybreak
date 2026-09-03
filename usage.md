# Daybreak Usage Guide

Everything needed to install, configure, run and troubleshoot Daybreak. Start with the
[README](README.md) for what Daybreak is and a five-minute quick start.

- [Installing the dependencies](#installing-the-dependencies)
- [Google authentication](#google-authentication)
- [Configuration](#configuration)
- [Commands and options](#commands-and-options)
- [Output formats](#output-formats)
- [Output examples](#output-examples)
- [Filtering out the noise](#filtering-out-the-noise)
- [Weekly recap](#weekly-recap)
- [Telegram delivery](#telegram-delivery)
- [Running as a native binary](#running-as-a-native-binary)
- [Metric history and state](#metric-history-and-state)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Implementation notes](#implementation-notes)
- [Development](#development)

## Installing the dependencies

Daybreak does not talk to GitHub, GitLab or Google directly. It shells out to their official command
line tools and normalizes what they return, so authentication stays with the vendor tools and no API
tokens ever live in Daybreak's own configuration.

You need:

- **Deno 2.9 or newer** for development. Temporal arrives via `@js-temporal/polyfill`, because Deno
  does not expose the `Temporal` global at runtime; `src/temporal.ts` supplies it.
- **Google Workspace CLI (`gws`)** for Gmail and Calendar
- **GitHub CLI (`gh`)** for GitHub
- **GitLab CLI (`glab`)** for GitLab

On macOS with Homebrew:

```sh
brew install --cask gcloud-cli
brew install googleworkspace-cli
brew install gh
brew install glab
```

The Google Cloud CLI is only needed for the one-time automated `gws auth setup`. Daybreak never
invokes `gcloud` during a normal fetch or delivery.

Authenticate each tool once:

```sh
# Google Cloud project and OAuth client setup
gcloud auth login
gws auth setup

# GitHub
gh auth login

# GitLab
glab auth login --hostname gitlab.com
```

Google accounts need one additional step per account, covered next.

If an integration is disabled in `config.yml`, its CLI is not required for that run.

## Google authentication

Gmail and Calendar go through `gws`. Each Google account needs **its own `gws` configuration
directory**, because signing in again inside the same directory replaces the previously stored
account rather than adding to it.

### Configure the OAuth client

Google requires an OAuth desktop client. Do this once for the Google Cloud project shared by all
your Daybreak accounts:

1. Enable the Gmail API and Google Calendar API in Google Cloud Console.
2. Configure the Google Auth Platform consent screen.
3. Create an OAuth client with application type **Desktop app**.
4. Download its client configuration as `client_secret.json`.

With the Google Cloud CLI installed and authenticated, `gws` can do all of this for you:

```sh
gws auth setup
```

This uses user OAuth for Gmail and Calendar. No service account is involved.

### Create one profile per account

Give every account an isolated directory. All profiles share the same OAuth client but store their
own encrypted refresh token:

```sh
mkdir -p \
  "$HOME/.config/daybreak/google/1" \
  "$HOME/.config/daybreak/google/2"

cp "/path/to/client_secret.json" \
  "$HOME/.config/daybreak/google/1/client_secret.json"

cp "/path/to/client_secret.json" \
  "$HOME/.config/daybreak/google/2/client_secret.json"
```

Authenticate each profile separately, with read-only Gmail and Calendar scopes:

```sh
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/daybreak/google/1" \
  gws auth login --readonly -s gmail,calendar
```

```sh
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/daybreak/google/2" \
  gws auth login --readonly -s gmail,calendar
```

Each command prints a URL and waits. Open it, pick the matching Google account, and approve. `gws`
runs a local listener that captures the callback itself, so nothing needs to be copied back by hand.

Two things to get right:

- **Select the correct account in each browser flow.** The profile directory and the account are
  bound at this moment.
- **Never run both logins against the same directory.** The second login silently replaces the first
  account.

### Point Daybreak at the profiles

Reference each directory by a stable numeric alias in `config.yml`:

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

The IDs and addresses appear in normalized output. Add accounts by continuing the sequence with `3`,
`4`, and so on. During preflight, Daybreak verifies that each configured `address` matches the
account actually authenticated in that profile, which catches a login that landed in the wrong
directory.

### Verify

Check a profile directly:

```sh
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/daybreak/google/1" \
  gws auth status
```

Then run Daybreak's own preflight, which checks every configured profile before collection starts:

```sh
deno task doctor
```

### Keeping credentials safe

Keep `client_secret.json`, encrypted credentials and exported tokens out of version control. The
OAuth client file can be copied to another machine, but each account should normally be
authenticated again there, so `gws` creates machine-local encrypted credentials.

If the OAuth app has External audience and remains in **Testing** status, Google normally expires
Gmail and Calendar refresh tokens after seven days, and unattended runs will start failing every
week. Use an appropriate production OAuth configuration for long-running unattended use, subject to
Google's current verification and restricted-scope policies.

## Configuration

Copy the examples and edit them:

```sh
cp config.example.yml config.yml
cp .env.example .env
```

In `config.yml`, update the timezone, coordinates, Google profile paths, and the GitHub repositories
and GitLab projects you care about.

`.env` holds secrets required by enabled integrations, currently just the Telegram bot token.
**Daybreak loads `.env` from the current working directory at startup**, so run Daybreak from the
project directory when relying on it. `.env` is Git-ignored and must not be committed.

Do not put GitHub or GitLab tokens in `.env`. Those credentials belong to `gh` and `glab`;
authenticate the CLIs directly.

One distinction worth knowing: GitHub notifications and GitLab todos are collected as **global**
provider feeds, so they cover your whole account. Repository metrics, authored work, assigned work
and review requests are restricted to the repositories and projects **explicitly listed** in
configuration.

Validate everything before the first real run:

```sh
deno task config:check   # configuration is well-formed
deno task doctor         # dependencies and credentials actually work
```

## Commands and options

```
daybreak fetch [options]              # collect and print the normalized payload
daybreak deliver [options]            # collect, render and send the brief
daybreak doctor [--config PATH]       # preflight dependencies and credentials
daybreak telegram chats               # list chat IDs the bot can see
daybreak config check [--config PATH] # validate configuration
```

| Option                 | Meaning                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--config PATH`        | Configuration file. Defaults to `./config.yml`.                                                                            |
| `--pretty`             | Pretty-print JSON output.                                                                                                  |
| `--format json\|agent` | `json` is the full normalized payload (default). `agent` is the compact, flat, pre-ranked projection for a language model. |
| `--max-items N`        | Cap entries per list in the agent format. Default 15, range 1–100.                                                         |
| `--section LIST`       | Comma-separated sections: `weather`, `mail`, `calendar`, `github`, `gitlab`.                                               |
| `--date YYYY-MM-DD`    | Replay using a reporting date at 07:00 local time.                                                                         |
| `--no-write-state`     | Do not save GitHub metric snapshots.                                                                                       |
| `--dry-run`            | Render delivery text without sending it.                                                                                   |
| `-h`, `--help`         | Show help.                                                                                                                 |
| `-V`, `--version`      | Show version.                                                                                                              |

Every command falls back to `./config.yml` when `--config` is omitted. Pass `--config PATH` when
running from another directory or switching configurations.

Some examples:

```sh
# everything, readable
deno task fetch --pretty

# just two sections, without disturbing metric history
deno task fetch --section weather,github --pretty --no-write-state

# what would the brief say today?
deno task deliver --dry-run
```

`stdout` carries the JSON result. Diagnostics from the third-party CLIs are captured separately and
cannot corrupt it.

## Output formats

**`json`** is the default and is a faithful dump of every upstream response. It is large — a few
hundred kilobytes on a busy account, most of it avatar URLs, project descriptions and long-tail
backlog items. Use it when you need the complete record.

**`agent`** is a compact, flat projection of the same run, roughly an order of magnitude smaller. It
exists for a small, locally hosted model with a short context window that reasons poorly over deep
JSON, so it does the judging up front:

- **One flat `work` array** replaces five nested per-project buckets. Each entry carries `priority`,
  `source`, `kind`, `ref`, `title`, `url` and `why`.
- **Ranking is already applied.** Priority 1 is blocked or failing, 2 is waiting on you, 3 is in
  flight. Within a priority, reviews and your own merge requests outrank inbox-style todos. The
  narrator can read the array in order instead of judging urgency itself.
- **Reasons are pre-phrased in English.** `pipeline_failed` arrives as `"pipeline failed"`, and
  approvers are named, so no reason code needs interpreting.
- **Every list is capped** by `--max-items`, with an explicit `workOmitted` or `itemsOmitted` count,
  so a busy day cannot overflow the context window.
- **Filters and deduplication are applied**, and the counts of what was removed are reported, so the
  narrator can say "the rest was newsletters" truthfully without being handed the newsletters.
- **Section health** is summarized under `health.collected` and `health.problems`.
- **Weather carries an intraday arc**, sampled at 06:00, 09:00, 12:00, 15:00, 18:00 and 21:00 local
  time, plus tomorrow's outlook, so the narrator can describe the shape of the day rather than only
  its high and low.

```sh
deno task agent --pretty
deno task agent --max-items 8      # tighter, for a small local model
```

The projection is lossy by design. Use the default format when you need the complete record.

## Output examples

Sample output for every command, taken from a real run and redacted. Addresses, repository names,
identifiers and counts are illustrative; the structure and field names are verbatim.

<details>
<summary><code>daybreak fetch --pretty</code> — default <code>json</code> format (abridged)</summary>

The complete document repeats the per-item shapes below for every message, event, repository and
todo, and includes upstream fields such as avatar URLs and project descriptions. Arrays are shown
here with a single representative entry.

```json
{
  "schemaVersion": 1,
  "run": {
    "id": "01J9Z0S7QK4M8V2D6X1B3N5T7P",
    "startedAt": "2026-09-02T11:00:04.512Z",
    "reportingTime": "2026-09-02T07:00:00-04:00",
    "reportingDate": "2026-09-02",
    "timezone": "America/Toronto",
    "windows": {
      "mail": { "start": "2026-09-01T11:00:04.512Z", "end": "2026-09-02T11:00:04.512Z" },
      "calendar": { "start": "2026-09-02T11:00:04.512Z", "end": "2026-09-04T11:00:04.512Z" },
      "github": { "start": "2026-09-01T11:00:04.512Z", "end": "2026-09-02T11:00:04.512Z" }
    },
    "completedAt": "2026-09-02T11:01:42.088Z"
  },
  "weather": {
    "status": "ok",
    "collectedAt": "2026-09-02T11:00:06.204Z",
    "durationMs": 412,
    "data": {
      "provider": "open-meteo",
      "location": {
        "name": "Toronto, Ontario, Canada",
        "latitude": 43.70643,
        "longitude": -79.39864
      },
      "timezone": "America/Toronto",
      "units": {
        "system": "metric",
        "temperature": "°C",
        "precipitation": "mm",
        "windSpeed": "km/h"
      },
      "current": {
        "observedAt": "2026-09-02T11:00:00-04:00",
        "temperature": 20.4,
        "apparentTemperature": 22.1,
        "weatherCode": 2,
        "condition": "partly cloudy",
        "precipitation": 0,
        "windSpeed": 11.2
      },
      "today": {
        "date": "2026-09-02",
        "minimumTemperature": 20.1,
        "maximumTemperature": 25.5,
        "precipitationProbabilityPercent": 79,
        "weatherCode": 2,
        "condition": "partly cloudy",
        "sunrise": "2026-09-02T06:41:00-04:00",
        "sunset": "2026-09-02T19:52:00-04:00",
        "precipitationPeriods": [],
        "hours": []
      },
      "tomorrow": {
        "date": "2026-09-03",
        "minimumTemperature": 18.7,
        "maximumTemperature": 26.4,
        "precipitationProbabilityPercent": 13,
        "weatherCode": 51,
        "condition": "drizzle"
      }
    },
    "warnings": []
  },
  "mail": {
    "status": "ok",
    "collectedAt": "2026-09-02T11:00:51.663Z",
    "durationMs": 45210,
    "data": {
      "window": { "start": "2026-09-01T11:00:04.512Z", "end": "2026-09-02T11:00:04.512Z" },
      "accounts": [
        {
          "id": 1,
          "address": "primary@example.com",
          "truncated": false,
          "messageCount": 26,
          "threadCount": 24,
          "messages": [
            {
              "id": "1:1a06507a87cd2044",
              "providerId": "1a06507a87cd2044",
              "threadId": "1:1a06507a87cd2044",
              "account": 1,
              "sender": { "name": "Example Bank", "address": "alerts@bank.example" },
              "recipients": {
                "to": [{ "name": null, "address": "primary@example.com" }],
                "cc": []
              },
              "subject": "A payment was made using your Credit Card",
              "receivedAt": "2026-09-02T02:09:54.000Z",
              "unread": true,
              "important": true,
              "labels": ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
              "snippet": "A payment of ... was made using your Credit Card ending 0000"
            }
          ],
          "threads": []
        }
      ]
    },
    "warnings": []
  },
  "calendar": {
    "status": "ok",
    "collectedAt": "2026-09-02T11:00:12.907Z",
    "durationMs": 6120,
    "data": {
      "window": { "start": "2026-09-02T11:00:04.512Z", "end": "2026-09-04T11:00:04.512Z" },
      "accounts": [
        {
          "id": 1,
          "address": "primary@example.com",
          "calendars": [
            {
              "id": "primary@example.com",
              "name": "primary@example.com",
              "primary": true,
              "timezone": "America/Toronto"
            }
          ],
          "warnings": []
        }
      ],
      "events": []
    },
    "warnings": []
  },
  "github": {
    "status": "ok",
    "collectedAt": "2026-09-02T11:00:29.441Z",
    "durationMs": 18334,
    "data": {
      "user": { "login": "octocat" },
      "snapshotWritten": true,
      "repositories": [
        {
          "name": "octocat/example-app",
          "url": "https://github.com/octocat/example-app",
          "archived": false,
          "stars": {
            "current": 1200,
            "previous": 1197,
            "delta": 3,
            "comparedAt": "2026-09-01T15:16:28.184Z"
          },
          "forks": 71,
          "openIssues": 15,
          "releaseDownloads": {
            "current": 24000,
            "previous": 23924,
            "delta": 76,
            "comparedAt": "2026-09-01T15:16:28.184Z"
          }
        }
      ],
      "todos": {
        "assignedIssues": [],
        "assignedPullRequests": [],
        "reviewRequests": [],
        "authoredIssues": [],
        "authoredPullRequests": [],
        "notifications": []
      }
    },
    "warnings": []
  },
  "gitlab": {
    "status": "ok",
    "collectedAt": "2026-09-02T11:01:41.902Z",
    "durationMs": 71850,
    "data": {
      "host": "gitlab.com",
      "user": { "id": 100001, "username": "octocat", "name": "Example User" },
      "todos": [
        {
          "id": 756831244,
          "project": {
            "id": 278964,
            "name": "Example",
            "name_with_namespace": "Example.org / Example",
            "path": "example",
            "path_with_namespace": "example-org/example"
          },
          "action_name": "directly_addressed",
          "target_type": "MergeRequest",
          "target_url": "https://gitlab.com/example-org/example/-/merge_requests/250520",
          "body": "Migrate blob viewer to copyToClipboard",
          "state": "pending",
          "created_at": "2026-09-01T09:14:52.117Z"
        }
      ],
      "projects": [
        {
          "path": "example-org/example",
          "reviewRequests": [],
          "assignedIssues": [],
          "authoredMergeRequests": []
        }
      ]
    },
    "warnings": []
  }
}
```

</details>

<details>
<summary><code>daybreak fetch --format agent --pretty</code> — compact projection for a model</summary>

```json
{
  "date": "2026-09-02",
  "weekday": "Wednesday",
  "timezone": "America/Toronto",
  "weekend": false,
  "health": {
    "collected": ["weather", "mail", "calendar", "github", "gitlab"],
    "problems": []
  },
  "weather": {
    "location": "Toronto, Ontario, Canada",
    "now": { "temperature": 20.4, "feelsLike": 22.1, "condition": "partly cloudy" },
    "today": { "high": 25.5, "low": 20.1, "condition": "partly cloudy", "rainChance": 79 },
    "hours": [
      { "time": "06:00", "temperature": 20.2, "condition": "cloudy", "rainChance": 12 },
      { "time": "12:00", "temperature": 24.1, "condition": "partly cloudy", "rainChance": 41 },
      { "time": "18:00", "temperature": 25.3, "condition": "rain showers", "rainChance": 79 }
    ],
    "tomorrow": { "high": 26.4, "low": 18.7, "condition": "drizzle", "rainChance": 13 }
  },
  "calendar": { "today": [], "upcoming": [], "observances": [] },
  "mail": {
    "received": 46,
    "unread": 2,
    "filtered": 37,
    "itemsOmitted": 0,
    "items": [
      {
        "from": "Example Bank",
        "subject": "A payment was made using your Credit Card",
        "why": "unread"
      },
      {
        "from": "Example Fund",
        "subject": "Payment of first Interim Dividend through electronic mode",
        "why": "may need a decision"
      }
    ]
  },
  "work": [
    {
      "priority": 1,
      "source": "gitlab",
      "kind": "merge_request",
      "ref": "example-org/example!253151",
      "title": "Add container border to sticky header tables",
      "url": "https://gitlab.com/example-org/example/-/merge_requests/253151",
      "why": "review requested, pipeline failed, unresolved discussions"
    },
    {
      "priority": 2,
      "source": "gitlab",
      "kind": "todo",
      "ref": "example-org/example",
      "title": "Discussion: Disable \"All Threads Must Be Resolved\" Merge Requirement",
      "url": "https://gitlab.com/example-org/example/-/issues/1234",
      "why": "you were directly addressed"
    }
  ],
  "workOmitted": 0,
  "metrics": [
    {
      "name": "octocat/example-app",
      "stars": 1200,
      "starsChange": 3,
      "downloads": 24000,
      "downloadsChange": 76,
      "openIssues": 15
    }
  ],
  "recap": null
}
```

</details>

<details>
<summary><code>daybreak deliver --dry-run</code> — deterministic Telegram text</summary>

```text
☀️ Wednesday, September 2, 2026

━━━━━━━━━━━━━━━━━━━━

🌤️ WEATHER
Toronto, Ontario, Canada: 20.4°C, partly cloudy. Feels like 22.1°C.
High 25.5°C, low 20.1°C. Rain chance 79%.
Tomorrow: drizzle, high 26.4°C, rain chance 13%.

━━━━━━━━━━━━━━━━━━━━

📅 CALENDAR
No events today or tomorrow.

━━━━━━━━━━━━━━━━━━━━

📬 EMAIL
46 received in the last day, 2 unread.
- Example Bank: A payment was made using your Credit Card (read)
- Example Society: Payment Receipt/Dues Receipt No.680 generated for A-04 (read)
- Example Fund: Powering the Green Transition (read)
- 3 more worth a look
37 filtered as newsletters, promotions or already handled.

━━━━━━━━━━━━━━━━━━━━

🐙 GITHUB
- example-app: 1200 stars (+3 stars), 24000 downloads (+76 downloads), 15 open issues
- example-kit: 1 stars (+0 stars), 541 downloads (+6 downloads), 0 open issues
0 assigned issues, 0 assigned PRs, 0 reviews, 0 notifications

━━━━━━━━━━━━━━━━━━━━

🦊 GITLAB
7 pending todos (4 filtered).
- build_failed: Present questions in notification mails as plain text
- directly_addressed: Migrate blob viewer to copyToClipboard
- mentioned: 19.3 Plan retrospective
- assigned: Natural Language filtering support for Work Items list
example-org/example: 4 reviews, 15 assigned issues, 2 authored MRs.
- example-org/example!253151: Add container border to sticky header tables [review_requested, pipeline_failed, unresolved_discussions]
- example-org/example!250520: Migrate blob viewer to copyToClipboard [review_requested, pipeline_failed, merge_conflict]
```

</details>

<details>
<summary><code>daybreak doctor</code> — preflight checks</summary>

Exits `0` when every check passes and `2` on any failure, so it is usable as a scheduling guard. The
example below shows one failing check.

```json
{
  "status": "error",
  "checks": [
    { "integration": "gws", "status": "ok", "message": "available", "version": "gws 0.22.5" },
    {
      "integration": "gws",
      "target": "1",
      "status": "ok",
      "message": "authenticated as primary@example.com"
    },
    {
      "integration": "gws",
      "target": "2",
      "status": "ok",
      "message": "authenticated as secondary@example.com"
    },
    {
      "integration": "gh",
      "status": "ok",
      "message": "available",
      "version": "gh version 2.97.0 (2026-07-31)"
    },
    {
      "integration": "gh",
      "target": "github.com",
      "status": "ok",
      "message": "authenticated as octocat"
    },
    {
      "integration": "glab",
      "status": "ok",
      "message": "available",
      "version": "glab 1.115.0 (c3612c8de)"
    },
    {
      "integration": "glab",
      "target": "gitlab.com",
      "status": "ok",
      "message": "authenticated as octocat"
    },
    {
      "integration": "telegram",
      "target": "123456789",
      "status": "error",
      "message": "TELEGRAM_BOT_TOKEN is not set"
    }
  ]
}
```

A revoked Google refresh token surfaces here as a failing `gws` target:

```json
{
  "integration": "gws",
  "target": "1",
  "status": "error",
  "message": "gws: Authentication failed: Failed to get token: Server error: invalid_grant: Token has been expired or revoked."
}
```

`deliver` reads `.env` from the current working directory, so run `doctor` from the project
directory when validating the Telegram token.

</details>

<details>
<summary><code>daybreak config check</code>, <code>--version</code>, <code>--help</code></summary>

```text
$ daybreak config check
Configuration is valid: config.yml
```

```text
$ daybreak --version
daybreak 0.1.0
```

```text
$ daybreak --help
Daybreak fetches and normalizes a personal morning brief.

Usage:
  daybreak fetch [options]
  daybreak deliver [options]
  daybreak doctor [--config PATH]
  daybreak telegram chats
  daybreak config check [--config PATH]

Fetch options:
  --config PATH          Configuration file (defaults to ./config.yml)
  --pretty               Pretty-print JSON output
  --format json|agent    json: full normalized payload (default)
                         agent: compact, flat, pre-ranked payload for an LLM
  --max-items N          Cap entries per list in the agent format (default 15).
                         Lower it for a local model with a short context window.
  --section LIST         Comma-separated sections to fetch
  --date YYYY-MM-DD      Replay using a reporting date at 07:00 local time
  --no-write-state       Do not save GitHub metric snapshots
  --dry-run              Render delivery text without sending it

Other:
  -h, --help             Show help
  -V, --version          Show version
```

</details>

## Filtering out the noise

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
The other two lists default to empty and match case-insensitive substrings.

Gmail's own `IMPORTANT` flag is deliberately **not** used to select mail, because it fires on a
large share of newsletters. A read message reaches the brief only when its subject suggests a
pending decision.

## Weekly recap

Set `gitlab.recap` to also collect merge requests you merged and issues you closed within a lookback
window, alongside the open work:

```yaml
gitlab:
  recap: 7d
```

Omit the key to skip the extra API calls.

## Telegram delivery

Create a bot through Telegram's `@BotFather`, then **start a chat with it**. Telegram bots cannot
open a private conversation until the recipient has messaged them first.

Store the token in the project-local `.env`, not in `config.yml`:

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace-with-your-token
```

Find the destination chat ID after sending your bot a message:

```sh
deno task telegram:chats
```

This lists only chat IDs, types and display names. Use the intended chat's `id`:

```yaml
telegram:
  enabled: true
  chat_id: 123456789
  disable_link_previews: true
```

Do not use the bot's own numeric user ID. The destination must come from a message sent _to_ the bot
by your personal account, a group, or a channel.

Validate the token and destination without sending anything:

```sh
deno task doctor
```

Preview the rendered text locally, then send for real:

```sh
deno task deliver --dry-run
deno task deliver
```

Long briefs are split at paragraph boundaries to stay under Telegram's message-size limit. The
current renderer is deterministic; a local email summarizer can later replace only the email
selection and prose stage without touching delivery.

## Running as a native binary

```sh
mkdir -p dist
deno task compile
./dist/daybreak fetch --pretty
```

The compiled binary still needs the third-party CLIs installed and authenticated.

## Metric history and state

GitHub and GitLab metric snapshots are stored in SQLite. A delta compares the current value against
the most recent snapshot at or before the configured lookback boundary.

Two consequences worth expecting:

- **The first run reports `null` deltas.** There is nothing to compare against yet.
- **Deltas need a snapshot older than the lookback window**, so they stay `null` until enough
  history accumulates.

Use `--no-write-state` for previews and diagnostics, so an ad-hoc run does not lay down a snapshot
that skews the next real one.

## Exit codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| `0`  | Command succeeded                                  |
| `1`  | Invalid arguments or configuration                 |
| `2`  | Preflight dependency or authentication failure     |
| `3`  | Fetch completed, but one or more collectors failed |

Because `doctor` exits `2` on any failure, it works directly as a guard in a scheduled job.

## Troubleshooting

**`doctor` reports a `gws` target as failing.** Look at the message. An expired or revoked Google
refresh token appears as `invalid_grant: Token has been expired or revoked`. Re-authenticate just
that profile:

```sh
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/daybreak/google/1" \
  gws auth login --readonly -s gmail,calendar
```

**`doctor` says `TELEGRAM_BOT_TOKEN is not set` even though `.env` exists.** `.env` is read from the
current working directory. Run the command from the project directory.

**A collector failed but the run still produced output.** That is exit code `3`. Mail collection in
particular is per-account and independent: if one Google account fails, the others still report, and
the failure is recorded in that section's `warnings` and surfaced under `health.problems` in the
agent format. Check there rather than assuming a quiet payload is a complete one.

**Metric deltas are `null`.** Expected on the first run, and until a snapshot older than the
lookback boundary exists. See [Metric history and state](#metric-history-and-state).

## Implementation notes

**Merge request detail.** GitLab's merge request list endpoint omits `head_pipeline` and reports
`detailed_merge_status` as `unchecked`. Pipeline status, real merge status and approvals are
therefore fetched per merge request — only for the ones that actually reach the brief, and capped at
25 per project.

## Development

```sh
deno task lint       # Deno's recommended rule set
deno task lint:fix   # apply safe automatic fixes
deno task check      # formatting, linting, type checking and tests together
```

Daybreak uses `deno lint` rather than the deprecated TSLint package. Lint configuration lives in
`deno.json`.
