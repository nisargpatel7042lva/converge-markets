import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/shell";

const DOCS: Record<string, { title: string; updated: string; sections: [string, string][] }> = {
  terms: {
    title: "Terms of use",
    updated: "7 October 2026",
    sections: [
      [
        "What this is",
        "Converge is software that lets you place Up/Down bets on short-term price rounds and add money to a shared vault that takes the other side. It runs on public smart contracts. We do not hold your money or your keys.",
      ],
      [
        "Who can use it",
        "You must be of legal age where you live and allowed to use prediction or derivative products there. The app is not offered in some countries and blocks access from them. Using a VPN to get around a block is not allowed.",
      ],
      [
        "Your account",
        "Your account is a passkey on your device. We cannot recover, reset or freeze it. If you lose every device that holds the passkey and have not exported it, the account and its money are gone. Keep your recovery phrase private; whoever has it controls the account.",
      ],
      [
        "Risk and no advice",
        "Bets and vault deposits can lose all the money put in. Nothing here is investment, legal or tax advice. See the Risk disclosure.",
      ],
      [
        "Test network",
        "On a test network all money is play money without value and can be reset at any time.",
      ],
      [
        "No warranty",
        "The software is provided as it is, without promises that it is free of errors, available at all times, or that prices, odds or results shown are right. Contracts can have bugs. Limits in the contracts (loss ceilings, caps, pauses) reduce but do not remove risk.",
      ],
      [
        "Changes",
        "We may change these terms or the product. Using the app after a change means you accept it.",
      ],
    ],
  },
  risk: {
    title: "Risk disclosure",
    updated: "7 October 2026",
    sections: [
      [
        "You can lose everything you put in",
        "A bet that is wrong pays zero. A vault deposit can fall in value, including to zero in the worst case. Do not use money you cannot afford to lose.",
      ],
      [
        "How the vault makes and loses money",
        "The vault sells Up and Down tokens a little above its estimate of fair value. It earns that margin when prices are estimated well and loses when markets move against it faster than the margin pays. Its returns come only from this trading and a performance fee of up to 20% of gains (currently 10%). There are no token rewards.",
      ],
      [
        "Limits that reduce, not remove, loss",
        "Each round has a loss ceiling (1% of the vault) and the vault a total ceiling (8%). A fall of 5% in a day pauses new bets. A deposit cap applies at launch. The vault only accepts prices that are verified on chain from the oracle, and does not trade if they are missing.",
      ],
      [
        "Timing",
        "Deposits and withdrawals settle once per window at one price for everyone. You cannot enter or leave at an exact moment. If the price needed to settle a window is missing, the window expires and requests are refundable.",
      ],
      [
        "Technology risk",
        "Smart contracts can contain bugs, oracles can fail or be wrong, the chain can stall or reorganise, and the app can show stale or wrong numbers. A passkey can be lost; a recovery phrase can be stolen.",
      ],
      [
        "Market and operational risk",
        "Prices on exchanges can move sharply in seconds. Rounds can be cancelled and refunded if the oracle has no price. The service that settles and executes orders can be late; a late order is cancelled and refunded.",
      ],
      [
        "Regulation",
        "Prediction and derivative products are restricted in many places. It is your responsibility to check that you may use this. Access from some countries is blocked.",
      ],
    ],
  },
  privacy: {
    title: "Privacy",
    updated: "7 October 2026",
    sections: [
      [
        "What we collect",
        "No name, email or phone number. Your account is an address derived from your passkey. We count how many people reach each step (landing, account created, funded, first bet, vault deposit) with an anonymous random id kept in your browser. It contains no address, no handle and no IP address that we store.",
      ],
      [
        "What is public",
        "Everything you do on chain (your address, bets, deposits) is public on the blockchain forever. Your handle is just a name generated from your address.",
      ],
      [
        "Where data goes",
        "The app reads the chain through public RPC servers and exchange price feeds from your browser, so those services see your IP address like any website you visit. Analytics, if enabled, goes to PostHog without a person profile.",
      ],
      [
        "Cookies and storage",
        "No tracking cookies. The browser stores your account's credential id and address, and an anonymous id, in local storage on your device. Clearing your browser data removes them; your passkey and money are not affected.",
      ],
      [
        "Your choices",
        "You can sign out of a device at any time from the Account tab. You can block the analytics request in your browser; the app keeps working.",
      ],
    ],
  },
};

export function generateStaticParams() {
  return Object.keys(DOCS).map((doc) => ({ doc }));
}

export default async function Legal({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  const d = DOCS[doc];
  if (!d) notFound();
  return (
    <div className="mx-auto min-h-dvh w-full max-w-md px-5 pb-16 pt-5">
      <header className="flex items-center justify-between">
        <Link href="/" aria-label="Converge home">
          <Logo />
        </Link>
        <Link href="/markets" className="text-sm text-muted underline-offset-4 hover:underline">
          Back to the app
        </Link>
      </header>
      <main id="main">
        <h1 className="mt-6 text-2xl font-bold tracking-tight">{d.title}</h1>
        <p className="mt-1 text-xs text-faint">
          Last updated {d.updated}. A draft for review by counsel before launch.
        </p>
        <div className="mt-5 flex flex-col gap-5">
          {d.sections.map(([h, b]) => (
            <section key={h}>
              <h2 className="text-base font-semibold">{h}</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted">{b}</p>
            </section>
          ))}
        </div>
        <nav aria-label="Legal" className="mt-8 flex gap-4 text-sm text-muted">
          {Object.entries(DOCS).map(([k, v]) => (
            <Link
              key={k}
              href={`/legal/${k}`}
              className={k === doc ? "text-text underline" : "underline-offset-4 hover:underline"}
            >
              {v.title}
            </Link>
          ))}
        </nav>
      </main>
    </div>
  );
}
