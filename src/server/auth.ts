import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type BinaryLike
} from "node:crypto";
import { promisify } from "node:util";
import { ObjectId, type Collection } from "mongodb";
import type { AuthStateDto } from "../shared/types";
import type { AuthConfig } from "./config";
import type { AccountDoc } from "./models";

const scryptAsync = promisify(scrypt) as (password: BinaryLike, salt: BinaryLike, keylen: number) => Promise<Buffer>;
const passwordHashPrefix = "scrypt";

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
}

export interface LoginResult {
  state: AuthStateDto;
  cookie?: string;
}

export interface AuthService {
  enabled: boolean;
  state(cookieHeader: string | undefined): Promise<AuthStateDto>;
  login(username: string, password: string): Promise<LoginResult | undefined>;
  logout(): LoginResult;
}

export async function ensureBootstrapAccount(config: AuthConfig, accounts: Collection<AccountDoc>): Promise<void> {
  if (!config.enabled) {
    return;
  }

  const passwordHash = config.passwordHash ?? (config.password ? await hashPassword(config.password) : undefined);
  if (passwordHash) {
    const now = new Date();
    await accounts.updateOne(
      { username: config.username },
      {
        $set: {
          passwordHash,
          role: "admin",
          status: "active",
          passwordUpdatedAt: now,
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true }
    );
    return;
  }

  const activeAccountCount = await accounts.countDocuments({ status: "active" });
  if (activeAccountCount === 0) {
    throw new Error("Auth is enabled but no active account exists and no bootstrap password was configured.");
  }
}

export function createAuthService(config: AuthConfig, accounts: Collection<AccountDoc>): AuthService {
  if (!config.enabled) {
    return {
      enabled: false,
      state: async () => ({ enabled: false, authenticated: true }),
      login: async () => ({ state: { enabled: false, authenticated: true } }),
      logout: () => ({ state: { enabled: false, authenticated: true } })
    };
  }

  const sessionSecret = config.sessionSecret ?? config.passwordHash ?? config.password;
  if (!sessionSecret) {
    throw new Error("Auth is enabled but no session signing secret is available.");
  }

  const state = async (cookieHeader: string | undefined): Promise<AuthStateDto> => {
    const payload = verifySession(cookieHeader, config.cookieName, sessionSecret);
    if (!payload) {
      return { enabled: true, authenticated: false };
    }

    if (!ObjectId.isValid(payload.sub)) {
      return { enabled: true, authenticated: false };
    }
    const account = await accounts.findOne({
      _id: new ObjectId(payload.sub),
      status: "active"
    });
    if (!account) {
      return { enabled: true, authenticated: false };
    }

    return {
      enabled: true,
      authenticated: true,
      user: {
        id: account._id.toHexString(),
        name: account.username
      },
      expiresAt: new Date(payload.exp).toISOString()
    };
  };

  return {
    enabled: true,
    state,
    async login(username: string, password: string) {
      const account = await accounts.findOne({
        username,
        status: "active"
      });
      if (!account) {
        return undefined;
      }

      const ok = await verifyScryptHash(password, account.passwordHash);
      if (!ok) {
        return undefined;
      }

      const now = Date.now();
      const expiresAt = now + config.sessionTtlMs;
      const token = signSession(
        {
          sub: account._id.toHexString(),
          iat: now,
          exp: expiresAt,
          nonce: randomBytes(16).toString("base64url")
        },
        sessionSecret
      );

      await accounts.updateOne(
        { _id: account._id },
        {
          $set: {
            lastLoginAt: new Date(now),
            updatedAt: new Date(now)
          }
        }
      );

      return {
        state: {
          enabled: true,
          authenticated: true,
          user: {
            id: account._id.toHexString(),
            name: account.username
          },
          expiresAt: new Date(expiresAt).toISOString()
        },
        cookie: serializeCookie(config.cookieName, token, {
          httpOnly: true,
          maxAge: Math.floor(config.sessionTtlMs / 1000),
          path: "/",
          sameSite: "Lax",
          secure: config.cookieSecure
        })
      };
    },
    logout() {
      return {
        state: { enabled: true, authenticated: false },
        cookie: serializeCookie(config.cookieName, "", {
          expires: new Date(0),
          httpOnly: true,
          maxAge: 0,
          path: "/",
          sameSite: "Lax",
          secure: config.cookieSecure
        })
      };
    }
  };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const key = await scryptAsync(password, salt, 64);
  return `${passwordHashPrefix}$${salt}$${key.toString("base64url")}`;
}

async function verifyScryptHash(password: string, passwordHash: string): Promise<boolean> {
  const [prefix, salt, expectedKey] = passwordHash.split("$");
  if (prefix !== passwordHashPrefix || !salt || !expectedKey) {
    return false;
  }

  const expected = Buffer.from(expectedKey, "base64url");
  if (expected.length === 0) {
    return false;
  }

  const actual = await scryptAsync(password, salt, expected.length);
  return safeBufferEqual(actual, expected);
}

function signSession(payload: SessionPayload, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifySession(cookieHeader: string | undefined, cookieName: string, secret: string): SessionPayload | undefined {
  const token = parseCookies(cookieHeader)[cookieName];
  if (!token) {
    return undefined;
  }

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return undefined;
  }

  const expectedSignature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  if (!safeTextEqual(signature, expectedSignature)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number" || payload.exp <= Date.now()) {
      return undefined;
    }
    if (typeof payload.iat !== "number" || typeof payload.nonce !== "string") {
      return undefined;
    }
    return payload as SessionPayload;
  } catch {
    return undefined;
  }
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  const cookies: Record<string, string> = {};
  for (const item of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = item.trim().split("=");
    if (!rawName || rawValue.length === 0) {
      continue;
    }
    cookies[rawName] = rawValue.join("=");
  }
  return cookies;
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    expires?: Date;
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
  }
): string {
  const segments = [`${name}=${value}`];
  if (options.maxAge !== undefined) {
    segments.push(`Max-Age=${options.maxAge}`);
  }
  if (options.expires) {
    segments.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.path) {
    segments.push(`Path=${options.path}`);
  }
  if (options.httpOnly) {
    segments.push("HttpOnly");
  }
  if (options.secure) {
    segments.push("Secure");
  }
  if (options.sameSite) {
    segments.push(`SameSite=${options.sameSite}`);
  }
  return segments.join("; ");
}

function safeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function safeBufferEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
