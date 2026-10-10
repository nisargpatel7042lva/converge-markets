import Link from "next/link";
import { LiveTicker } from "@/components/live-ticker";
import { StartButton } from "@/components/start-button";
import { Logo } from "@/components/shell";
import { Mascot } from "@/components/delight";

const STEPS = [
  [
    "1",
    "Pick a round",
    "Every 15 minutes a new round opens on ETH. Will it finish above where it started?",
  ],
  [
    "2",
    "Choose Up or Down",
    "Pick an amount and confirm with Face ID. About two seconds later you're in.",
  ],
  [
    "3",
    "Collect",
    "Right when the round ends? One tap and the winnings are yours. Wrong? You only lose what you bet.",
  ],
] as const;

const PILLARS = [
  [
    "Your account, your keys",
    "A passkey on your device is the account. There is no seed phrase to lose and no extension to install. Export it to MetaMask or Rabby whenever you like.",
  ],
  [
    "A fair price, every second",
    "Bets are priced from the market price one moment after you place them, so nobody trades against a number they could already see move.",
  ],
  [
    "Settled by Chainlink",
    "Every round ends with a price report that the contracts verify. Nobody in the middle decides who won.",
  ],
  [
    "Liquidity from people like you",
    "Anyone can add money to the shared vault that takes the other side, and earn from the spread. It can lose money too.",
  ],
] as const;

const BUILT_WITH = ["Monad", "Mera passkeys", "Chainlink", "Kuru order book", "Envio indexer"];

export default function Landing() {
  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip">
      <header className="mx-auto flex w-full max-w-md items-center justify-between px-5 pt-6 md:max-w-6xl md:px-8 md:pt-7">
        <Logo className="text-lg md:text-xl" />
        <nav aria-label="Site" className="flex items-center gap-1 text-sm font-medium text-muted">
          <a href="#how" className="hidden rounded-full px-4 py-2 hover:text-text md:inline-block">
            How it works
          </a>
          <Link
            href="/markets"
            className="hidden rounded-full px-4 py-2 hover:text-text md:inline-block"
          >
            Markets
          </Link>
          <Link
            href="/vault"
            className="hidden rounded-full px-4 py-2 hover:text-text md:inline-block"
          >
            Earn
          </Link>
          <Link href="/stats" className="rounded-full px-4 py-2 hover:text-text">
            Live stats
          </Link>
          <Link
            href="/markets"
            className="ml-1 hidden rounded-full bg-raised px-5 py-2.5 font-semibold text-text hover:bg-line md:inline-block"
          >
            Launch app
          </Link>
        </nav>
      </header>

      <main
        id="main"
        className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pb-10 md:max-w-6xl md:px-8"
      >
        <section className="relative grid gap-10 pt-9 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] md:items-center md:gap-14 md:pt-20 md:pb-8">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-10 -top-6 h-52 w-52 rounded-full bg-brand/15 blur-3xl md:h-96 md:w-96"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -left-16 top-24 h-44 w-44 rounded-full bg-up/10 blur-3xl md:h-80 md:w-80"
          />
          <div className="relative">
            <Mascot mood="happy" size={72} />
            <h1 className="font-display mt-5 text-[2.5rem] font-semibold leading-[1.06] md:text-[4.1rem]">
              Call the next 15 minutes.
              <br />
              <span className="text-up">Up</span> or <span className="text-down">Down</span>.
            </h1>
            <p className="mt-5 max-w-[34rem] text-base leading-relaxed text-muted md:text-lg">
              Pick a side on the price of a crypto asset. If you are right when the round ends, you
              collect. No seed phrase, no browser extension, no sign-up form.
            </p>
            <div className="mt-7 max-w-sm">
              <StartButton />
              <p className="mt-3 text-center text-xs text-faint">
                Takes about 10 seconds. Your account lives in your passkey.
              </p>
            </div>
          </div>

          <section
            aria-labelledby="live"
            className="relative rounded-[28px] border border-line/80 bg-surface/70 p-5 backdrop-blur md:p-6"
          >
            <h2 id="live" className="mb-3 flex items-center gap-2 text-sm font-bold text-muted">
              <span className="live-dot" aria-hidden /> Live right now
            </h2>
            <LiveTicker />
            <p className="mt-4 text-xs leading-relaxed text-faint">
              Rounds run all day. Open one to see the live price, the odds and the chart.
            </p>
          </section>
        </section>

        <section id="how" className="mt-14 scroll-mt-8 md:mt-24">
          <h2 className="font-display text-2xl font-semibold md:text-4xl">How it works</h2>
          <ol className="mt-5 grid gap-3 md:mt-8 md:grid-cols-3 md:gap-5">
            {STEPS.map(([n, t, b]) => (
              <li
                key={n}
                className="flex gap-3.5 rounded-[24px] border border-line bg-surface p-4 md:flex-col md:gap-4 md:p-6"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-soft text-sm font-extrabold text-brand md:h-10 md:w-10 md:text-base">
                  {n}
                </span>
                <div>
                  <h3 className="text-base font-bold md:text-lg">{t}</h3>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted md:mt-1.5 md:text-base">
                    {b}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-12 md:mt-20">
          <h2 className="font-display text-2xl font-semibold md:text-4xl">
            Calm by design, careful underneath
          </h2>
          <div className="mt-5 grid gap-3 md:mt-8 md:grid-cols-2 md:gap-5">
            {PILLARS.map(([t, b]) => (
              <div key={t} className="rounded-[24px] border border-line bg-surface p-4 md:p-6">
                <h3 className="text-base font-bold md:text-lg">{t}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted md:mt-2 md:text-base">{b}</p>
              </div>
            ))}
          </div>
        </section>

        <section aria-label="Built with" className="mt-12 md:mt-20">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Built with</p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {BUILT_WITH.map((b) => (
              <li
                key={b}
                className="rounded-full bg-raised px-4 py-2 text-sm font-medium text-muted"
              >
                {b}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-faint">
            Running on Monad testnet with test money. Nothing here is real money yet.
          </p>
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-md flex-wrap gap-x-5 gap-y-2 px-5 pb-10 text-xs text-faint md:max-w-6xl md:px-8">
        <Link href="/legal/terms">Terms</Link>
        <Link href="/legal/risk">Risk disclosure</Link>
        <Link href="/legal/privacy">Privacy</Link>
        <span className="w-full">
          Trading involves risk of loss. Not available in every country.
        </span>
      </footer>
    </div>
  );
}
