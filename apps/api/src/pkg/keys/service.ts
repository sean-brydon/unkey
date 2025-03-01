import type { Cache } from "@/pkg/cache";
import type { Api, Database, Key } from "@/pkg/db";
import type { Metrics } from "@/pkg/metrics";
import type { RateLimiter } from "@/pkg/ratelimit";
import type { UsageLimiter } from "@/pkg/usagelimit";
import { BaseError, Err, FetchError, Ok, type Result, SchemaError } from "@unkey/error";
import { sha256 } from "@unkey/hash";
import type { PermissionQuery, RBAC } from "@unkey/rbac";
import type { Logger } from "@unkey/worker-logging";
import type { Context } from "hono";
import type { Analytics } from "../analytics";

export class DisabledWorkspaceError extends BaseError<{ workspaceId: string }> {
  public readonly retry = false;
  public readonly name = DisabledWorkspaceError.name;
  constructor(workspaceId: string) {
    super({
      message: "workspace is disabled",
      context: {
        workspaceId,
      },
    });
  }
}

type NotFoundResponse = {
  valid: false;
  code: "NOT_FOUND";
  key?: never;
  api?: never;
  ratelimit?: never;
  remaining?: never;
};

type InvalidResponse = {
  valid: false;
  publicMessage?: string;
  code: "FORBIDDEN" | "RATE_LIMITED" | "USAGE_EXCEEDED" | "DISABLED" | "INSUFFICIENT_PERMISSIONS";
  key: Key;
  api: Api;
  ratelimit?: {
    remaining: number;
    limit: number;
    reset: number;
  };
  remaining?: number;
  permissions: string[];
};

type ValidResponse = {
  code?: never;
  valid: true;
  key: Key;
  api: Api;
  ratelimit?: {
    remaining: number;
    limit: number;
    reset: number;
  };
  remaining?: number;
  isRootKey?: boolean;
  /**
   * the workspace of the user, even if this is a root key
   */
  authorizedWorkspaceId: string;
  permissions: string[];
};
type VerifyKeyResult = NotFoundResponse | InvalidResponse | ValidResponse;

export class KeyService {
  private readonly cache: Cache;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly db: { primary: Database; readonly: Database };
  private readonly usageLimiter: UsageLimiter;
  private readonly analytics: Analytics;
  private readonly rateLimiter: RateLimiter;
  private readonly rbac: RBAC;
  private readonly hashCache = new Map<string, string>();

  constructor(opts: {
    cache: Cache;
    logger: Logger;
    metrics: Metrics;
    db: { primary: Database; readonly: Database };
    rateLimiter: RateLimiter;
    usageLimiter: UsageLimiter;
    analytics: Analytics;
    rbac: RBAC;
  }) {
    this.cache = opts.cache;
    this.logger = opts.logger;
    this.db = opts.db;
    this.metrics = opts.metrics;
    this.rateLimiter = opts.rateLimiter;
    this.usageLimiter = opts.usageLimiter;
    this.analytics = opts.analytics;
    this.rbac = opts.rbac;
  }

  public async verifyKey(
    c: Context,
    req: {
      key: string;
      apiId?: string;
      permissionQuery?: PermissionQuery;
      ratelimit?: { cost?: number };
    },
  ): Promise<Result<VerifyKeyResult, SchemaError | FetchError | DisabledWorkspaceError>> {
    try {
      const res = await this._verifyKey(c, req);
      if (res.err) {
        this.metrics.emit({
          metric: "metric.key.verification",
          valid: false,
          code: res.err.message,
        });
        return res;
      }
      // if we have identified the key, we can send the analytics event
      // otherwise, they likely sent garbage to us and we can't associate it with anything
      if (res.val.key) {
        c.executionCtx.waitUntil(
          this.analytics.ingestKeyVerification({
            workspaceId: res.val.key.workspaceId,
            apiId: res.val.api.id,
            keyId: res.val.key.id,
            time: Date.now(),
            deniedReason: res.val.code,
            ipAddress: c.req.header("True-Client-IP") ?? c.req.header("CF-Connecting-IP"),
            userAgent: c.req.header("User-Agent"),
            requestedResource: "",
            edgeRegion: "",
            ownerId: res.val.key.ownerId ?? undefined,
            // @ts-expect-error - the cf object will be there on cloudflare
            region: c.req.raw?.cf?.colo ?? "",
            keySpaceId: res.val.key.keyAuthId,
          }),
        );
      }
      this.metrics.emit({
        metric: "metric.key.verification",
        valid: res.val.valid,
        code: res.val.code ?? "OK",
        workspaceId: res.val.key?.workspaceId,
        apiId: res.val.api?.id,
        keyId: res.val.key?.id,
      });

      return res;
    } catch (e) {
      const err = e as Error;
      this.logger.error("Unhandled error while verifying key", {
        error: err.message,
        stack: JSON.stringify(err.stack),
        keyHash: await this.hash(req.key),
        apiId: req.apiId,
      });

      throw e;
    }
  }

