import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeType, typedDataDigest, type TypedData } from '../src/eip712.js';
import { bytesToHex, keccak256, toChecksumAddress } from '../src/hex.js';
import { permit2TypedData } from '../src/payment.js';
import { createWallet } from '../src/wallet.js';

// The worked example from the EIP-712 specification.
const mail: TypedData = {
  domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
  primaryType: 'Mail',
  types: {
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};

describe('EIP-712', () => {
  it('matches the specification digest', () => {
    assert.equal(bytesToHex(typedDataDigest(mail)), 'be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
  });

  it('matches the specification signature', () => {
    // The spec's key is keccak256("cow"); it is a public test vector.
    const wallet = createWallet(bytesToHex(keccak256('cow')));
    assert.equal(wallet.address, '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826');
    assert.equal(
      wallet.signTypedData(mail),
      '0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c',
    );
  });

  it('encodes the Permit2 witness type the way x402 does', () => {
    const td = permit2TypedData({
      from: '0x0000000000000000000000000000000000000001',
      permitted: { token: '0x0000000000000000000000000000000000000002', amount: '1' },
      spender: '0x0000000000000000000000000000000000000003',
      nonce: '1',
      deadline: '1',
      witness: { to: '0x0000000000000000000000000000000000000004', validAfter: '0' },
    });
    assert.equal(
      encodeType(td.primaryType, td.types),
      'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)' +
        'TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)',
    );
  });

  it('checksums addresses (EIP-55)', () => {
    assert.equal(toChecksumAddress('0x402085c248eea27d92e8b30b2c58ed07f9e20001'), '0x402085c248EeA27D92E8b30b2C58ed07f9E20001');
    assert.equal(toChecksumAddress('0x000000000022d473030f116ddee9f6b43ac78ba3'), '0x000000000022D473030F116dDEE9F6B43aC78BA3');
  });

  it('rejects malformed keys without echoing them', () => {
    assert.throws(() => createWallet('0x1234'), (e: Error) => !e.message.includes('1234'));
    assert.throws(() => createWallet('00'.repeat(32)), /not a valid secp256k1 key/);
  });
});
