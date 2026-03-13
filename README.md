# mcp-server-tilt

[![npm version](https://img.shields.io/npm/v/mcp-server-tilt.svg)](https://www.npmjs.com/package/mcp-server-tilt)
[![license](https://img.shields.io/npm/l/mcp-server-tilt.svg)](https://github.com/openmindednewby/mcp-server-tilt/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/mcp-server-tilt.svg)](https://nodejs.org)

MCP server for [Tilt](https://tilt.dev) dev environments. Query resource status, read logs, trigger rebuilds, and wait for services to become healthy — all through the [Model Context Protocol](https://modelcontextprotocol.io).

## Tools

| Tool | Description |
|------|-------------|
| `status` | Get runtime/update status for all resources or a specific one |
| `logs` | Read recent logs for a resource |
| `trigger` | Trigger a resource rebuild (fire-and-forget) |
| `trigger_and_wait` | Trigger a resource and poll until it completes or fails |
| `errors` | List all resources currently in an error state |
| `resources` | List all resource names with status icons |

## Installation

```bash
npx mcp-server-tilt
```

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "tilt": {
      "command": "npx",
      "args": ["-y", "mcp-server-tilt"]
    }
  }
}
```

### Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tilt": {
      "command": "npx",
      "args": ["-y", "mcp-server-tilt"]
    }
  }
}
```

### Other MCP Clients

The server communicates over stdio using the MCP protocol. Point any MCP-compatible client at:

```bash
npx mcp-server-tilt
```

## Prerequisites

- [Node.js](https://nodejs.org) >= 18
- [Tilt](https://tilt.dev) installed and running (`tilt` CLI available on PATH)

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TILT_PORT` | Auto-detected from `~/.tilt-dev/config`, falls back to `10350` | Tilt API port |
| `TILT_HOST` | `localhost` | Tilt API host (for remote Tilt instances) |
| `TILT_MCP_CONFIG` | `.tilt-mcp.json` in working directory | Path to config file |

Example with custom port:

```json
{
  "mcpServers": {
    "tilt": {
      "command": "npx",
      "args": ["-y", "mcp-server-tilt"],
      "env": {
        "TILT_PORT": "10351"
      }
    }
  }
}
```

### Project Config File (`.tilt-mcp.json`)

For project-specific customization, create a `.tilt-mcp.json` file in your project root. The server auto-discovers it from the working directory, or you can point to it with `TILT_MCP_CONFIG`.

```json
{
  "errorsFile": "./tilt-errors.log",
  "cwd": "/path/to/project",
  "groups": {
    "Backend": ["api-*", "worker-*"],
    "Frontend": ["web-*", "assets-*"],
    "Infrastructure": ["postgres", "redis", "rabbitmq"]
  },
  "defaultGroup": "Other"
}
```

#### Config Options

| Option | Type | Description |
|--------|------|-------------|
| `errorsFile` | `string` | Path to an errors log file. When set, the `errors` tool reads from this file instead of querying the Tilt API. Resolved relative to `cwd`. |
| `cwd` | `string` | Working directory for `tilt` CLI execution. Defaults to the process working directory. |
| `groups` | `object` | Resource grouping rules for the `resources` tool. Keys are group names, values are arrays of patterns. Patterns support `*` as a suffix wildcard (e.g. `api-*` matches `api-gateway`, `api-auth`). Exact strings match exactly. |
| `defaultGroup` | `string` | Fallback group name for resources that don't match any pattern. Defaults to `"Other"`. |

Without a config file, the server works with sensible defaults — flat resource lists and API-based error detection.

## Tool Details

### `status`

Get the status of all Tilt resources or a specific one.

**Parameters:**
- `name` (optional) — Resource name. If omitted, returns all resources grouped by status (errors, in-progress, healthy).

### `logs`

Read recent log output for a resource.

**Parameters:**
- `name` (required) — Resource name
- `lines` (optional, default: 50) — Number of log lines to return

### `trigger`

Trigger a manual Tilt resource rebuild. Returns immediately without waiting for completion.

**Parameters:**
- `name` (required) — Resource name to trigger

### `trigger_and_wait`

Trigger a resource and poll until it reaches a terminal state (healthy, error, or timeout). On failure, includes the error message and recent logs.

**Parameters:**
- `name` (required) — Resource name to trigger
- `timeout_seconds` (optional, default: 180, max: 600) — Maximum seconds to wait

**Return values:**
- `OK: <name>` — Resource completed successfully
- `FAILED: <name>` — Resource build/update failed (includes error + logs)
- `PARTIAL: <name>` — Build succeeded but runtime crashed (includes logs)
- `TIMEOUT: <name>` — Deadline exceeded

### `errors`

List all resources currently in an error state. When `errorsFile` is configured, reads from the file (useful with external error monitors). Otherwise queries the Tilt API directly.

### `resources`

List all resource names with a status icon: `[ OK]`, `[ERR]`, `[...]`, or `[ ? ]`. When `groups` are configured, resources are organized by service domain.

## How It Works

The server wraps the `tilt` CLI rather than hitting the HTTP API directly. This is because Tilt v0.36+ serves the SPA UI on all HTTP paths, making the REST API unreachable via fetch. The CLI uses an internal gRPC channel that still works.

Key implementation details:
- **Concurrency control** — A semaphore limits parallel CLI calls to 3 to prevent overload
- **Shared resource cache** — Parallel status polls within a 2-second window share a single CLI call
- **Retry with backoff** — Transient network errors (ETIMEDOUT, ECONNRESET) are retried up to 2 times
- **Jittered polling** — `trigger_and_wait` uses randomized poll intervals to prevent thundering herd

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/openmindednewby/mcp-server-tilt).

## Links

- [npm package](https://www.npmjs.com/package/mcp-server-tilt)
- [GitHub repository](https://github.com/openmindednewby/mcp-server-tilt)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Tilt](https://tilt.dev)
- [Tilt integration request](https://github.com/tilt-dev/tilt/issues/6724) — tracking issue for official docs mention

## License

[MIT](LICENSE)
