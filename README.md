# Daybreak

Daybreak assembles your morning brief. It pulls weather, Gmail, Google Calendar, GitHub and GitLab
into one normalized document, decides what actually deserves your attention, and either renders it
as text or hands it to a language model to narrate.

It is the deterministic data layer for a personal morning brief: collection, filtering and ranking
are ordinary code, so the unpredictable part is confined to the last step.

## What it collects

- **Weather** — current conditions, today's arc, and tomorrow's outlook
- **Gmail** — across multiple accounts, with newsletters and promotions filtered out
- **Google Calendar** — today and the next two days, holidays kept separate from appointments
- **GitHub** — your issues, pull requests, review requests, notifications, and star and download
  counts for repositories you choose
- **GitLab** — todos, review requests, assigned issues and your own merge requests, with pipeline
  and merge status resolved

## What you get

```text
☀️ Wednesday, September 2, 2026

🌤️ WEATHER
Toronto, Ontario, Canada: 20.4°C, partly cloudy. Feels like 22.1°C.
High 25.5°C, low 20.1°C. Rain chance 79%.
Tomorrow: drizzle, high 26.4°C, rain chance 13%.

📬 EMAIL
46 received in the last day, 2 unread.
- Example Bank: A payment was made using your Credit Card (read)
- 3 more worth a look
37 filtered as newsletters, promotions or already handled.

🦊 GITLAB
- example-org/example!253151: Add container border to sticky header tables
  [review_requested, pipeline_failed, unresolved_discussions]
```

Full examples of every output format are in [the usage guide](usage.md#output-examples).

## How it works

Daybreak never talks to Google, GitHub or GitLab directly. It shells out to their official command
line tools — `gws`, `gh` and `glab` — and normalizes what comes back. Authentication stays with the
vendor tools, and no API tokens live in Daybreak's configuration.

There are two output formats:

- **`json`** — the complete normalized record of a run, for archiving or your own tooling
- **`agent`** — a compact, flat, already-ranked projection built for a small local language model
  with a short context window. Urgency is judged up front, reasons are pre-phrased in English, and
  every list is capped, so the model narrates rather than decides.

Delivery to Telegram is built in and deterministic. The agent format is the alternative when you
want prose instead.

## Quick start

You need [Deno](https://deno.com) 2.9+, plus `gws`, `gh` and `glab` installed and authenticated.

```sh
# 1. install the CLIs (macOS)
brew install --cask gcloud-cli
brew install googleworkspace-cli gh glab

# 2. authenticate them
gcloud auth login && gws auth setup
gh auth login
glab auth login --hostname gitlab.com

# 3. configure Daybreak
cp config.example.yml config.yml
cp .env.example .env

# 4. check everything works
deno task config:check
deno task doctor

# 5. see your brief
deno task deliver --dry-run
```

Google accounts need one extra step each — a separate `gws` profile per account — described in
[Google authentication](usage.md#google-authentication).

Once it looks right, `deno task deliver` sends it to Telegram, and `deno task compile` produces a
standalone binary suitable for a scheduled job.

## Documentation

The [usage guide](usage.md) covers the rest:

|                                                                     |                                                                |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| [Installing the dependencies](usage.md#installing-the-dependencies) | Requirements and one-time setup                                |
| [Google authentication](usage.md#google-authentication)             | One `gws` profile per Google account                           |
| [Configuration](usage.md#configuration)                             | `config.yml`, `.env`, and what is global vs. explicitly listed |
| [Commands and options](usage.md#commands-and-options)               | Every command and flag                                         |
| [Output formats](usage.md#output-formats)                           | `json` vs `agent`, and why the agent format exists             |
| [Output examples](usage.md#output-examples)                         | Real, redacted output for every command                        |
| [Filtering out the noise](usage.md#filtering-out-the-noise)         | Suppressing newsletters and recurring todos                    |
| [Telegram delivery](usage.md#telegram-delivery)                     | Bot setup and sending                                          |
| [Metric history and state](usage.md#metric-history-and-state)       | How star and download deltas work                              |
| [Troubleshooting](usage.md#troubleshooting)                         | Expired Google tokens, missing `.env`, null deltas             |

## Development

```sh
deno task check   # formatting, linting, type checking and tests
```

See [Development](usage.md#development) for the individual tasks.
