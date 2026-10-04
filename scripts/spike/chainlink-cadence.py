"""Measures real update gaps of Chainlink push feeds on Monad mainnet (last N rounds). Read-only."""
import subprocess, sys
RPC = "https://rpc.monad.xyz"
FEEDS = {"BTC/USD": "0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546",
         "ETH/USD": "0x1B1414782B859871781bA3E4B0979b9ca57A0A04",
         "MON/USD": "0xBcD78f76005B7515837af6b50c7C52BCf73822fb"}
N = int(sys.argv[1]) if len(sys.argv) > 1 else 40
def call(f, sig, *a):
    return subprocess.run(["cast", "call", f, sig, *a, "--rpc-url", RPC], capture_output=True, text=True).stdout.split("\n")
for name, f in FEEDS.items():
    rid = int(call(f, "latestRoundData()(uint80,int256,uint256,uint256,uint80)")[0].split()[0])
    ts = []
    for i in range(N):
        o = call(f, "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)", str(rid - i))
        try: ts.append(int(o[3].split()[0]))
        except (IndexError, ValueError): break
    gaps = sorted(ts[i] - ts[i + 1] for i in range(len(ts) - 1))
    over900 = sum(g > 900 for g in gaps)
    print(f"{name} rounds={len(ts)} span={ts[0]-ts[-1]}s min={gaps[0]}s median={gaps[len(gaps)//2]}s max={gaps[-1]}s gaps>900s={over900}")
    print(f"  gaps(sorted)={gaps}")
