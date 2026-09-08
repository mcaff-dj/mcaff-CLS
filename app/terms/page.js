export const metadata = {
  title: 'Terms of Service — CX Unified Dashboard',
};

export default function Page() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-300">
      <div className="max-w-3xl mx-auto px-6 py-16 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Terms of Service</h1>
          <p className="text-[13px] text-zinc-500 mt-1">Last updated: September 2026</p>
        </div>

        <p>
          This application ("CX Unified Dashboard") is an internal operations tool provided by
          mCaffeine for use by its employees and authorized delivery-partner staff to manage
          customer-support tickets, delivery escalations, and related order data. By signing in,
          you agree to these terms.
        </p>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-zinc-100">Authorized use only</h2>
          <p>
            Access is granted per account by mCaffeine and is not open to the public. You may
            use the app only for legitimate work purposes related to your role - handling
            support tickets, calls, and delivery escalations assigned to you or your team.
            Sharing your login, attempting to access data outside your assigned scope, or using
            the app for anything unrelated to authorized business purposes is not permitted.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-zinc-100">Data accuracy</h2>
          <p>
            You're responsible for the accuracy of information you enter (call outcomes,
            remarks, tracking numbers, etc.). This data may be used for operational reporting and
            decisions, so it should reflect what actually happened.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-zinc-100">No warranty</h2>
          <p>
            This tool is provided as-is for internal use. mCaffeine makes no warranty that it
            will be uninterrupted or error-free, and is not liable for business decisions made
            based on its data or availability.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-zinc-100">Access can be revoked</h2>
          <p>
            mCaffeine may suspend or revoke access at any time, including when your role changes,
            your employment or partnership ends, or these terms are not followed.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-zinc-100">Contact</h2>
          <p>
            Questions about these terms: <a className="text-indigo-400 underline" href="mailto:vikash@mcaffeine.com">vikash@mcaffeine.com</a>
          </p>
        </section>
      </div>
    </main>
  );
}
