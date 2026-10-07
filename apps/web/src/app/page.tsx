import Link from "next/link";
import { LiveTicker } from "@/components/live-ticker";
import { StartButton } from "@/components/start-button";
import { Logo } from "@/components/shell";

export default function Landing() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-10 pt-6">
      <header className="flex items-center justify-between">
        <Logo className="text-lg" />
        <Link href="/stats" className="text-sm text-muted underline-offset-4 hover:underline">
          Live stats
        </Link>
      </header>

      <main id="main" className="flex flex-1 flex-col">
        <section className="pt-10">
          <h1 className="text-[2.1rem] font-bold leading-[1.1] tracking-tight">
            Call the next 15 minutes.
            <br />
            <span className="text-up">Up</span> or <span className="text-down">Down</span>.
          </h1>
          <p className="mt-4 text-base leading-relaxed text-muted">
            Pick a side on Bitcoin, Ethereum or Monad. If you are right when the round ends, you
            collect. No seed phrase, no browser extension, no sign-up form.
          </p>
          <div className="mt-6">
            <StartButton />
            <p className="mt-3 text-center text-xs text-faint">
              Takes about 10 seconds. Your account lives in your passkey.
            </p>
          </div>
        </section>

        <section aria-labelledby="live" className="mt-10">
          <h2 id="live" className="mb-3 text-sm font-semibold uppercase tracking-wide text-faint">
            Live right now
          </h2>
          <LiveTicker />
        </section>

        <section className="mt-10 grid gap-3">
          {[
            [
              "Two taps to bet",
              "Choose Up or Down, pick an amount, confirm with Face ID. Your money is back if the price moves before we fill you.",
            ],
            [
              "Your account, your keys",
              "A passkey on your device is the account. You can export it to MetaMask or Rabby whenever you like.",
            ],
            [
              "Liquidity from people like you",
              "Anyone can add money to the shared vault that takes the other side, and earn from the spread. It can lose money too.",
            ],
          ].map(([t, b]) => (
            <div key={t} className="rounded-2xl border border-line bg-surface p-4">
              <h3 className="text-base font-semibold">{t}</h3>
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
