#!/usr/bin/env node

/**
 * mcp-server-tilt
 *
 * MCP server for Tilt dev environments. Exposes tools to query resource
 * status, read logs, trigger rebuilds, and wait for services to become
 * healthy — all through the Model Context Protocol.
 *
 * Usage:
 *   npx mcp-server-tilt
 *
 * Configuration (environment variables):
 *   TILT_PORT       — Tilt API port (auto-detected from ~/.tilt-dev/config if omitted)
 *   TILT_HOST       — Tilt API host (default: localhost)
 *   TILT_MCP_CONFIG — Path to .tilt-mcp.json config file (default: auto-discovered in cwd)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Stdout protection — StdioServerTransport uses stdout for JSON-RPC.
// Any stray write to stdout corrupts the protocol. Redirect all console
// methods to stderr and install global error handlers.
// ---------------------------------------------------------------------------
const stderr = (...args) => {
  process.stderr.write(`[mcp-server-tilt] ${args.join(' ')}\n`);
};
console.log = console.info = console.debug = stderr;
console.warn = (...args) => {
  process.stderr.write(`[mcp-server-tilt] WARN: ${args.join(' ')}\n`);
};
console.error = (...args) => {
  process.stderr.write(`[mcp-server-tilt] ERROR: ${args.join(' ')}\n`);
};

process.on('uncaughtException', (err) => {
  process.stderr.write(
    `[mcp-server-tilt] uncaughtException: ${err?.message}\n`,
  );
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    `[mcp-server-tilt] unhandledRejection: ${reason}\n`,
  );
});

// ---------------------------------------------------------------------------
// Project configuration — .tilt-mcp.json
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32';

/**
 * Load project-specific config from .tilt-mcp.json.
 * Search order:
 *   1. TILT_MCP_CONFIG env var (explicit path)
 *   2. .tilt-mcp.json in current working directory
 */
function loadConfig() {
  const paths = [];
  if (process.env.TILT_MCP_CONFIG) {
    paths.push(resolve(process.env.TILT_MCP_CONFIG));
  }
  paths.push(resolve(process.cwd(), '.tilt-mcp.json'));

  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const cfg = JSON.parse(readFileSync(p, 'utf-8'));
        stderr(`Loaded config from ${p}`);
        return cfg;
      }
    } catch (err) {
      stderr(`Failed to load config from ${p}: ${err.message}`);
    }
  }
  stderr('No .tilt-mcp.json found — using defaults');
  return {};
}

const CONFIG = loadConfig();

// ---------------------------------------------------------------------------
// Tilt connection
// ---------------------------------------------------------------------------

/** Detect the active Tilt port from ~/.tilt-dev/config. Defaults to 10350. */
function detectTiltPort() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const configPath = resolve(home, '.tilt-dev', 'config');
    const content = readFileSync(configPath, 'utf-8');
    const ctxMatch = content.match(/current-context:\s*"?tilt-(\d+)"?/);
    if (ctxMatch) return ctxMatch[1];
    // "tilt-default" or empty current-context → use default port
    if (content.match(/current-context:\s*"?tilt-default"?/)) return '10350';
  } catch {
    /* config not found or unreadable — use default */
  }
  return '10350';
}

const TILT_PORT = process.env.TILT_PORT || detectTiltPort();
const TILT_HOST = process.env.TILT_HOST || 'localhost';

// ---------------------------------------------------------------------------
// Concurrency control
// ---------------------------------------------------------------------------

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.current < this.max) { this.current++; return; }
    await new Promise((r) => this.queue.push(r));
  }
  release() {
    this.current--;
    if (this.queue.length > 0) { this.current++; this.queue.shift()(); }
  }
}

const cliSemaphore = new Semaphore(3);

// ---------------------------------------------------------------------------
// Shared resource cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 2000;
let resourceCache = { data: null, timestamp: 0 };
let resourceCacheFetchPromise = null;

