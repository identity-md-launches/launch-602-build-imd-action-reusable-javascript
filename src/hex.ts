import { keccak_256 } from '@noble/hashes/sha3';

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const HEX32_RE = /^[0-9a-f]{64}$/;
export const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error('invalid hex string');
  return new Uint8Array(Buffer.from(clean, 'hex'));
}

export function keccak256(data: Uint8Array | string): Uint8Array {
  return keccak_256(typeof data === 'string' ? new TextEncoder().encode(data) : data);
}

export function isAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_RE.test(value);
}

/** EIP-55 mixed-case checksum encoding. */
export function toChecksumAddress(address: string): string {
  if (!isAddress(address)) throw new Error('invalid address');
  const lower = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak256(lower));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i] as string, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i];
  }
  return out;
}

/** Full 20-byte comparison; look-alike (poisoned) addresses never match. */
export function sameAddress(a: unknown, b: unknown): boolean {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}
