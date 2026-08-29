import {
  Client,
  StreamableHTTPClientTransport,
  type DiscoverResult,
  type PriorDiscovery,
  type Transport,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ServerEntry } from "../core/config.js";
import { InvalidServerConfigError } from "./errors.js";
import { resolveHttpHeaders, resolveHttpMode, resolveHttpUrl } from "./http.js";
import { assertOAuthServerConfig, createOAuthProvider, isOAuthEnabled } from "./oauth-provider.js";
import { buildServerEnv, resolveServerCwd } from "./stdio.js";

export interface ConnectOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  home?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  prior?: PriorDiscovery;
  onToolsChanged?: () => void;
}

export type McpTransportKind = "stdio" | "streamable-http";

export type NegotiatedProtocol =
  | { era: "legacy"; version: string }
  | { era: "modern"; version: string; discover: DiscoverResult };

export interface McpConnection {
  serverName: string;
  status: "connected" | "failed" | "closed";
  client: Client;
  transport: Transport;
  transportKind: McpTransportKind;
  protocol: NegotiatedProtocol;
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

    resolveHttpMode(definition);
    const url = resolveHttpUrl(serverName, definition);
    assertOAuthServerConfig(serverName, definition);
    const oauthProvider = isOAuthEnabled(definition)
      ? createOAuthProvider({ serverName, serverUrl: url, definition, home: options.home })
      : undefined;
    const headers = oauthProvider ? { ...(definition.headers ?? {}) } : resolveHttpHeaders(serverName, definition, options.env ?? process.env);

    try {
      return await this.createHttpTransportConnection(serverName, definition, url, headers, options, oauthProvider);
    } catch (error) {
      throw new Error(`Failed to connect to "${serverName}": ${errorMessage(error)}`);
    }
  }

  private async createHttpTransportConnection(
    serverName: string,
    definition: ServerEntry,
    url: URL,
    headers: Record<string, string>,
    options: ConnectOptions,
    oauthProvider: ReturnType<typeof createOAuthProvider> | undefined,
  ): Promise<McpConnection> {
    const client = createClient(definition, options);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
      authProvider: oauthProvider,
    });

    try {
      await client.connect(transport, {
        signal: options.signal,
        timeout: options.timeoutMs ?? 10_000,
        prior: options.prior,
      });
      if (options.signal?.aborted) throw new Error("request was aborted");
      return createConnectionRecord(serverName, client, transport, "streamable-http");
    } catch (error) {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw new Error(`Streamable HTTP failed: ${errorMessage(error)}`);
    }
  }

  private async createStdioConnection(serverName: string, definition: ServerEntry, options: ConnectOptions): Promise<McpConnection> {
    if (options.signal?.aborted) throw new Error(`Failed to connect to "${serverName}": request was aborted.`);

    const client = createClient(definition, options);
    const transport = new StdioClientTransport({
      command: definition.command!,
      args: definition.args ?? [],
      cwd: resolveServerCwd(definition.cwd, options),
      env: buildServerEnv(definition.env, options.env ?? process.env),
      stderr: "pipe",
    });
    try {
      await client.connect(transport, {
        signal: options.signal,
        timeout: options.timeoutMs ?? 10_000,
        prior: options.prior,
      });
      if (options.signal?.aborted) throw new Error("request was aborted");
      return createConnectionRecord(serverName, client, transport, "stdio");
    } catch (error) {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to "${serverName}": ${message}`);
    }
  }
}

function createClient(definition: ServerEntry, options: Pick<ConnectOptions, "onToolsChanged">): Client {
  return new Client(
    { name: "letta-mcp-adapter", version: "0.1.0" },
    {
      capabilities: {},
      listMaxPages: 10,
      listChanged: options.onToolsChanged
        ? {
            tools: {
              autoRefresh: false,
              debounceMs: 0,
              onChanged(error) {
                if (!error) options.onToolsChanged?.();
              },
            },
          }
        : undefined,
      versionNegotiation: { mode: resolveVersionNegotiationMode(definition.protocolVersion) },
    },
  );
}

function resolveVersionNegotiationMode(protocolVersion: ServerEntry["protocolVersion"]): VersionNegotiationMode {
  if (protocolVersion === "auto") return "auto";
  if (protocolVersion === "2026-07-28") return { pin: protocolVersion };
  return "legacy";
}

function createConnectionRecord(
  serverName: string,
  client: Client,
  transport: Transport,
  transportKind: McpTransportKind,
): McpConnection {
  const version = client.getNegotiatedProtocolVersion();
  const era = client.getProtocolEra();
  if (!version || !era) throw new Error("MCP connection completed without a negotiated protocol version.");

  const discover = client.getDiscoverResult();
  if (era === "modern" && !discover) throw new Error("Modern MCP connection completed without a discovery result.");
  const protocol: NegotiatedProtocol = era === "modern"
    ? { era, version, discover: discover! }
    : { era, version };

  const connection: McpConnection = {
    serverName,
    status: "connected",
    client,
    transport,
    transportKind,
    protocol,
    close: async () => {
      if (connection.status === "closed") return;
      connection.status = "closed";
      await client.close();
    },
  };
  return connection;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
