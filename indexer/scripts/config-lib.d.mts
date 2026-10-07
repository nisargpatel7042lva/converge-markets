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
  pollingMs?: number;
  maxBlockRange?: number;
  rollbackOnReorg?: boolean;
}): string;
export function renderDefaults(
  entries: {
    chainId: number;
    keeper: string | undefined;
    tvlCap: string | number | undefined;
    systemAddresses?: string[];
  }[],
  header: string,
): string;
