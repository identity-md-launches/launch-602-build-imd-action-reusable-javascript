// The private key lives only inside the closure created here. Nothing returned
// exposes it: callers get the public address and a function that signs typed
// data. It is never logged, serialised, written to disk or sent anywhere.
import { secp256k1 } from '@noble/curves/secp256k1';
import { typedDataDigest, type TypedData } from './eip712.js';
import { bytesToHex, keccak256, toChecksumAddress } from './hex.js';

export interface Wallet {
  readonly address: string;
  signTypedData(data: TypedData): string;
}

export function addressFromPublicKey(uncompressed: Uint8Array): string {
  return toChecksumAddress(`0x${bytesToHex(keccak256(uncompressed.slice(1))).slice(-40)}`);
}

export function createWallet(privateKey: string): Wallet {
  const trimmed = privateKey.trim();
  const hex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  // Do not include the value in the error: it is (almost) the key.
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('private-key must be 32 bytes of hex (64 characters, optional 0x)');
  const key = Uint8Array.from(Buffer.from(hex, 'hex'));
  if (!secp256k1.utils.isValidPrivateKey(key)) throw new Error('private-key is not a valid secp256k1 key');
  const address = addressFromPublicKey(secp256k1.getPublicKey(key, false));

  return Object.freeze({
    address,
    signTypedData(data: TypedData): string {
      const sig = secp256k1.sign(typedDataDigest(data), key, { lowS: true });
      const v = (27 + sig.recovery).toString(16);
      return `0x${sig.r.toString(16).padStart(64, '0')}${sig.s.toString(16).padStart(64, '0')}${v}`;
    },
  });
}
