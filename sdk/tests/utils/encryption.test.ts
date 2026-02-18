/**
 * Tests for encryption/decryption compatibility between TypeScript and Cairo implementations.
 *
 * These tests validate that the TypeScript encryption functions produce the same results
 * as the Cairo implementation to ensure cross-language compatibility.
 */

import { describe, it, expect } from "vitest";
import { encryptions } from "../../src/utils/encryptions.js";
import { Channel, Witness, channelSerde, witnessSerde } from "../../src/internal/channel.js";
import referenceHashes from "../fixtures/cairo-reference-data.json" with { type: "json" };

describe("Encryption Compatibility with Cairo", () => {
  const { inputs, outputs } = referenceHashes;

  // Parse inputs
  const channelKey = BigInt(inputs.channelKey);
  const token = BigInt(inputs.token);
  const index = inputs.index;
  const salt = BigInt(inputs.salt);
  const sender = BigInt(inputs.sender);
  const amount = BigInt(inputs.amount);
  const recipientPrivateKey = BigInt(inputs.recipientPrivateKey);
  const recipientPublicKeyDerived = BigInt(inputs.recipientPublicKeyDerived);
  const ephemeralSecret = BigInt(inputs.ephemeralSecret);
  const senderPrivateKey = BigInt(inputs.senderPrivateKey);
  const recipient = BigInt(inputs.recipient);
  const auditorPrivateKey = BigInt(inputs.auditorPrivateKey);
  const auditorPublicKey = BigInt(inputs.auditorPublicKey);
  const userAddr = BigInt(inputs.userAddr);
  const userPrivateKey = BigInt(inputs.userPrivateKey);

  describe("Public Key Derivation", () => {
    it("derivePublicKey matches Cairo", () => {
      const result = encryptions.derivePublicKey(recipientPrivateKey);
      expect(result.toString(16)).toBe(recipientPublicKeyDerived.toString(16));
    });
  });

  describe("Subchannel Encryption", () => {
    it("encryptSubchannelInfo salt matches Cairo", () => {
      const result = encryptions.encryptSubchannelInfo(channelKey, index, token, salt);
      expect(result.salt.toString(16)).toBe(BigInt(outputs.encSubchannelSalt).toString(16));
    });

    it("encryptSubchannelInfo enc_token matches Cairo", () => {
      const result = encryptions.encryptSubchannelInfo(channelKey, index, token, salt);
      expect(result.enc_token.toString(16)).toBe(BigInt(outputs.encSubchannelToken).toString(16));
    });

    it("decryptSubchannelInfo recovers original token", () => {
      const encrypted = {
        salt,
        enc_token: BigInt(outputs.encSubchannelToken),
      };
      const decrypted = encryptions.decryptSubchannelInfo(encrypted, channelKey, index);
      expect(decrypted.token.toString(16)).toBe(token.toString(16));
      expect(decrypted.salt).toBe(salt);
    });

    it("encrypt then decrypt recovers original token", () => {
      const encrypted = encryptions.encryptSubchannelInfo(channelKey, index, token, salt);
      const decrypted = encryptions.decryptSubchannelInfo(encrypted, channelKey, index);
      expect(decrypted.token.toString(16)).toBe(token.toString(16));
      expect(decrypted.salt).toBe(salt);
    });
  });

  describe("Note Amount Encryption", () => {
    it("encryptNoteAmount matches Cairo", () => {
      const result = encryptions.encryptNoteAmount(channelKey, token, index, salt, amount);
      expect(result.toString(16)).toBe(BigInt(outputs.encNoteAmount).toString(16));
    });

    it("decryptNoteAmount matches Cairo", () => {
      const encNoteValue = BigInt(outputs.encNoteAmount);
      const result = encryptions.decryptNoteAmount(encNoteValue, channelKey, token, index);
      expect(Number(result.amount)).toBe(outputs.decNoteAmount);
      expect(result.salt).toBe(salt);
    });

    it("encrypt then decrypt recovers original amount", () => {
      const encrypted = encryptions.encryptNoteAmount(channelKey, token, index, salt, amount);
      const decrypted = encryptions.decryptNoteAmount(encrypted, channelKey, token, index);
      expect(decrypted.amount).toBe(amount);
      expect(decrypted.salt).toBe(salt);
    });
  });

  describe("Channel Info Encryption (ECDH)", () => {
    it("ephemeral pubkey matches Cairo", () => {
      const result = encryptions.encryptChannelInfo(
        ephemeralSecret,
        recipientPublicKeyDerived,
        channelKey,
        sender
      );
      expect(result.ephemeral_pubkey.toString(16)).toBe(
        BigInt(outputs.encChannelEphemeralPubkey).toString(16)
      );
    });

    it("encrypted channel key matches Cairo", () => {
      const result = encryptions.encryptChannelInfo(
        ephemeralSecret,
        recipientPublicKeyDerived,
        channelKey,
        sender
      );
      expect(result.enc_channel_key.toString(16)).toBe(BigInt(outputs.encChannelKey).toString(16));
    });

    it("encrypted sender addr matches Cairo", () => {
      const result = encryptions.encryptChannelInfo(
        ephemeralSecret,
        recipientPublicKeyDerived,
        channelKey,
        sender
      );
      expect(result.enc_sender_addr.toString(16)).toBe(
        BigInt(outputs.encChannelSenderAddr).toString(16)
      );
    });

    it("decrypt channel info recovers original values", () => {
      const encrypted = {
        ephemeral_pubkey: BigInt(outputs.encChannelEphemeralPubkey),
        enc_channel_key: BigInt(outputs.encChannelKey),
        enc_sender_addr: BigInt(outputs.encChannelSenderAddr),
      };
      const decrypted = encryptions.decryptChannelInfo(encrypted, recipientPrivateKey);
      expect(decrypted.key.toString(16)).toBe(channelKey.toString(16));
      expect(decrypted.sender.toString(16)).toBe(sender.toString(16));
    });

    it("encrypt then decrypt recovers original channel info", () => {
      const encrypted = encryptions.encryptChannelInfo(
        ephemeralSecret,
        recipientPublicKeyDerived,
        channelKey,
        sender
      );
      const decrypted = encryptions.decryptChannelInfo(encrypted, recipientPrivateKey);
      expect(decrypted.key.toString(16)).toBe(channelKey.toString(16));
      expect(decrypted.sender.toString(16)).toBe(sender.toString(16));
    });
  });

  describe("Outgoing Channel Info Encryption", () => {
    it("encryptOutgoingChannelInfo salt matches Cairo", () => {
      const result = encryptions.encryptOutgoingChannelInfo(
        sender,
        senderPrivateKey,
        index,
        recipient,
        salt
      );
      expect(result.salt.toString(16)).toBe(BigInt(outputs.encOutgoingSalt).toString(16));
    });

    it("encryptOutgoingChannelInfo enc_recipient_addr matches Cairo", () => {
      const result = encryptions.encryptOutgoingChannelInfo(
        sender,
        senderPrivateKey,
        index,
        recipient,
        salt
      );
      expect(result.enc_recipient_addr.toString(16)).toBe(
        BigInt(outputs.encOutgoingRecipientAddr).toString(16)
      );
    });

    it("decryptOutgoingChannelInfo recovers original recipient", () => {
      const encrypted = {
        salt,
        enc_recipient_addr: BigInt(outputs.encOutgoingRecipientAddr),
      };
      const decrypted = encryptions.decryptOutgoingChannelInfo(
        encrypted,
        sender,
        senderPrivateKey,
        index
      );
      expect(decrypted.recipientAddr.toString(16)).toBe(recipient.toString(16));
      expect(decrypted.salt).toBe(salt);
    });

    it("encrypt then decrypt recovers original recipient", () => {
      const encrypted = encryptions.encryptOutgoingChannelInfo(
        sender,
        senderPrivateKey,
        index,
        recipient,
        salt
      );
      const decrypted = encryptions.decryptOutgoingChannelInfo(
        encrypted,
        sender,
        senderPrivateKey,
        index
      );
      expect(decrypted.recipientAddr.toString(16)).toBe(recipient.toString(16));
      expect(decrypted.salt).toBe(salt);
    });
  });

  describe("Private Key Encryption (ECDH)", () => {
    it("ephemeral pubkey matches Cairo", () => {
      const result = encryptions.encryptPrivateKey(
        ephemeralSecret,
        auditorPublicKey,
        userPrivateKey
      );
      expect(result.ephemeralPubkey.toString(16)).toBe(
        BigInt(outputs.encPrivateKeyEphemeralPubkey).toString(16)
      );
    });

    it("encrypted private key matches Cairo", () => {
      const result = encryptions.encryptPrivateKey(
        ephemeralSecret,
        auditorPublicKey,
        userPrivateKey
      );
      expect(result.encPrivateKey.toString(16)).toBe(
        BigInt(outputs.encPrivateKeyValue).toString(16)
      );
    });

    it("decryptPrivateKey recovers original private key", () => {
      const encrypted = {
        ephemeralPubkey: BigInt(outputs.encPrivateKeyEphemeralPubkey),
        encPrivateKey: BigInt(outputs.encPrivateKeyValue),
      };
      const decrypted = encryptions.decryptPrivateKey(encrypted, auditorPrivateKey);
      expect(decrypted.toString(16)).toBe(userPrivateKey.toString(16));
    });

    it("encrypt then decrypt recovers original private key", () => {
      const encrypted = encryptions.encryptPrivateKey(
        ephemeralSecret,
        auditorPublicKey,
        userPrivateKey
      );
      const decrypted = encryptions.decryptPrivateKey(encrypted, auditorPrivateKey);
      expect(decrypted.toString(16)).toBe(userPrivateKey.toString(16));
    });
  });

  describe("User Address Encryption (ECDH)", () => {
    it("ephemeral pubkey matches Cairo", () => {
      const result = encryptions.encryptUserAddr(ephemeralSecret, auditorPublicKey, userAddr);
      expect(result.ephemeralPubkey.toString(16)).toBe(
        BigInt(outputs.encUserAddrEphemeralPubkey).toString(16)
      );
    });

    it("encrypted user addr matches Cairo", () => {
      const result = encryptions.encryptUserAddr(ephemeralSecret, auditorPublicKey, userAddr);
      expect(result.encUserAddr.toString(16)).toBe(BigInt(outputs.encUserAddrValue).toString(16));
    });

    it("decryptUserAddr recovers original user addr", () => {
      const encrypted = {
        ephemeralPubkey: BigInt(outputs.encUserAddrEphemeralPubkey),
        encUserAddr: BigInt(outputs.encUserAddrValue),
      };
      const decrypted = encryptions.decryptUserAddr(encrypted, auditorPrivateKey);
      expect(decrypted.toString(16)).toBe(userAddr.toString(16));
    });

    it("encrypt then decrypt recovers original user addr", () => {
      const encrypted = encryptions.encryptUserAddr(ephemeralSecret, auditorPublicKey, userAddr);
      const decrypted = encryptions.decryptUserAddr(encrypted, auditorPrivateKey);
      expect(decrypted.toString(16)).toBe(userAddr.toString(16));
    });
  });
});

