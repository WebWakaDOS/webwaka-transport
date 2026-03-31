/**
 * WebWaka Web Push — VAPID-based push notification delivery
 *
 * Implements the Web Push Protocol (RFC 8030) using VAPID (RFC 8292).
 * Cloudflare Workers environment: uses SubtleCrypto for all crypto ops.
 *
 * VAPID keys are generated once:
 *   npx web-push generate-vapid-keys
 * VAPID_PRIVATE_KEY → wrangler secret put VAPID_PRIVATE_KEY
 * VAPID_PUBLIC_KEY  → VITE_VAPID_PUBLIC_KEY (public, safe to commit)
 *
 * Usage:
 *   await sendPush(subscription, {
 *     title: 'Booking Confirmed',
 *     body: 'Your trip departs at 08:00',
 *     url: '/bookings/bk_abc123',
 *   });
 *
 * Non-fatal: if VAPID keys are absent or push fails, the error is logged
 * and the caller continues. Push is best-effort.
 */

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  icon?: string;
  badge?: string;
  tag?: string;
}

export interface VapidEnv {
  VAPID_PRIVATE_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
}

// ============================================================
// TS 5.x strict Uint8Array generics helper
// `getRandomValues` and `base64UrlDecode` return `Uint8Array<ArrayBufferLike>`,
// but SubtleCrypto expects `Uint8Array<ArrayBuffer>` (non-shared).
// `buf()` copies into a guaranteed-ArrayBuffer view.
// ============================================================
function buf(src: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(src) as Uint8Array<ArrayBuffer>;
}

// ============================================================
// Core: send a push notification to a single subscription
// ============================================================

export async function sendPush(
  subscription: PushSubscription,
  payload: PushPayload,
  env: VapidEnv
): Promise<void> {
  if (!env.VAPID_PRIVATE_KEY) {
    console.warn('[push] VAPID_PRIVATE_KEY not configured — push notification skipped');
    return;
  }

  const vapidPublicKey = env.VAPID_PUBLIC_KEY ?? '';
  const body = JSON.stringify(payload);

  // Build VAPID JWT
  const vapidJwt = await buildVapidJwt(
    subscription.endpoint,
    env.VAPID_PRIVATE_KEY,
    vapidPublicKey
  );

  // Encrypt the payload using Web Push encryption (ECDH + AES-GCM)
  const encrypted = await encryptPayload(body, subscription);

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${vapidJwt.jwt},k=${vapidPublicKey}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
    },
    body: encrypted,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => `HTTP ${response.status}`);
    throw new Error(`Push delivery failed (${response.status}): ${text}`);
  }
}

// ============================================================
// VAPID JWT builder (RFC 8292)
// ============================================================

async function buildVapidJwt(
  endpoint: string,
  privateKeyB64: string,
  publicKeyB64: string
): Promise<{ jwt: string }> {
  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);

  const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
  const claims = base64UrlEncode(JSON.stringify({
    aud: audience,
    exp: now + 43200, // 12 hours
    sub: 'mailto:noreply@webwaka.ng',
  }));

  const sigInput = `${header}.${claims}`;

  // Import ECDSA private key
  const privateKeyBytes = buf(base64UrlDecode(privateKeyB64));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );

  const jwt = `${sigInput}.${base64UrlEncode(signature)}`;
  return { jwt };
}

// ============================================================
// Web Push Encryption (RFC 8291 — aes128gcm)
// ============================================================

async function encryptPayload(
  plaintext: string,
  subscription: PushSubscription
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);

  // Decode subscription keys
  const clientPublicKeyBytes = base64UrlDecode(subscription.keys.p256dh);
  const authBytes = base64UrlDecode(subscription.keys.auth);

  // Generate ephemeral ECDH key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );

  // Import client public key
  const clientPublicKey = await crypto.subtle.importKey(
    'raw',
    buf(clientPublicKeyBytes),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // Derive shared ECDH secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPublicKey },
    serverKeyPair.privateKey,
    256
  );

  // Export server public key (uncompressed)
  const serverPublicKeyBytes = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);

  // Generate salt
  const salt = buf(crypto.getRandomValues(new Uint8Array(16)));

  // HKDF to derive content encryption key and nonce
  const { cek, nonce } = await deriveEncryptionKeys(
    buf(new Uint8Array(sharedBits)),
    salt,
    buf(authBytes),
    buf(new Uint8Array(serverPublicKeyBytes)),
    buf(clientPublicKeyBytes)
  );

  // Encrypt with AES-128-GCM
  const cekKey = await crypto.subtle.importKey('raw', buf(cek), { name: 'AES-GCM' }, false, ['encrypt']);
  const paddedPlaintext = new Uint8Array([...plaintextBytes, 2]); // delimiter byte

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(nonce), additionalData: new Uint8Array(0) as Uint8Array<ArrayBuffer> },
    cekKey,
    paddedPlaintext
  );

  // Build aes128gcm content-coding header + ciphertext
  const serverPubBytes = new Uint8Array(serverPublicKeyBytes);
  const header = new Uint8Array(21 + serverPubBytes.length);
  header.set(salt, 0);                              // 16 bytes salt
  new DataView(header.buffer).setUint32(16, 4096, false); // 4 bytes: record size
  header[20] = serverPubBytes.length;               // 1 byte: key length
  header.set(serverPubBytes, 21);                   // key bytes

  const encrypted = new Uint8Array(header.length + ciphertext.byteLength);
  encrypted.set(header);
  encrypted.set(new Uint8Array(ciphertext), header.length);

  return encrypted.buffer;
}

async function deriveEncryptionKeys(
  ikm: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  auth: Uint8Array<ArrayBuffer>,
  serverPublic: Uint8Array<ArrayBuffer>,
  clientPublic: Uint8Array<ArrayBuffer>
): Promise<{ cek: Uint8Array<ArrayBuffer>; nonce: Uint8Array<ArrayBuffer> }> {
  const encoder = new TextEncoder();

  // PRK = HKDF-Extract(auth, IKM)
  const ikmKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const prk = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: auth, info: encoder.encode('Content-Encoding: auth\0') },
    ikmKey, 256
  );

  const prkKey = await crypto.subtle.importKey('raw', prk, { name: 'HKDF' }, false, ['deriveBits']);

  // context = label || 0x00 || client_pub || server_pub
  const keyInfo = buildInfo('aesgcm', clientPublic, serverPublic);
  const nonceInfo = buildInfo('nonce', clientPublic, serverPublic);

  const cekBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: keyInfo }, prkKey, 128
  );
  const nonceBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo }, prkKey, 96
  );

  return { cek: new Uint8Array(cekBits), nonce: new Uint8Array(nonceBits) };
}

function buildInfo(type: string, clientKey: Uint8Array<ArrayBuffer>, serverKey: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const label = encoder.encode(`Content-Encoding: ${type}\0`);
  const context = new Uint8Array(1 + 2 + clientKey.length + 2 + serverKey.length);
  let offset = 0;
  context[offset++] = 0; // curve: P-256
  new DataView(context.buffer).setUint16(offset, clientKey.length, false); offset += 2;
  context.set(clientKey, offset); offset += clientKey.length;
  new DataView(context.buffer).setUint16(offset, serverKey.length, false); offset += 2;
  context.set(serverKey, offset);

  const result = new Uint8Array(label.length + context.length);
  result.set(label);
  result.set(context, label.length);
  return result;
}

// ============================================================
// Base64url helpers
// ============================================================

function base64UrlEncode(input: string | ArrayBuffer): string {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlDecode(input: string): Uint8Array {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
