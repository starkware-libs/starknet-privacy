/**
 * Tests for hash function compatibility between TypeScript and Cairo implementations.
 *
 * These tests validate that the TypeScript hash functions produce the same results
 * as the Cairo implementation to ensure cross-language compatibility.
 */

import { describe, it, expect } from "vitest";
import {
  compute_channel_key,
  compute_channel_marker,
  compute_subchannel_key,
  compute_subchannel_marker,
  compute_note_id,
  compute_nullifier,
  compute_enc_amount_hash,
  compute_enc_token_hash,
  compute_enc_private_key_hash,
  compute_enc_channel_key_hash,
  compute_enc_sender_addr_hash,
  compute_enc_recipient_addr_hash,
  compute_outgoing_channel_key,
} from "../../src/utils/hashes.js";
import referenceHashes from "../fixtures/cairo-reference-data.json" with { type: "json" };

describe("Hash Compatibility with Cairo", () => {
  const { inputs, outputs } = referenceHashes;

  // Parse inputs
  const sender = BigInt(inputs.sender);
  const recipient = BigInt(inputs.recipient);
  const senderPrivateKey = BigInt(inputs.senderPrivateKey);
  const recipientPublicKey = BigInt(inputs.recipientPublicKey);
  const channelKey = BigInt(inputs.channelKey);
  const token = BigInt(inputs.token);
  const index = inputs.index;
  const salt = BigInt(inputs.salt);
  const sharedX = BigInt(inputs.sharedX);

  it("compute_channel_key matches Cairo", () => {
    const result = compute_channel_key(sender, senderPrivateKey, recipient, recipientPublicKey);
    expect(result.toString(16)).toBe(BigInt(outputs.channelKey).toString(16));
  });

  it("compute_channel_marker matches Cairo", () => {
    const result = compute_channel_marker(channelKey, sender, recipient, recipientPublicKey);
    expect(result.toString(16)).toBe(BigInt(outputs.channelMarker).toString(16));
  });

  it("compute_subchannel_key matches Cairo", () => {
    const result = compute_subchannel_key(channelKey, index);
    expect(result.toString(16)).toBe(BigInt(outputs.subchannelKey).toString(16));
  });

  it("compute_subchannel_marker matches Cairo", () => {
    const result = compute_subchannel_marker(channelKey, recipient, recipientPublicKey, token);
    expect(result.toString(16)).toBe(BigInt(outputs.subchannelMarker).toString(16));
  });

  it("compute_note_id matches Cairo", () => {
    const result = compute_note_id(channelKey, token, index);
    expect(result.toString(16)).toBe(BigInt(outputs.noteId).toString(16));
  });

  it("compute_nullifier matches Cairo", () => {
    const result = compute_nullifier(channelKey, token, index, senderPrivateKey);
    expect(result.toString(16)).toBe(BigInt(outputs.nullifier).toString(16));
  });

  it("compute_enc_amount_hash matches Cairo", () => {
    const result = compute_enc_amount_hash(channelKey, token, index, salt);
    expect(result.toString(16)).toBe(BigInt(outputs.encAmountHash).toString(16));
  });

  it("compute_enc_token_hash matches Cairo", () => {
    const result = compute_enc_token_hash(channelKey, index, salt);
    expect(result.toString(16)).toBe(BigInt(outputs.encTokenHash).toString(16));
  });

  it("compute_enc_private_key_hash matches Cairo", () => {
    const result = compute_enc_private_key_hash(sharedX);
    expect(result.toString(16)).toBe(BigInt(outputs.encPrivateKeyHash).toString(16));
  });

  it("compute_enc_channel_key_hash matches Cairo", () => {
    const result = compute_enc_channel_key_hash(sharedX);
    expect(result.toString(16)).toBe(BigInt(outputs.encChannelKeyHash).toString(16));
  });

  it("compute_enc_sender_addr_hash matches Cairo", () => {
    const result = compute_enc_sender_addr_hash(sharedX);
    expect(result.toString(16)).toBe(BigInt(outputs.encSenderAddrHash).toString(16));
  });

  it("compute_enc_recipient_addr_hash matches Cairo", () => {
    const result = compute_enc_recipient_addr_hash(sender, senderPrivateKey, index, salt);
    expect(result.toString(16)).toBe(BigInt(outputs.encRecipientAddrHash).toString(16));
  });

  it("compute_outgoing_channel_key matches Cairo", () => {
    const result = compute_outgoing_channel_key(sender, senderPrivateKey, index);
    expect(result.toString(16)).toBe(BigInt(outputs.outgoingChannelKey).toString(16));
  });
});
