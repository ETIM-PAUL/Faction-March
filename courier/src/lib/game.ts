import { Contract } from 'ethers';

const GAME_STATE_NAMES = ['OPEN', 'ACTIVE', 'SETTLED'];
const SETTLED = 2;

/** FactionMarch only allows one unsettled (OPEN or ACTIVE) game at a time -- createGame()
 * reverts with PreviousGameNotSettled otherwise. Reuse the latest game if it's still live,
 * only creating a new one when there isn't one yet or the latest has SETTLED. */
export async function getOrCreateGame(factionMarch: Contract): Promise<bigint> {
  const gameCount: bigint = await factionMarch.gameCount();
  if (gameCount > 0n) {
    const state = Number(await factionMarch.currentState(gameCount));
    if (state !== SETTLED) {
      console.log(`Reusing existing game ${gameCount} (${GAME_STATE_NAMES[state]}) — only one unsettled game is allowed at a time.`);
      return gameCount;
    }
  }

  console.log('Creating a new FactionMarch game...');
  // CC3's measured block time is a steady 15s/block: 40 blocks (~10 min) to join, 120
  // (~30 min) active -- short enough to exercise a full lifecycle in one CLI session.
  const createTx = await factionMarch.createGame(12, 40, 120);
  const createReceipt = await createTx.wait();
  const createdEvent = createReceipt.logs
    .map((log: any) => {
      try {
        return factionMarch.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed?.name === 'GameCreated');
  if (!createdEvent) throw new Error('GameCreated not found in receipt');
  const gameId = createdEvent.args.gameId as bigint;
  console.log(`Created game ${gameId}`);
  return gameId;
}
