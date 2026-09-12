import { PROOF_BUILDER_URL, SOURCE_CHAIN_KEY } from '../config';

// Plain fetch() against the proof builder's REST API, verified directly against the live
// endpoint (see spikes/FINDINGS.md, Phase 10) rather than bundling @gluwa/usc-sdk into the
// browser — the SDK is published for Node and its RPC-heavy TS classes aren't a good fit
// for a client bundle, but the underlying HTTP API is simple, CORS-enabled, and stable.

export interface MerkleProofEntry {
  hash: string;
  isLeft: boolean;
}

export interface MerkleProof {
  root: string;
  siblings: MerkleProofEntry[];
}

export interface ContinuityProof {
  lowerEndpointDigest: string;
  roots: string[];
}

export interface ProofByTx {
  chainKey: number;
  headerNumber: number;
  txIndex: number;
  txHash: string;
  txBytes: string;
  continuityProof: ContinuityProof;
  merkleProof: MerkleProof;
  cached: boolean;
  generatedAt: string;
}

export async function getAttestedHeight(): Promise<number> {
  const res = await fetch(`${PROOF_BUILDER_URL}/api/v1/attested-height/${SOURCE_CHAIN_KEY}`);
  if (!res.ok) throw new Error(`attested-height request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { attestedHeight: number };
  return body.attestedHeight;
}

export async function isHeightAttested(height: number): Promise<boolean> {
  return (await getAttestedHeight()) >= height;
}

export async function getProofForTx(txHash: string): Promise<ProofByTx> {
  const res = await fetch(`${PROOF_BUILDER_URL}/api/v1/proof-by-tx/${SOURCE_CHAIN_KEY}/${txHash}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`proof-by-tx request failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as ProofByTx;
}
