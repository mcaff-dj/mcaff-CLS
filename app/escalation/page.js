import { Inter, Calistoga, JetBrains_Mono } from 'next/font/google';
import EscalationClient from './EscalationClientLoader';

// Same three fonts the standalone app's pages/_app.js loaded for this page - kept local to this
// route (not the shared root layout) since no other page in this app uses them.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
});

const calistoga = Calistoga({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-display',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
});

export const metadata = {
  title: 'Escalation — Agent Portal',
};

export default function Page() {
  return (
    <div className={`${inter.variable} ${calistoga.variable} ${jetbrainsMono.variable} ${inter.className}`}>
      <EscalationClient />
    </div>
  );
}
