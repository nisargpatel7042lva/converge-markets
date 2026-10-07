/**
 * What this device placed: orders (to find a bet that has not been filled yet and to refund it),
 * the markets traded (to list winnings from rounds older than the live window), and the vault
 * epochs with a request (to find old claims). Kept in local storage, per account; the chain and
 * the indexer remain the source of truth, this only remembers where to look.
 */
export type OrderRecord = { id: string; market: string; side: "UP" | "DOWN"; at: number };
type Store = { orders: OrderRecord[]; markets: string[]; epochs: string[] };

const key = (address: string) => `converge.activity.v1.${address.toLowerCase()}`;
const EMPTY: Store = { orders: [], markets: [], epochs: [] };

function load(address: string): Store {
  try {
    const raw = localStorage.getItem(key(address));
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Store>) } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

function save(address: string, s: Store) {
  try {
    localStorage.setItem(key(address), JSON.stringify(s));
  } catch {
    // private mode: the lists are rebuilt from the chain and the indexer on the next visit
  }
}

export const ordersOf = (address: string) => load(address).orders;
export const marketsOf = (address: string) => load(address).markets;
export const epochsOf = (address: string) => load(address).epochs.map((e) => BigInt(e));

export function recordOrder(address: string, o: OrderRecord) {
  const s = load(address);
  s.orders = [o, ...s.orders.filter((x) => x.id !== o.id)].slice(0, 50);
  if (!s.markets.includes(o.market.toLowerCase()))
    s.markets = [o.market.toLowerCase(), ...s.markets].slice(0, 100);
  save(address, s);
}

export function forgetOrder(address: string, id: string) {
  const s = load(address);
  s.orders = s.orders.filter((x) => x.id !== id);
  save(address, s);
}

export function recordEpoch(address: string, epoch: bigint) {
  const s = load(address);
  if (!s.epochs.includes(epoch.toString())) s.epochs = [epoch.toString(), ...s.epochs].slice(0, 50);
  save(address, s);
}
