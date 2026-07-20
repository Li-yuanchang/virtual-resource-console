import forge from "node-forge";

interface RequestCryptoPublicKeyResponse {
  keyId: string;
  fingerprint: string;
  alg: "RSA-OAEP-256+A256GCM";
  publicKey: JsonWebKey;
}

interface SecureRequestEnvelope {
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

const trustedFingerprintPrefix = "vrc.crypto.trustedFingerprint.";
let publicKeyCache: Promise<RequestCryptoPublicKeyResponse> | null = null;

export async function secureJsonRequest<T>(url: string, payload: unknown, method = "POST", options: Pick<RequestInit, "signal"> = {}): Promise<T> {
  const normalizedMethod = method.toUpperCase();
  const init: RequestInit = { method: normalizedMethod, ...options };
  if (payload !== undefined) {
    const bodyPayload = containsSensitiveField(payload) ? await encryptPayload(url, normalizedMethod, payload) : payload;
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(bodyPayload);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(result.message || `请求失败：HTTP ${response.status}`);
  }
  return result as T;
}

export function containsSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsSensitiveField(item));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, item]) => {
    if (isSensitiveKey(key)) return true;
    return containsSensitiveField(item);
  });
}

async function encryptPayload(url: string, method: string, payload: unknown): Promise<SecureRequestEnvelope> {
  const cryptoKey = await getTrustedPublicKey();
  const rawAesKey = createRandomBytes(32);
  const iv = createRandomBytes(12);
  const aad = {
    method,
    path: new URL(url, window.location.origin).pathname,
    ts: Date.now(),
    nonce: createNonce(),
  };
  const aadText = stableJson(aad);
  // 内网共享 Web 支持纯 HTTP 访问，Chrome 在非安全上下文不会暴露 WebCrypto subtle。
  const encryptedPayload = canUseWebCrypto()
    ? await encryptWithWebCrypto(cryptoKey.publicKey, rawAesKey, iv, aadText, payload)
    : encryptWithForge(cryptoKey.publicKey, rawAesKey, iv, aadText, payload);
  return {
    encrypted: true,
    keyId: cryptoKey.keyId,
    alg: "RSA-OAEP-256+A256GCM",
    iv: bytesToBase64Url(iv),
    encryptedKey: bytesToBase64Url(encryptedPayload.encryptedKey),
    ciphertext: bytesToBase64Url(encryptedPayload.ciphertext),
    tag: bytesToBase64Url(encryptedPayload.tag),
    aad,
  };
}

async function getTrustedPublicKey(): Promise<RequestCryptoPublicKeyResponse> {
  const keyInfo = await getRequestCryptoPublicKey();
  const trustKey = `${trustedFingerprintPrefix}${window.location.origin}`;
  const trusted = window.localStorage.getItem(trustKey);
  if (!trusted) {
    window.localStorage.setItem(trustKey, keyInfo.fingerprint);
    return keyInfo;
  }
  if (trusted !== keyInfo.fingerprint) {
    throw new Error("VRC API 加密公钥指纹已变化。请确认服务器是否重装或迁移后，在设置页重新信任。");
  }
  return keyInfo;
}

async function getRequestCryptoPublicKey(): Promise<RequestCryptoPublicKeyResponse> {
  if (!publicKeyCache) {
    publicKeyCache = fetch("/api/crypto/public-key", { cache: "no-store" }).then(async (response) => {
      const result = (await response.json()) as RequestCryptoPublicKeyResponse & { message?: string };
      if (!response.ok) throw new Error(result.message || "读取 VRC API 加密公钥失败");
      return result;
    });
  }
  return publicKeyCache;
}

async function encryptWithWebCrypto(
  publicKey: JsonWebKey,
  rawAesKey: Uint8Array,
  iv: Uint8Array,
  aadText: string,
  payload: unknown,
): Promise<{ encryptedKey: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }> {
  const aesKey = await crypto.subtle.importKey("raw", toArrayBuffer(rawAesKey), { name: "AES-GCM" }, false, ["encrypt"]);
  const encryptedBytes = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: new TextEncoder().encode(aadText), tagLength: 128 },
      aesKey,
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  );
  const encryptedKey = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      await importPublicKey(publicKey),
      toArrayBuffer(rawAesKey),
    ),
  );
  const tagStart = encryptedBytes.length - 16;
  return {
    encryptedKey,
    ciphertext: encryptedBytes.slice(0, tagStart),
    tag: encryptedBytes.slice(tagStart),
  };
}

function encryptWithForge(
  publicKey: JsonWebKey,
  rawAesKey: Uint8Array,
  iv: Uint8Array,
  aadText: string,
  payload: unknown,
): { encryptedKey: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array } {
  const cipher = forge.cipher.createCipher("AES-GCM", bytesToBinary(rawAesKey));
  cipher.start({
    iv: bytesToBinary(iv),
    additionalData: aadText,
    tagLength: 128,
  });
  cipher.update(forge.util.createBuffer(JSON.stringify(payload), "utf8"));
  if (!cipher.finish()) throw new Error("请求加密失败，请刷新页面后重试。");
  const rsaPublicKey = forge.pki.setRsaPublicKey(
    new forge.jsbn.BigInteger(base64UrlToHex(String(publicKey.n)), 16),
    new forge.jsbn.BigInteger(base64UrlToHex(String(publicKey.e)), 16),
  );
  const encryptedKey = rsaPublicKey.encrypt(bytesToBinary(rawAesKey), "RSA-OAEP", {
    md: forge.md.sha256.create(),
    mgf1: {
      md: forge.md.sha256.create(),
    },
  });
  return {
    encryptedKey: binaryToBytes(encryptedKey),
    ciphertext: binaryToBytes(cipher.output.getBytes()),
    tag: binaryToBytes(cipher.mode.tag.getBytes()),
  };
}

function importPublicKey(publicKey: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    publicKey,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
}

function isSensitiveKey(key: string): boolean {
  return ["password", "rootpassword", "token", "secret", "privatekey"].includes(key.toLowerCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createNonce(): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return bytesToBase64Url(createRandomBytes(16));
}

function canUseWebCrypto(): boolean {
  return typeof crypto !== "undefined" && Boolean(crypto.subtle?.importKey) && Boolean(crypto.subtle?.encrypt);
}

function createRandomBytes(length: number): Uint8Array {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    return crypto.getRandomValues(new Uint8Array(length));
  }
  return binaryToBytes(forge.random.getBytesSync(length));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return binary;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64UrlToHex(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return forge.util.bytesToHex(binary);
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
