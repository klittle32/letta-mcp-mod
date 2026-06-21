import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerEntry } from "../core/config.js";
import { InvalidServerConfigError } from "./errors.js";
import { mergeHeaders, resolveHttpHeaders, resolveHttpMode, resolveHttpUrl, type HttpTransportKind } from "./http.js";
import { assertOAuthServerConfig, createOAuthProvider, isOAuthEnabled } from "./oauth-provider.js";
import { buildServerEnv, resolveServerCwd } from "./stdio.js";

export interface ConnectOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  home?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type McpTransportKind = "stdio" | "streamable-http" | "sse";

export interface McpConnection {
  serverName: string;
  status: "connected" | "failed" | "closed";
  client: Client;
  transport: Transport;
  transportKind: McpTransportKind;
  close(): Promise<void>;
}

export { UnsupportedTransportError, InvalidServerConfigError } from "./errors.js";

export class McpServerManager {
  private connections = new Map<string, McpConnection>();
  private inFlight = new Map<string, Promise<McpConnection>>();

  async connect(serverName: string, definition: ServerEntry, options: ConnectOptions): Promise<McpConnection> {
    if (!definition.command && !definition.url) {
      throw new InvalidServerConfigError(`Server "${serverName}" is invalid: MCP servers require either a command or a url.`);
    }

    const existing = this.connections.get(serverName);
    if (existing?.status === "connected") return existing;
    const pending = this.inFlight.get(serverName);
    if (pending) return pending;

    const promise = this.createConnection(serverName, definition, options);
    this.inFlight.set(serverName, promise);
    try {
      const connection = await promise;
      this.connections.set(serverName, connection);
      return connection;
    } finally {
      this.inFlight.delete(serverName);
    }
  }

  getConnection(serverName: string): McpConnection | undefined {
    return this.connections.get(serverName);
  }

  async close(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    this.connections.delete(serverName);
    if (connection) await connection.close();
  }

  async closeAll(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    this.inFlight.clear();
    await Promise.allSettled(connections.map((connection) => connection.close()));
  }

  private async createConnection(serverName: string, definition: ServerEntry, options: ConnectOptions): Promise<McpConnection> {
    if (definition.command) return this.createStdioConnection(serverName, definition, options);
    return this.createHttpConnection(serverName, definition, options);
  }

  private async createHttpConnection(serverName: string, definition: ServerEntry, options: ConnectOptions): Promise<McpConnection> {
    if (options.signal?.aborted) throw new Error(`Failed to connect to "${serverName}": request was aborted.`);

    const mode = resolveHttpMode(definition);
    const url = resolveHttpUrl(serverName, definition);
    assertOAuthServerConfig(serverName, definition);
    const oauthProvider = isOAuthEnabled(definition)
      ? createOAuthProvider({ serverName, serverUrl: url, definition, home: options.home })
      : undefined;
    const headers = oauthProvider ? { ...(definition.headers ?? {}) } : resolveHttpHeaders(serverName, definition, options.env ?? process.env);

    if (mode === "streamable-http") {
      try {
        return await this.createHttpTransportConnection("streamable-http", serverName, url, headers, options, oauthProvider);
      } catch (error) {
        throw new Error(`Failed to connect to "${serverName}": ${errorMessage(error)}`);
      }
    }

    if (mode === "sse") {
      try {
        return await this.createHttpTransportConnection("sse", serverName, url, headers, options, oauthProvider);
      } catch (error) {
        throw new Error(`Failed to connect to "${serverName}": ${errorMessage(error)}`);
      }
    }

    let streamableError: unknown;
    try {
      return await this.createHttpTransportConnection("streamable-http", serverName, url, headers, options, oauthProvider);
    } catch (error) {
      streamableError = error;
    }

    try {
      return await this.createHttpTransportConnection("sse", serverName, url, headers, options, oauthProvider);
    } catch (sseError) {
      throw new Error(`Failed to connect to "${serverName}" over HTTP MCP. ${errorMessage(streamableError)}. ${errorMessage(sseError)}.`);
    }
  }

  private async createHttpTransportConnection(
    kind: HttpTransportKind,
    serverName: string,
    url: URL,
    headers: Record<string, string>,
    options: ConnectOptions,
    oauthProvider: ReturnType<typeof createOAuthProvider> | undefined,
  ): Promise<McpConnection> {
    const client = new Client({ name: "letta-mcp-adapter", version: "0.1.0" }, { capabilities: {} });
    const transport: Transport = kind === "streamable-http"
      ? new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider: oauthProvider })
      : new SSEClientTransport(url, {
        authProvider: oauthProvider,
        requestInit: { headers },
        eventSourceInit: {
          fetch: async (input, init) => fetch(input, {
            ...init,
            headers: mergeHeaders(init?.headers, headers),
          }),
        },
      });

    const connection: McpConnection = {
      serverName,
      status: "connected",
      client,
      transport,
      transportKind: kind,
      close: async () => {
        if (connection.status === "closed") return;
        connection.status = "closed";
        await client.close();
      },
    };

    try {
      await client.connect(transport, { signal: options.signal, timeout: options.timeoutMs ?? 10_000 });
      if (options.signal?.aborted) throw new Error("request was aborted");
      return connection;
    } catch (error) {
      connection.status = "failed";
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      const label = kind === "streamable-http" ? "Streamable HTTP" : "SSE fallback";
      throw new Error(`${label} failed: ${errorMessage(error)}`);
    }
  }

  private async createStdioConnection(serverName: string, definition: ServerEntry, options: ConnectOptions): Promise<McpConnection> {
    if (options.signal?.aborted) throw new Error(`Failed to connect to "${serverName}": request was aborted.`);

    const client = new Client({ name: "letta-mcp-adapter", version: "0.1.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: definition.command!,
      args: definition.args ?? [],
      cwd: resolveServerCwd(definition.cwd, options),
      env: buildServerEnv(definition.env, options.env ?? process.env),
      stderr: "pipe",
    });
    const connection: McpConnection = {
      serverName,
      status: "connected",
      client,
      transport,
      transportKind: "stdio",
      close: async () => {
        if (connection.status === "closed") return;
        connection.status = "closed";
        await client.close();
      },
    };

    try {
      await client.connect(transport, { signal: options.signal, timeout: options.timeoutMs ?? 10_000 });
      if (options.signal?.aborted) throw new Error("request was aborted");
      return connection;
    } catch (error) {
      connection.status = "failed";
      await transport.close().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to "${serverName}": ${message}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
