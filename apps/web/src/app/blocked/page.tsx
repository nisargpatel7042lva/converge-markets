import { Logo } from "@/components/shell";

export const metadata = { title: "Not available in your region" };

export default function Blocked() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 py-10">
      <Logo className="text-lg" />
      <main id="main" className="flex flex-1 flex-col justify-center gap-4">
        <h1 className="text-3xl font-bold tracking-tight">
          Converge isn&apos;t available in your region
        </h1>
        <p className="text-base leading-relaxed text-muted">
          Prediction and trading products are restricted or prohibited in some countries, and we
          have to follow those rules. We detected that your connection comes from a region where we
          can&apos;t offer Converge, so the app is closed to you.
        </p>
        <p className="text-sm leading-relaxed text-muted">
          If you think this is a mistake (for example you are on a corporate network or travelling),
          try again from your usual connection. Using a VPN to get around this block is against our
          terms.
        </p>
        <p className="text-xs text-faint">
          Your funds are never held by us: if you already have an account, your money stays in your
          own wallet and the contracts keep working.
        </p>
      </main>
    </div>
  );
}
