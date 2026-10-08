# Probe targets

Prometheus reads these files at runtime (no restart needed). Copy each `*.example.yml` to the same
name without `.example` and put the real URLs in it; the copies are git-ignored because they hold
hostnames that belong to the operator.

| File           | Probe module | What the URL is                                              |
| -------------- | ------------ | ------------------------------------------------------------ |
| `app.yml`      | `http_2xx`   | the public app, e.g. `https://app.example/markets`           |
| `status.yml`   | `status_ok`  | the public status line, `https://app.example/api/status`     |
| `indexer.yml`  | `graphql`    | the indexer's GraphQL endpoint                               |
| `scheduler.yml`| `http_2xx`   | the scheduler's `/health` (set `HEALTH_HOST` so it is reachable from Prometheus) |

If a file has no targets the alert `ProbeTargetsMissing` fires: monitoring that silently watches
nothing is the failure this setup is designed to avoid.
