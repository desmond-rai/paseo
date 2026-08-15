import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";

const mockState = vi.hoisted(() => ({
  superConstructorOptions: [] as unknown[],
  createSessionCalls: [] as unknown[],
  resumeSessionCalls: [] as unknown[],
  fetchCatalogCalls: [] as unknown[],
  listFeaturesCalls: [] as unknown[],
  listImportableSessionsCalls: [] as unknown[],
}));

vi.mock("./acp-agent.js", () => ({
  DEFAULT_ACP_CAPABILITIES: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
    supportsRewindConversation: false,
    supportsRewindFiles: false,
    supportsRewindBoth: false,
  },
  ACPAgentClient: class ACPAgentClient {
    readonly provider: string;
    protected readonly runtimeSettings?: { env?: Record<string, string> };

    constructor(options: { runtimeSettings?: { env?: Record<string, string> } }) {
      this.provider = "acp";
      this.runtimeSettings = options.runtimeSettings;
      mockState.superConstructorOptions.push(options);
    }

    async createSession(config: unknown, launchContext: unknown) {
      mockState.createSessionCalls.push({ config, launchContext });
      return { kind: "created" };
    }

    async resumeSession(handle: unknown, overrides: unknown, launchContext: unknown) {
      mockState.resumeSessionCalls.push({ handle, overrides, launchContext });
      return { kind: "resumed" };
    }

    async fetchCatalog(options: unknown, context: unknown) {
      mockState.fetchCatalogCalls.push({
        options,
        context,
        env: { ...this.runtimeSettings?.env },
      });
      return { models: [], modes: [] };
    }

    async listFeatures(config: unknown) {
      mockState.listFeaturesCalls.push({ config, env: { ...this.runtimeSettings?.env } });
      return [];
    }

    async listImportableSessions(options: unknown) {
      mockState.listImportableSessionsCalls.push({
        options,
        env: { ...this.runtimeSettings?.env },
      });
      return [];
    }
  },
}));

import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient", () => {
  test("passes the custom command only as defaultCommand", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes", "acp"],
      env: {
        HERMES_LOG: "info",
      },
    });
    void _client;

    expect(mockState.superConstructorOptions).toEqual([
      {
        provider: "acp",
        logger: expect.any(Object),
        runtimeSettings: {
          env: {
            HERMES_LOG: "info",
          },
        },
        defaultCommand: ["hermes", "acp"],
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsMcpServers: true,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
          supportsRewindConversation: false,
          supportsRewindFiles: false,
          supportsRewindBoth: false,
        },
      },
    ]);
  });

  test("uses provider params to report MCP support", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["no-mcp-acp", "serve"],
      providerParams: {
        supportsMcpServers: false,
      },
    });
    void _client;

    expect(mockState.superConstructorOptions.at(-1)).toMatchObject({
      capabilities: {
        supportsMcpServers: false,
      },
    });
  });

  test("scopes new and resumed Hermes sessions to the agent profile home", async () => {
    const prepared: Array<{
      agentId: string;
      includeRuntimeState?: boolean;
      runtimeSessionId?: string;
    }> = [];
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes", "acp"],
      providerId: "hermes",
      hermesProfileManager: {
        async prepare(
          agentId: string,
          options?: { includeRuntimeState?: boolean; runtimeSessionId?: string },
        ) {
          prepared.push({ agentId, ...options });
          return { profile: "paseo-isolated", home: "/profiles/paseo-isolated" };
        },
      },
    });

    await client.createSession(
      { provider: "hermes", cwd: "/workspace" },
      { agentId: "agent-1", env: { PASEO_AGENT_ID: "agent-1" } },
    );
    await client.resumeSession(
      { provider: "hermes", sessionId: "session-1", nativeHandle: "session-1" },
      undefined,
      { agentId: "agent-1", env: { PASEO_AGENT_ID: "agent-1" } },
    );

    expect(prepared).toEqual([
      { agentId: "agent-1", includeRuntimeState: false },
      { agentId: "agent-1", includeRuntimeState: true, runtimeSessionId: "session-1" },
    ]);
    expect(mockState.createSessionCalls.at(-1)).toMatchObject({
      launchContext: {
        agentId: "agent-1",
        env: {
          PASEO_AGENT_ID: "agent-1",
          HERMES_HOME: "/profiles/paseo-isolated",
          HERMES_PROFILE: "paseo-isolated",
        },
      },
    });
    expect(mockState.resumeSessionCalls.at(-1)).toMatchObject({
      launchContext: {
        agentId: "agent-1",
        env: {
          PASEO_AGENT_ID: "agent-1",
          HERMES_HOME: "/profiles/paseo-isolated",
          HERMES_PROFILE: "paseo-isolated",
        },
      },
    });
  });

  test("deletes the dedicated Hermes profile with the logical agent", async () => {
    const deleted: string[] = [];
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes", "acp"],
      providerId: "hermes",
      hermesProfileManager: {
        async prepare() {
          return { profile: "paseo-isolated", home: "/profiles/paseo-isolated" };
        },
        async delete(agentId: string) {
          deleted.push(agentId);
        },
      },
    });

    await client.deleteAgentResources("agent-1");

    expect(deleted).toEqual(["agent-1"]);
  });

  test("fails closed when a Hermes session has no Paseo agent ID", async () => {
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes", "acp"],
      providerId: "hermes",
      hermesProfileManager: {
        async prepare() {
          throw new Error("must not prepare without an agent ID");
        },
      },
    });

    await expect(client.createSession({ provider: "hermes", cwd: "/workspace" })).rejects.toThrow(
      "requires a Paseo agent ID",
    );
  });

  test("keeps provider catalog probes out of the default Hermes profile", async () => {
    const prepared: string[] = [];
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes", "acp"],
      providerId: "hermes",
      hermesProfileManager: {
        async prepare(agentId: string) {
          prepared.push(agentId);
          return { profile: "paseo-probe", home: "/profiles/paseo-probe" };
        },
      },
    });

    await client.fetchCatalog({ scope: "global", force: true });
    await client.listFeatures({ provider: "hermes", cwd: "/workspace" });
    await client.listImportableSessions({ cwd: "/workspace" });

    expect(prepared).toEqual(["__paseo_provider_probe__"]);
    expect(mockState.fetchCatalogCalls.at(-1)).toMatchObject({
      env: {
        HERMES_HOME: "/profiles/paseo-probe",
        HERMES_PROFILE: "paseo-probe",
      },
    });
    expect(mockState.listFeaturesCalls.at(-1)).toMatchObject({
      env: {
        HERMES_HOME: "/profiles/paseo-probe",
        HERMES_PROFILE: "paseo-probe",
      },
    });
    expect(mockState.listImportableSessionsCalls.at(-1)).toMatchObject({
      env: {
        HERMES_HOME: "/profiles/paseo-probe",
        HERMES_PROFILE: "paseo-probe",
      },
    });
  });
});
