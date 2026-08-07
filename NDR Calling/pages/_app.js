import { Inter, Calistoga, JetBrains_Mono } from 'next/font/google';
import '../styles/globals.css';

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

export default function App({ Component, pageProps }) {
  return (
    <div className={`${inter.variable} ${calistoga.variable} ${jetbrainsMono.variable} ${inter.className}`}>
      <Component {...pageProps} />
    </div>
  );
}
