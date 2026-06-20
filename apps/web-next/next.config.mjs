/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: '/:networkPath/computer/:id',
        destination: '/:networkPath/devices/:id',
        permanent: true,
      },
    ];
  },
};
export default nextConfig;
