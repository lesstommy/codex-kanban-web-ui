import { createHash, randomBytes, scrypt, timingSafeEqual, type BinaryLike } from "node:crypto";
import { promisify } from "node:util";
import { ObjectId, type Collection } from "mongodb";
import type { ServiceAuthConfig } from "./config";
import type { ServiceAccountDoc } from "./models";

const scryptAsync = promisify(scrypt) as (password: BinaryLike, salt: BinaryLike, keylen: number) => Promise<Buffer>;
const hashPrefix = "scrypt";

export interface ServicePrincipal {
  kind: "service";
  id: string;
  name: string;
  scopes: string[];
}

export interface ServiceAuthService {
  authenticate(authorizationHeader: string | undefined): Promise<ServicePrincipal | undefined>;
}

export async function ensureBootstrapServiceAccount(
  config: ServiceAuthConfig,
  serviceAccounts: Collection<ServiceAccountDoc>
): Promise<void> {
  if (!config.bootstrapToken) {
    return;
  }

  const now = new Date();
  await serviceAccounts.updateOne(
    { name: config.bootstrapName },
    {
      $set: {
        tokenFingerprint: fingerprintToken(config.bootstrapToken),
        tokenHash: await hashSecret(config.bootstrapToken),
        scopes: ["threads:read", "threads:write", "threads:start", "tasks:heartbeat", "settings:read"],
        status: "active",
        tokenUpdatedAt: now,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true }
  );
}

export function createServiceAuthService(serviceAccounts: Collection<ServiceAccountDoc>): ServiceAuthService {
  return {
    async authenticate(authorizationHeader: string | undefined) {
      const token = readBearerToken(authorizationHeader);
      if (!token) {
        return undefined;
      }

      const account = await serviceAccounts.findOne({
        tokenFingerprint: fingerprintToken(token),
        status: "active"
      });
      if (!account) {
        return undefined;
      }

      const ok = await verifySecretHash(token, account.tokenHash);
      if (!ok) {
        return undefined;
      }

      const now = new Date();
      await serviceAccounts.updateOne(
        { _id: account._id },
        {
          $set: {
            lastUsedAt: now,
            updatedAt: now
          }
        }
      );

      return {
        kind: "service",
        id: account._id.toHexString(),
        name: account.name,
        scopes: account.scopes
      };
    }
  };
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const key = await scryptAsync(secret, salt, 64);
  return `${hashPrefix}$${salt}$${key.toString("base64url")}`;
}

async function verifySecretHash(secret: string, passwordHash: string): Promise<boolean> {
  const [prefix, salt, expectedKey] = passwordHash.split("$");
  if (prefix !== hashPrefix || !salt || !expectedKey) {
    return false;
  }

  const expected = Buffer.from(expectedKey, "base64url");
  if (expected.length === 0) {
    return false;
  }

  const actual = await scryptAsync(secret, salt, expected.length);
  return safeBufferEqual(actual, expected);
}

function readBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  const [scheme, token] = authorizationHeader.trim().split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return undefined;
  }
  return token;
}

function fingerprintToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeBufferEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function serviceAccountObjectId(id: string): ObjectId {
  return new ObjectId(id);
}
