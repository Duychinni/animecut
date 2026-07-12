import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  allowedDevOrigins: ['192.168.1.56', '192.168.1.232', 'localhost', '127.0.0.1'],
  ...(process.env.NODE_ENV === 'development'
    ? {
        turbopack: {
          root: __dirname,
        },
      }
    : {}),
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http', hostname: '**' },
    ],
  },
};

export default nextConfig;
