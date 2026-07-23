import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  allowedDevOrigins: ['192.168.1.56', '192.168.1.232', 'localhost', '127.0.0.1'],
  // Worker virtual environments and render artifacts are runtime-only. Keeping
  // them out of Next's server traces prevents Turbopack from treating a dynamic
  // media path as a request to package the entire repository on Vercel.
  outputFileTracingExcludes: {
    '/*': ['.venv/**/*', 'tmp/**/*', 'outputs/**/*', '.tools/**/*'],
  },
  outputFileTracingIncludes: {
    '/api/admin/ad-studio/render': ['./node_modules/ffmpeg-static/ffmpeg'],
  },
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
