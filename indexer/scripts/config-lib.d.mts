export const CONTRACTS: Record<string, string[]>;
export function render(o: {
  chainId: number;
  header: string;
  factory: string;
  factoryBlock: number;
  vault: string;
  venue: string;
  vaultBlock: number;
  rpc?: string;
}): string;
