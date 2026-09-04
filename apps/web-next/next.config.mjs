/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/agentbean-push-sw.js', headers: [
      { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
      { key: 'Service-Worker-Allowed', value: '/' },
    ] }];
  },
  async redirects() {
    return [
      {
        source: '/:teamPath/computer/:id',
        destination: '/:teamPath/devices/:id',
        permanent: true,
      },
    ];
  },
};
export default nextConfig;
