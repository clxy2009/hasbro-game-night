import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const siteOrigin = process.env.SITE_ORIGIN;

export const metadata: Metadata = {
  title: 'Game Night — Find your next table',
  description:
    'Discover tabletop game events in your metro, save your seat, and meet your next play group.',
  ...(siteOrigin
    ? {
        metadataBase: new URL(siteOrigin),
        openGraph: {
          title: 'Game Night — Find your next table',
          description:
            'Discover tabletop events across local metros, save your seat, and see live availability.',
          images: [
            {
              url: '/og.png',
              width: 1728,
              height: 910,
              alt: 'Game Night community event board',
            },
          ],
        },
        twitter: {
          card: 'summary_large_image' as const,
          title: 'Game Night — Find your next table',
          description:
            'Discover local tabletop events, see live availability, and save your seat.',
          images: ['/og.png'],
        },
      }
    : {}),
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
