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

export default function Landing() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-10 pt-6">
      <header className="flex items-center justify-between">
        <Logo className="text-lg" />
        <Link
          href="/stats"
          className="text-sm font-medium text-muted underline-offset-4 hover:underline"
        >
          Live stats
        </Link>
      </header>

      <main id="main" className="flex flex-1 flex-col">
        <section className="relative pt-9">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-10 -top-6 h-52 w-52 rounded-full bg-brand/20 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -left-16 top-24 h-44 w-44 rounded-full bg-up/10 blur-3xl"
          />
          <div className="relative">
            <Mascot mood="happy" size={72} />
            <h1 className="mt-4 text-[2.3rem] font-extrabold leading-[1.08] tracking-tight">
              Call the next 15 minutes.
              <br />
              <span className="text-up">Up</span> or <span className="text-down">Down</span>.
            </h1>
            <p className="mt-4 text-base leading-relaxed text-muted">
              Pick a side on the price of a crypto asset. If you are right when the round ends, you
              collect. No seed phrase, no browser extension, no sign-up form.
            </p>
            <div className="mt-6">
              <StartButton />
              <p className="mt-3 text-center text-xs text-faint">
                Takes about 10 seconds. Your account lives in your passkey.
              </p>
            </div>
          </div>
        </section>

        <section aria-labelledby="live" className="mt-10">
          <h2 id="live" className="mb-3 flex items-center gap-2 text-sm font-bold text-muted">
            <span className="live-dot" aria-hidden /> Live right now
          </h2>
          <LiveTicker />
        </section>

        <section className="mt-10">
          <h2 className="mb-3 text-sm font-bold text-muted">How it works</h2>
          <ol className="grid gap-3">
            {STEPS.map(([n, t, b]) => (
              <li key={n} className="flex gap-3.5 rounded-[22px] border border-line bg-surface p-4">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-soft text-sm font-extrabold text-brand">
                  {n}
                </span>
                <div>
                  <h3 className="text-base font-bold">{t}</h3>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted">{b}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-6 grid gap-3">
          {[
            [
              "Your account, your keys",
              "A passkey on your device is the account. You can export it to MetaMask or Rabby whenever you like.",
            ],
            [
              "Liquidity from people like you",
              "Anyone can add money to the shared vault that takes the other side, and earn from the spread. It can lose money too.",
            ],
          ].map(([t, b]) => (
            <div key={t} className="rounded-[22px] border border-line bg-surface p-4">
              <h3 className="text-base font-bold">{t}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted">{b}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="mt-10 flex flex-wrap gap-x-5 gap-y-2 text-xs text-faint">
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
