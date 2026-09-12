import { Contract, type ContractRunner } from 'ethers';
import { ADDRESSES } from '../config';
import OrderBookAbi from '../abis/OrderBook.json';
import FactionMarchAbi from '../abis/FactionMarch.json';
import ProofGateAbi from '../abis/ProofGate.json';
import WarChestAbi from '../abis/WarChest.json';

export function orderBookContract(runner: ContractRunner) {
  return new Contract(ADDRESSES.orderBook, OrderBookAbi, runner);
}

export function factionMarchContract(runner: ContractRunner) {
  return new Contract(ADDRESSES.factionMarch, FactionMarchAbi, runner);
}

export function proofGateContract(runner: ContractRunner) {
  return new Contract(ADDRESSES.proofGate, ProofGateAbi, runner);
}

export function warChestContract(runner: ContractRunner) {
  return new Contract(ADDRESSES.warChest, WarChestAbi, runner);
}
