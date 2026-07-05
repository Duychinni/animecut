import type { Metadata } from 'next';
import { Cormorant_Garamond, Geist_Mono, Space_Grotesk } from 'next/font/google';
import './globals.css';

const appSans = Space_Grotesk({
  variable: '--font-app-sans',
  subsets: ['latin'],
});

const heroDisplay = Cormorant_Garamond({
  variable: '--font-hero-display',
  subsets: ['latin'],
  weight: ['500', '600', '700'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'ClipSpark',
  description: 'AI clipping workflow for podcasts and talking-head content.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${appSans.variable} ${heroDisplay.variable} ${geistMono.variable} h-full antialiased dark`}>
      <body className="min-h-full flex flex-col bg-[#07070b] text-white">{children}</body>
    </html>
  );
}
