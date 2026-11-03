// Crypto building blocks, computed for real with Web Crypto: HMAC key import, an anti-replay
// window, an emulated HSM that derives one key per epoch, and Ed25519 signatures for the
// satellite-to-station handshake. The HSM is emulated in software, as the brief allows.
// The frame seal and hash chain themselves live in trustAnchor.ts.

const encoder = new TextEncoder();

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function importMacKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** Ed25519 identity of the spacecraft, used to sign handshake challenges. */
export interface Ed25519Identity {
  publicHex: string;
  sign(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
  verify(data: Uint8Array<ArrayBuffer>, signature: Uint8Array): Promise<boolean>;
}

/** Real Ed25519 keys from Web Crypto, or null where the browser does not support them. */
export async function createEd25519(): Promise<Ed25519Identity | null> {
  try {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return {
      publicHex: toHex(raw),
      sign: async (data) =>
        new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, data)),
      verify: (data, signature) =>
        crypto.subtle.verify({ name: 'Ed25519' }, pair.publicKey, new Uint8Array(signature), data),
    };
  } catch {
    return null;
  }
}

export const encodeText = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);

/** Anti-replay: reject sequence numbers already seen or older than the window. */
export class ReplayWindow {
  private high = -1;
  private seen = new Set<number>();
  readonly size: number;

  constructor(size = 64) {
    this.size = size;
  }

  accept(seq: number): boolean {
    if (seq <= this.high - this.size || this.seen.has(seq)) return false;
    this.seen.add(seq);
    if (seq > this.high) {
      this.high = seq;
      for (const x of this.seen) if (x <= this.high - this.size) this.seen.delete(x);
    }
    return true;
  }
}

/**
 * Emulated HSM: derives one HMAC key per key epoch from a master secret that never leaves
 * this object. Spacecraft and station share it; an attacker does not.
 */
export class EmulatedHsm {
  private cache = new Map<number, Promise<CryptoKey>>();
  private readonly master: CryptoKey;

  private constructor(master: CryptoKey) {
    this.master = master;
  }

  static async create(masterSecret?: Uint8Array<ArrayBuffer>): Promise<EmulatedHsm> {
    const secret = masterSecret ?? crypto.getRandomValues(new Uint8Array(32));
    return new EmulatedHsm(await importMacKey(secret));
  }

  epochKey(epoch: number): Promise<CryptoKey> {
    let key = this.cache.get(epoch);
    if (!key) {
      key = (async () => {
        const derived = await crypto.subtle.sign(
          'HMAC',
          this.master,
          encoder.encode(`key-epoch:${epoch}`),
        );
        return importMacKey(new Uint8Array(derived));
      })();
      this.cache.set(epoch, key);
    }
    return key;
  }
}
