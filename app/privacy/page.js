export const metadata = {
  title: 'Privacy Policy — CX Unified Dashboard',
};

export default function Page() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-300">
      <div className="max-w-3xl mx-auto px-6 py-16 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Privacy Policy</h1>
          <p className="text-[13px] text-zinc-500 mt-1">Last updated: September 2026</p>
        </div>

        <p>
          This application ("CX Unified Dashboard") is an internal operations tool used by
          mCaffeine employees and authorized delivery-partner staff (e.g. courier NDR/RTO
          agents) to manage customer-support tickets, delivery escalations, call outcomes, and
          related order data. It is not a public consumer product and is not available for
          general sign-up.
        </p>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-zinc-100">What we collect</h2>
          <p>
            When you sign in with Google, we receive your name, email address, and Google
            account ID, used only to identify you within the app and enforce access permissions.
            The app also stores operational data you or your team enters or that is synced from
            order/logistics systems - order IDs, AWB/tracking numbers, call/ticket outcomes,
            remarks, and contact timestamps - strictly to run day-to-day support and delivery
            operations.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-zinc-100">How we use it</h2>
          <p>
            Data is used solely to operate this internal tool: authenticating users, gating
            access by role/team, assigning and tracking tickets, and producing operational
            reports for mCaffeine's own CX and logistics teams. We do not sell, rent, or share
            this data with third parties for advertising or marketing purposes.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-zinc-100">Storage &amp; retention</h2>
          <p>
            Data is stored in mCaffeine's own private database infrastructure and retained for
            as long as needed for business, support, and compliance purposes. Access is
            restricted to authorized personnel via Google sign-in and per-account permissions.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-zinc-100">Your choices</h2>
          <p>
            Access to this app is granted per employee/partner account by mCaffeine. If your
            access should be removed, or you have a question about data associated with your
            account, contact us using the details below.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-zinc-100">Contact</h2>
          <p>
            Questions about this policy or your data: <a className="text-indigo-400 underline" href="mailto:vikash@mcaffeine.com">vikash@mcaffeine.com</a>
          </p>
        </section>
      </div>
    </main>
  );
}