  private async hash(key: string): Promise<string> {
    const cached = this.hashCache.get(key);
    if (cached) {
      return cached;
    }
    const hash = await sha256(key);
    this.hashCache.set(key, hash);
    return hash;
  }
  /**
   * extracting this into a separate function just makes it easier to emit the analytics event
   */
  private async _verifyKey(
    c: Context,
    req: {
      key: string;
      apiId?: string;
      permissionQuery?: PermissionQuery;
      ratelimit?: { cost?: number };
    },
  ): Promise<Result<VerifyKeyResult, FetchError | SchemaError | DisabledWorkspaceError>> {
    const keyHash = await this.hash(req.key);
    const { val: data, err } = await this.cache.keyByHash.swr(keyHash, async (hash) => {
      const dbStart = performance.now();
      const dbRes = await this.db.readonly.query.keys.findFirst({
        where: (table, { and, eq, isNull }) => and(eq(table.hash, hash), isNull(table.deletedAt)),
        with: {
          encrypted: true,
          workspace: {
            columns: {
              id: true,
              enabled: true,
            },
          },
          forWorkspace: {
            columns: {
              id: true,
              enabled: true,
            },
          },
          roles: {
            with: {
              role: {
                with: {
                  permissions: {
                    with: {
                      permission: true,
                    },
                  },
                },
              },
            },
          },
          permissions: {
            with: {
              permission: true,
            },
          },
          keyAuth: {
            with: {
              api: true,
            },
          },
        },
      });
      this.metrics.emit({
        metric: "metric.db.read",
        query: "getKeyAndApiByHash",
        latency: performance.now() - dbStart,
      });
      if (!dbRes) {
        return null;
      }
      if (!dbRes.keyAuth.api) {
        this.logger.error("database did not return api for key", dbRes);
      }

      /**
       * Createa a unique set of all permissions, whether they're attached directly or connected
       * through a role.
       */
      const permissions = new Set<string>([
        ...dbRes.permissions.map((p) => p.permission.name),
        ...dbRes.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.name)),
      ]);
      return {
        workspace: dbRes.workspace,
        forWorkspace: dbRes.forWorkspace,
        key: dbRes,
        api: dbRes.keyAuth.api,
        permissions: Array.from(permissions.values()),
        roles: dbRes.roles.map((r) => r.role.name),
      };
    });

    if (err) {
      this.logger.error(err.message);
      return Err(
        new FetchError({
          message: "unable to fetch required data",
          retry: true,
          cause: err,
        }),
      );
    }

    if (!data) {
      return Ok({ valid: false, code: "NOT_FOUND" });
    }

    if ((data.forWorkspace && !data.forWorkspace.enabled) || !data.workspace.enabled) {
      return Err(new DisabledWorkspaceError(data.workspace.id));
    }

    /**
     * Enabled
     */
    if (!data.key.enabled) {
      return Ok({
        key: data.key,
        api: data.api,
        valid: false,
        code: "DISABLED",
        permissions: data.permissions,
      });
    }

    if (req.apiId && data.api.id !== req.apiId) {
      return Ok({
        key: data.key,
        api: data.api,
        valid: false,
        code: "FORBIDDEN",
        permissions: data.permissions,
      });
    }

    /**
     * Expiration
     *
     * There is an issue with our zone cache, that returns dates as strings, so we need to handle that
     */
    const expires = data.key.expires ? new Date(data.key.expires).getTime() : undefined;
    if (expires) {
      if (expires < Date.now()) {
        return Ok({ valid: false, code: "NOT_FOUND" });
      }
    }

    if (data.api.ipWhitelist) {
      const ip = c.req.header("True-Client-IP") ?? c.req.header("CF-Connecting-IP");
      if (!ip) {
        return Ok({
          key: data.key,
          api: data.api,
          valid: false,
          code: "FORBIDDEN",
          permissions: data.permissions,
        });
      }
      const ipWhitelist = JSON.parse(data.api.ipWhitelist) as string[];
      if (!ipWhitelist.includes(ip)) {
        return Ok({
          key: data.key,
          api: data.api,
          valid: false,
          code: "FORBIDDEN",
          permissions: data.permissions,
        });
      }
    }

    if (req.permissionQuery) {
      const q = this.rbac.validateQuery(req.permissionQuery);
      if (q.err) {
        return Err(
          new SchemaError({
            message: "permission query is invalid",
            cause: q.err,
            context: {
              raw: req.permissionQuery,
            },
          }),
        );
      }
      const rbacResp = this.rbac.evaluatePermissions(q.val.query, data.permissions);

      if (rbacResp.err) {
        this.logger.error("evaluating permissions failed", {
          query: JSON.stringify(req.permissionQuery),
          permissions: JSON.stringify(data.permissions),
        });
        return Err(
          new SchemaError({
            message: "permission query is invalid",
            cause: q.err,
            context: {
              raw: req.permissionQuery,
            },
          }),
        );
      }
      if (!rbacResp.val.valid) {
        return Ok({
          key: data.key,
          api: data.api,
          valid: false,
          code: "INSUFFICIENT_PERMISSIONS",
          permissions: data.permissions,
        });
      }
    }

    /**
     * Ratelimiting
     */
    const [pass, ratelimit] = await this.ratelimit(c, data.key, { cost: req.ratelimit?.cost });
    if (!pass) {
      return Ok({
        key: data.key,
        api: data.api,
        valid: false,
        code: "RATE_LIMITED",
        ratelimit,
        permissions: data.permissions,
      });
    }

    let remaining: number | undefined = undefined;
    if (data.key.remaining !== null) {
      const limited = await this.usageLimiter.limit({ keyId: data.key.id });
      remaining = limited.remaining;
      if (!limited.valid) {
        return Ok({
          key: data.key,
          api: data.api,
          valid: false,
          code: "USAGE_EXCEEDED",
          keyId: data.key.id,
          apiId: data.api.id,
          ownerId: data.key.ownerId ?? undefined,
          expires,
          remaining,
          ratelimit,
          isRootKey: !!data.key.forWorkspaceId,
          authorizedWorkspaceId: data.key.forWorkspaceId ?? data.key.workspaceId,
          permissions: data.permissions,
        });
      }
    }

    return Ok({
      workspaceId: data.key.workspaceId,
      key: data.key,
      api: data.api,
      valid: true,
      ownerId: data.key.ownerId ?? undefined,
      expires,
      ratelimit,
      remaining,
      isRootKey: !!data.key.forWorkspaceId,
      authorizedWorkspaceId: data.key.forWorkspaceId ?? data.key.workspaceId,
      permissions: data.permissions,
    });
  }

  /**
   * @returns [pass, ratelimit]
   */
  private async ratelimit(
    c: Context,
    key: Key,
    opts?: { cost?: number },
  ): Promise<[boolean, VerifyKeyResult["ratelimit"]]> {
    if (
      key.ratelimitAsync === null ||
      key.ratelimitLimit === null ||
      key.ratelimitDuration === null
    ) {
      return [true, undefined];
    }
    if (!this.rateLimiter) {
      this.logger.warn("ratelimiting is not enabled, but a key has ratelimiting enabled");
      return [true, undefined];
    }

    const res = await this.rateLimiter.limit(c, {
      workspaceId: key.workspaceId,
      identifier: key.id,
      limit: key.ratelimitLimit,
      interval: key.ratelimitDuration,
      cost: opts?.cost ?? 1,
      // root keys are sharded per edge colo
      shard: key.forWorkspaceId ? "edge" : undefined,
      async: key.ratelimitAsync,
    });

    if (res.err) {
      this.logger.error("ratelimiting failed", {
        error: res.err.message,
        ...res.err,
      });

      return [false, undefined];
    }

    return [
      res.val.pass,
      {
        remaining: key.ratelimitLimit - res.val.current,
        limit: key.ratelimitLimit,
        reset: res.val.reset,
      },
    ];
  }
}
