import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createDecipheriv, createHash, constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getVrcDataFile } from "./appPaths.js";

const requestPrivateKeyFile = getVrcDataFile("crypto/request-private-key.pem");
const requestPublicKeyFile = getVrcDataFile("crypto/request-public-key.jwk");
const encryptedPayloadMaxSkewMs = 5 * 60_000;
const nonceRetentionMs = 10 * 60_000;
const usedNonces = new Map<string, number>();

interface RequestCryptoRouteOptions {
  requireEncryptedSensitivePayloads: boolean;
}

interface RequestCryptoKeyPair {
  privateKeyPem: string;
  publicKeyJwk: JsonWebKey;
  keyId: string;
  fingerprint: string;
}

interface EncryptedRequestEnvelope {
  encrypted: true;
  keyId: string;
  alg: "RSA-OAEP-256+A256GCM";
  iv: string;
  encryptedKey: string;
  ciphertext: string;
  tag: string;
  aad: {
    method: string;
    path: string;
    ts: number;
    nonce: string;
  };
}

export function registerRequestCrypto(server: FastifyInstance, options: RequestCryptoRouteOptions): void {
  const keyPair = getRequestCryptoKeyPair();

  server.get("/api/crypto/public-key", async () => ({
    keyId: keyPair.keyId,
    fingerprint: keyPair.fingerprint,
    alg: "RSA-OAEP-256+A256GCM",
    publicKey: keyPair.publicKeyJwk,
  }));

  server.addHook("preValidation", async (request, reply) => {
    const body = request.body;
    if (!isPlainObject(body)) return;
    if (isEncryptedEnvelope(body)) {
      try {
        request.body = decryptRequestEnvelope(body, keyPair, request);
      } catch (error) {
        return reply.status(400).send({
          message: error instanceof Error ? error.message : "请求解密失败",
        });
      }
      return;
    }
    if (options.requireEncryptedSensitivePayloads && containsSensitiveField(body)) {
      return reply.status(400).send({
        message: "共享 Web 模式禁止明文提交账号密码，请刷新页面后重试。",
      });
    }
  });
}

export function containsSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsSensitiveField(item));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, item]) => {
    if (isSensitiveKey(key)) return true;
    return containsSensitiveField(item);
  });
}

function getRequestCryptoKeyPair(): RequestCryptoKeyPair {
  if (!existsSync(requestPrivateKeyFile) || !existsSync(requestPublicKeyFile)) {
    generateAndStoreRequestCryptoKeyPair();
  }
  const privateKeyPem = readFileSync(requestPrivateKeyFile, "utf8");
  const publicKeyJwk = JSON.parse(readFileSync(requestPublicKeyFile, "utf8")) as JsonWebKey;
  const publicKeyJson = stableJson(publicKeyJwk);
  const fingerprint = createHash("sha256").update(publicKeyJson).digest("base64url");
  return {
    privateKeyPem,
    publicKeyJwk,
    fingerprint,
    keyId: `vrc-${fingerprint.slice(0, 16)}`,
  };
}

function generateAndStoreRequestCryptoKeyPair(): void {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicExponent: 0x10001,
  });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  publicKeyJwk.key_ops = ["encrypt"];
  publicKeyJwk.alg = "RSA-OAEP-256";
  publicKeyJwk.ext = true;
  mkdirSync(dirname(requestPrivateKeyFile), { recursive: true, mode: 0o700 });
  writeFileSync(requestPrivateKeyFile, privateKeyPem, { mode: 0o600 });
  writeFileSync(requestPublicKeyFile, `${JSON.stringify(publicKeyJwk, null, 2)}\n`, { mode: 0o644 });
}

function decryptRequestEnvelope(envelope: EncryptedRequestEnvelope, keyPair: RequestCryptoKeyPair, request: FastifyRequest): unknown {
  validateEnvelope(envelope, keyPair, request);
  const dataKey = privateDecrypt(
    {
      key: keyPair.privateKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    fromBase64Url(envelope.encryptedKey),
  );
  const decipher = createDecipheriv("aes-256-gcm", dataKey, fromBase64Url(envelope.iv));
  decipher.setAAD(Buffer.from(stableJson(envelope.aad), "utf8"));
  decipher.setAuthTag(fromBase64Url(envelope.tag));
  const plainText = Buffer.concat([decipher.update(fromBase64Url(envelope.ciphertext)), decipher.final()]).toString("utf8");
  return JSON.parse(plainText) as unknown;
}

function validateEnvelope(envelope: EncryptedRequestEnvelope, keyPair: RequestCryptoKeyPair, request: FastifyRequest): void {
  if (envelope.keyId !== keyPair.keyId) throw new Error("请求加密公钥已过期，请刷新页面后重试。");
  if (envelope.alg !== "RSA-OAEP-256+A256GCM") throw new Error("请求加密算法不受支持。");
  if (!envelope.aad || typeof envelope.aad !== "object") throw new Error("请求加密元数据缺失。");
  if (envelope.aad.method.toUpperCase() !== request.method.toUpperCase()) throw new Error("请求加密方法不匹配。");
  if (envelope.aad.path !== requestPathname(request)) throw new Error("请求加密路径不匹配。");
  if (!Number.isFinite(envelope.aad.ts) || Math.abs(Date.now() - envelope.aad.ts) > encryptedPayloadMaxSkewMs) {
    throw new Error("请求加密时间已过期，请刷新后重试。");
  }
  if (!envelope.aad.nonce || typeof envelope.aad.nonce !== "string") throw new Error("请求加密随机数缺失。");
  pruneUsedNonces();
  const nonceKey = `${envelope.keyId}:${envelope.aad.nonce}`;
  if (usedNonces.has(nonceKey)) throw new Error("请求加密随机数已使用，请重新提交。");
  usedNonces.set(nonceKey, Date.now());
}

function requestPathname(request: FastifyRequest): string {
  return new URL(request.url, "http://vrc.local").pathname;
}

function pruneUsedNonces(): void {
  const expiresBefore = Date.now() - nonceRetentionMs;
  for (const [nonce, createdAt] of usedNonces) {
    if (createdAt < expiresBefore) usedNonces.delete(nonce);
  }
}

function isEncryptedEnvelope(value: unknown): value is EncryptedRequestEnvelope {
  if (!isPlainObject(value)) return false;
  return (
    value.encrypted === true &&
    value.alg === "RSA-OAEP-256+A256GCM" &&
    typeof value.keyId === "string" &&
    typeof value.iv === "string" &&
    typeof value.encryptedKey === "string" &&
    typeof value.ciphertext === "string" &&
    typeof value.tag === "string" &&
    isPlainObject(value.aad)
  );
}

function isSensitiveKey(key: string): boolean {
  return ["password", "rootpassword", "token", "secret", "privatekey"].includes(key.toLowerCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