async function getCachedAllResources() {
  const now = Date.now();
  if (resourceCache.data && now - resourceCache.timestamp < CACHE_TTL_MS) {
    return resourceCache.data;
  }
  if (resourceCacheFetchPromise) return resourceCacheFetchPromise;
  resourceCacheFetchPromise = tiltApiFetch('/uiresources')
    .then((data) => {
      resourceCache = { data, timestamp: Date.now() };
      resourceCacheFetchPromise = null;
      return data;
    })
    .catch((err) => {
      resourceCacheFetchPromise = null;
      throw err;
    });
  return resourceCacheFetchPromise;
}

async function getCachedResource(name) {
  const all = await getCachedAllResources();
  const item = (all.items || []).find((i) => i.metadata?.name === name);
  if (!item) throw new Error(`Resource "${name}" not found in Tilt`);
  return item;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRetryable(err) {
  const msg = err?.message || '';
  return msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET') || msg.includes('EPIPE');
}

async function tiltCli(args, timeoutMs = 30_000, retries = 2) {
  const hostFlag = TILT_HOST !== 'localhost' ? ` --host ${TILT_HOST}` : '';
  const cmd = `tilt --port ${TILT_PORT}${hostFlag} ${args}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await cliSemaphore.acquire();
    try {
      const { stdout } = await execAsync(cmd, {
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        ...(IS_WINDOWS && { windowsHide: true }),
        ...(CONFIG.cwd && { cwd: CONFIG.cwd }),
      });
      return stdout.trim();
    } catch (err) {
      if (attempt < retries && isRetryable(err)) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      cliSemaphore.release();
    }
  }
}

async function tiltApiFetch(path) {
  const parts = path.replace(/^\//, '').split('/');
  const kind = parts[0];
  const name = parts[1];
  const cmd = name ? `get ${kind} ${name} -o json` : `get ${kind} -o json`;
  const json = await tiltCli(cmd, 30_000);
  return JSON.parse(json);
}

function lastLines(text, n) { return text.split('\n').slice(-n).join('\n'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function formatResourceLine(item) {
  const name = item.metadata?.name || 'unknown';
  const s = item.status || {};
  return { name, runtime: s.runtimeStatus || 'n/a', update: s.updateStatus || 'n/a' };
}

function statusIcon(runtime, update) {
  if (runtime === 'error' || update === 'error') return 'ERR';
  if (runtime === 'pending' || update === 'in_progress') return '...';
  if (runtime === 'ok' || update === 'ok' || update === 'not_applicable') return ' OK';
  return ' ? ';
}

// ---------------------------------------------------------------------------
// Resource grouping (config-driven)
// ---------------------------------------------------------------------------

function matchesPattern(name, pattern) {
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

function getGroup(name) {
  if (!CONFIG.groups) return null;
  for (const [group, patterns] of Object.entries(CONFIG.groups)) {
    if (patterns.some((p) => matchesPattern(name, p))) return group;
  }
  return CONFIG.defaultGroup || 'Other';
}

// ---------------------------------------------------------------------------
// Server factory — exported for Smithery scanning
// ---------------------------------------------------------------------------

export function createServer() {
  const server = new McpServer({
    name: 'mcp-server-tilt',
    version: '1.1.0',
  });

  // ---- status -------------------------------------------------------------
  server.tool(
    'status',
    'Get status of Tilt resources. Returns runtime/update status for all or a specific resource.',
    {
      name: z.string().optional().describe('Resource name (optional — omit for all resources)'),
    },
    async ({ name }) => {
      if (name) {
        const data = await tiltApiFetch(`/uiresources/${name}`);
        const s = data.status || {};
        const runtime = s.runtimeStatus || 'n/a';
        const update = s.updateStatus || 'n/a';
        const lastErr = s.buildHistory?.[0]?.error || '';
        let text = `Resource: ${name}\nRuntime:  ${runtime}\nUpdate:   ${update}`;
        if (lastErr) text += `\nLast Error: ${lastErr.substring(0, 500)}`;
        return { content: [{ type: 'text', text }] };
      }
      const data = await tiltApiFetch('/uiresources');
      const items = (data.items || []).map(formatResourceLine);
      const errors = items.filter((i) => i.runtime === 'error' || i.update === 'error');
      const pending = items.filter(
        (i) => (i.runtime === 'pending' || i.update === 'in_progress') && !errors.includes(i),
      );
      const healthy = items.filter((i) => !errors.includes(i) && !pending.includes(i));
      let text = `# Tilt Status — ${items.length} resources\n`;
      if (errors.length) {
        text += `\n## ERRORS (${errors.length})\n`;
        for (const i of errors) text += `  [ERR] ${i.name}  runtime=${i.runtime}  update=${i.update}\n`;
      }
      if (pending.length) {
        text += `\n## IN PROGRESS (${pending.length})\n`;
        for (const i of pending) text += `  [...] ${i.name}  runtime=${i.runtime}  update=${i.update}\n`;
      }
      text += `\n## HEALTHY (${healthy.length})\n`;
      for (const i of healthy) text += `  [ OK] ${i.name}  runtime=${i.runtime}  update=${i.update}\n`;
      return { content: [{ type: 'text', text }] };
    },
  );

  // ---- logs ---------------------------------------------------------------
  server.tool(
    'logs',
    'Get recent logs for a Tilt resource.',
    {
      name: z.string().describe('Resource name (e.g. my-api, frontend-build)'),
      lines: z.number().optional().describe('Number of lines to return (default 50)'),
    },
    async ({ name, lines }) => {
      const n = lines ?? 50;
      const output = await tiltCli(`logs --resource ${name}`, 15_000);
      const trimmed = lastLines(output, n);
      return { content: [{ type: 'text', text: trimmed || '(no logs)' }] };
    },
  );

  // ---- trigger ------------------------------------------------------------
  server.tool(
    'trigger',
    'Trigger a manual Tilt resource (rebuild, rerun tests, restart service). Returns immediately — does NOT wait for completion. Use trigger_and_wait if you need to wait.',
    {
      name: z.string().describe('Resource name to trigger (e.g. my-api, frontend-build)'),
    },
    async ({ name }) => {
      await tiltCli(`trigger ${name}`, 10_000);
      return { content: [{ type: 'text', text: `Triggered: ${name}` }] };
    },
  );

  // ---- trigger_and_wait ---------------------------------------------------
  server.tool(
    'trigger_and_wait',
    'Trigger a resource and poll until it completes (healthy or error). Returns final status and logs on failure.',
    {
      name: z.string().describe('Resource name to trigger'),
      timeout_seconds: z.number().optional().describe('Max seconds to wait (default 180, max 600)'),
    },
    async ({ name, timeout_seconds }) => {
      const timeout = Math.min(timeout_seconds ?? 180, 600);
      await tiltCli(`trigger ${name}`, 10_000);
      await sleep(2000);
      const deadline = Date.now() + timeout * 1000;
      let lastRuntime = 'unknown';
      let lastUpdate = 'unknown';
      while (Date.now() < deadline) {
        let s;
        try {
          const item = await getCachedResource(name);
          s = item.status || {};
        } catch {
          await sleep(3000 + Math.random() * 2000);
          continue;
        }
        lastRuntime = s.runtimeStatus || 'n/a';
        lastUpdate = s.updateStatus || 'n/a';
        if (s.updateStatus === 'error') {
          const errMsg = s.buildHistory?.[0]?.error || '';
          let text = `FAILED: ${name}\nUpdate: ${s.updateStatus} | Runtime: ${lastRuntime}`;
          if (errMsg) text += `\nError: ${errMsg.substring(0, 500)}`;
          try { text += `\n\nRecent logs:\n${lastLines(await tiltCli(`logs --resource ${name}`, 10_000), 40)}`; } catch { /* ignore */ }
          return { content: [{ type: 'text', text }] };
        }
        if (s.updateStatus === 'ok' || s.updateStatus === 'not_applicable') {
          if (!s.runtimeStatus || s.runtimeStatus === 'ok' || s.runtimeStatus === 'not_applicable') {
            return { content: [{ type: 'text', text: `OK: ${name} (runtime=${lastRuntime}, update=${s.updateStatus})` }] };
          }
          if (s.runtimeStatus === 'error' || s.runtimeStatus === 'not_ok') {
            let text = `PARTIAL: ${name} — update succeeded but runtime error\nRuntime: ${s.runtimeStatus}`;
            try { text += `\n\nRecent logs:\n${lastLines(await tiltCli(`logs --resource ${name}`, 10_000), 40)}`; } catch { /* ignore */ }
            return { content: [{ type: 'text', text }] };
          }
        }
        await sleep(3000 + Math.random() * 2000);
      }
      return { content: [{ type: 'text', text: `TIMEOUT: ${name} after ${timeout}s\nLast status: runtime=${lastRuntime}, update=${lastUpdate}` }] };
    },
  );

  // ---- errors -------------------------------------------------------------
  server.tool(
    'errors',
    'List Tilt resources in an error state. Reads from a configured errors file if available, otherwise queries the Tilt API.',
    {},
    async () => {
      // File-based errors (from external error monitor)
      if (CONFIG.errorsFile) {
        const filePath = resolve(CONFIG.cwd || process.cwd(), CONFIG.errorsFile);
        if (!existsSync(filePath)) {
          return {
            content: [{
              type: 'text',
              text: `No errors — ${CONFIG.errorsFile} does not exist (all resources healthy, or monitor not running).`,
            }],
          };
        }
        const content = readFileSync(filePath, 'utf-8');
        return { content: [{ type: 'text', text: content || 'No errors — file is empty.' }] };
      }

      // API-based errors (default)
      const data = await tiltApiFetch('/uiresources');
      const items = (data.items || []).map((item) => {
        const name = item.metadata?.name || 'unknown';
        const s = item.status || {};
        return { name, runtime: s.runtimeStatus || 'n/a', update: s.updateStatus || 'n/a', lastErr: s.buildHistory?.[0]?.error || '' };
      });
      const errors = items.filter((i) => i.runtime === 'error' || i.update === 'error');
      if (errors.length === 0) {
        return { content: [{ type: 'text', text: 'No errors — all resources healthy.' }] };
      }
      let text = `## ${errors.length} resource(s) in error state\n\n`;
      for (const e of errors) {
        text += `**${e.name}** — runtime=${e.runtime}, update=${e.update}\n`;
        if (e.lastErr) text += `  Error: ${e.lastErr.substring(0, 300)}\n`;
        text += '\n';
      }
      return { content: [{ type: 'text', text }] };
    },
  );

  // ---- resources ----------------------------------------------------------
  server.tool(
    'resources',
    'List all Tilt resource names with status icons. Groups by service domain when configured.',
    {},
    async () => {
      const data = await tiltApiFetch('/uiresources');
      const items = (data.items || []).map(formatResourceLine);

      // Grouped output when config.groups is defined
      if (CONFIG.groups) {
        const groups = {};
        for (const item of items) {
          const group = getGroup(item.name);
          if (!groups[group]) groups[group] = [];
          groups[group].push(item);
        }
        let text = '';
        for (const [group, members] of Object.entries(groups).sort()) {
          text += `## ${group}\n`;
          for (const i of members) {
            text += `  [${statusIcon(i.runtime, i.update)}] ${i.name}\n`;
          }
          text += '\n';
        }
        return { content: [{ type: 'text', text }] };
      }

      // Flat list (default)
      let text = '';
      for (const i of items) text += `[${statusIcon(i.runtime, i.update)}] ${i.name}\n`;
      return { content: [{ type: 'text', text }] };
    },
  );

  return server;
}

/**
 * Smithery sandbox export — allows Smithery to scan tools without
 * needing a running Tilt instance.
 */
export function createSandboxServer() {
  return createServer();
}

// Default export for Smithery compatibility
export default createServer;

// ---------------------------------------------------------------------------
// CLI entry point — only runs when executed directly, not when imported
// ---------------------------------------------------------------------------

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('mcp-server-tilt') ||
   process.argv[1].endsWith('index.mjs') ||
   process.argv[1].includes('mcp-server-tilt'));

if (isDirectRun) {
  const transport = new StdioServerTransport();
  const server = createServer();
  server.connect(transport);
}
