import type { Metadata } from 'next';
import { Geist_Mono, Space_Grotesk } from 'next/font/google';
import './globals.css';

const appSans = Space_Grotesk({
  variable: '--font-app-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'AnimaCut',
  description: 'AI video clipping workflow for podcasts and talking-head content.',
  icons: {
    icon: '/brand/animacut-play-icon.png',
    shortcut: '/brand/animacut-play-icon.png',
    apple: '/brand/animacut-play-icon.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${appSans.variable} ${geistMono.variable} h-full antialiased dark`}>
      <body className="min-h-full flex flex-col bg-[#07070b] text-white">{children}</body>
    </html>
  );
}
