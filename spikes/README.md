# Phase 1 spikes

## 1. Chain info (no wallet needed)

```sh
npm install
npm run spike:chain-info
```

Queries the ChainInfo precompile on public CC3 testnet RPC. Answers the
go/no-go question: is Base or Base Sepolia a supported source chain.

## 2. Full attestation round-trip (needs a funded wallet)

```sh
cp .env.example .env
```

Fill in:
- `SOURCE_CHAIN_RPC_URL` — a Sepolia RPC URL (e.g. `https://sepolia.infura.io/v3/<key>`, free Infura account)
- `CREDITCOIN_WALLET_PRIVATE_KEY` — a fresh throwaway EVM key (`cast wallet new`). Same address is used on both chains.

Fund that address:
- Sepolia ETH: https://cloud.google.com/application/web3/faucet/ethereum/sepolia
- CC3 testnet CTC: Creditcoin Discord, `#token-faucet` channel, `/faucet address: <your address>`

Then:

```sh
npm run spike:full
```

This sends one `mint()` call on a pre-deployed Sepolia test ERC20, waits for
Creditcoin to attest the containing block, generates a proof, verifies it
on-chain against the block prover precompile in the same transaction, times
every stage, and decodes the proven payload to show exactly which fields are
covered (sender/target, success/revert status, log emitter, topics).

Paste the script's timing summary and the field dump into `FINDINGS.md`.