describe("Channel/Witness Serialization", () => {
  describe("channelSerde", () => {
    it("encode then decode recovers original channel", () => {
      const publicKey = 0x123456789abcdefn;
      const key = 0xfedcba987654321n;
      const tokens: [bigint, { tokenIndex: number; noteNonce: number }][] = [
        [0x1n, { tokenIndex: 0, noteNonce: 5 }],
        [0x2n, { tokenIndex: 1, noteNonce: 10 }],
      ];
      const channel = new Channel(publicKey, key, tokens);

      const encoded = channelSerde.encode(channel);
      const decoded = channelSerde.decode(encoded);

      expect(decoded.publicKey).toBe(publicKey);
      expect(decoded.key).toBe(key);
      expect(decoded.tokens.size).toBe(2);
      expect(decoded.tokens.get(0x1n)).toEqual({ tokenIndex: 0, noteNonce: 5 });
      expect(decoded.tokens.get(0x2n)).toEqual({ tokenIndex: 1, noteNonce: 10 });
    });

    it("handles channel without key", () => {
      const publicKey = 0x123n;
      const channel = new Channel(publicKey);

      const encoded = channelSerde.encode(channel);
      const decoded = channelSerde.decode(encoded);

      expect(decoded.publicKey).toBe(publicKey);
      expect(decoded.key).toBeUndefined();
      expect(decoded.tokens.size).toBe(0);
    });
  });

  describe("witnessSerde", () => {
    it("encode then decode recovers original witness", () => {
      const channelKey = 0xabcdef123456n;
      const nonce = 42;
      const r = 0x999888777n;
      const witness = new Witness(channelKey, nonce, r);

      const encoded = witnessSerde.encode(witness);
      const decoded = witnessSerde.decode(encoded);

      expect(decoded.channelKey).toBe(channelKey);
      expect(decoded.nonce).toBe(nonce);
      expect(decoded.r).toBe(r);
    });
  });
});
