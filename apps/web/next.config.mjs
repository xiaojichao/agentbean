/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
