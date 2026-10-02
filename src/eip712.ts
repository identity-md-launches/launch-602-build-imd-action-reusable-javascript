// Minimal EIP-712 typed-data hashing for the two messages this action signs.
// Supports struct, string, bytes32, address and uintN fields, which is all
// Permit2's PermitWitnessTransferFrom and IMD's QuoteApproval use.
import { hexToBytes, isAddress, keccak256 } from './hex.js';

export type TypedField = { name: string; type: string };
export type TypedTypes = Record<string, TypedField[]>;
export type TypedValue = string | bigint | number | { [key: string]: TypedValue };
export type TypedMessage = { [key: string]: TypedValue };

export interface Domain {
  name?: string;
  version?: string;
  chainId?: number | bigint;
  verifyingContract?: string;
}

export interface TypedData {
  domain: Domain;
  types: TypedTypes;
  primaryType: string;
  message: TypedMessage;
}

const DOMAIN_FIELDS: TypedField[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

function dependencies(primary: string, types: TypedTypes, found: Set<string> = new Set()): Set<string> {
  if (found.has(primary) || !types[primary]) return found;
  found.add(primary);
  for (const field of types[primary]) dependencies(field.type, types, found);
  return found;
}

export function encodeType(primary: string, types: TypedTypes): string {
  const deps = [...dependencies(primary, types)].filter((t) => t !== primary).sort();
  return [primary, ...deps]
    .map((t) => `${t}(${types[t]!.map((f) => `${f.type} ${f.name}`).join(',')})`)
    .join('');
}

export function typeHash(primary: string, types: TypedTypes): Uint8Array {
  return keccak256(encodeType(primary, types));
}

function word(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw new Error('uint256 out of range');
  return hexToBytes(value.toString(16).padStart(64, '0'));
}

function encodeField(type: string, value: TypedValue | undefined, types: TypedTypes): Uint8Array {
  if (value === undefined) throw new Error(`missing value for ${type}`);
  if (types[type]) return hashStruct(type, value as TypedMessage, types);
  if (type === 'string') {
    if (typeof value !== 'string') throw new Error('expected string');
    return keccak256(value);
  }
  if (type === 'bytes32') {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('expected bytes32 hex');
    return hexToBytes(value);
  }
  if (type === 'address') {
    if (!isAddress(value)) throw new Error('expected address');
    return word(BigInt(value));
  }
  if (/^uint(8|16|32|64|128|256)$/.test(type)) {
    if (typeof value === 'object') throw new Error('expected integer');
    if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('expected decimal integer');
    return word(BigInt(value));
  }
  throw new Error(`unsupported EIP-712 type ${type}`);
}

export function hashStruct(primary: string, message: TypedMessage, types: TypedTypes): Uint8Array {
  const fields = types[primary];
  if (!fields) throw new Error(`unknown type ${primary}`);
  const parts = [typeHash(primary, types), ...fields.map((f) => encodeField(f.type, message[f.name], types))];
  return keccak256(Buffer.concat(parts));
}

export function domainSeparator(domain: Domain): Uint8Array {
  const fields = DOMAIN_FIELDS.filter((f) => domain[f.name as keyof Domain] !== undefined);
  return hashStruct('EIP712Domain', domain as TypedMessage, { EIP712Domain: fields });
}

/** The 32-byte digest a wallet signs for `eth_signTypedData_v4`. */
export function typedDataDigest(data: TypedData): Uint8Array {
  return keccak256(
    Buffer.concat([
      Uint8Array.of(0x19, 0x01),
      domainSeparator(data.domain),
      hashStruct(data.primaryType, data.message, data.types),
    ]),
  );
}
